# Witness-Adoption Migration — Design

**Status:** Approved (pending user review of this spec)
**Date:** 2026-05-18
**Owner:** ben@tairea.io

## Problem

The multisig member-to-admin upgrade flow requires the org's group AID to have witnesses (≥1) in its inception event — without them, the new member's KERIA can't pull the org's KEL during round 1, and `addMemberRound1` aborts at its witness guard. Org AIDs created before commit `b58895e` (Task 3 of the multisig plan) were incepted with `toad: 0, wits: []`. The test environment currently has one such org:

| Field | Value |
|---|---|
| Org AID | `EF6dPj2iIsW5WmHm9kKBzDl17qTXlZMs1e_aYicsJZBr` |
| `bt` | `0` |
| `b` | `[]` |
| `s` | `0` |

This blocks both the freshly restructured E2E (`e2e-registration.spec.ts:695`) and any prod org in the same shape.

The plan's "Backward-compat note" deferred this case to a follow-up. This spec is that follow-up: a one-rotation migration that adopts witnesses into the existing org without re-creation.

## Goal

A founding admin sees a "Adopt witnesses" banner on their dashboard whenever their org has zero witnesses, clicks once, and the org transitions to a state functionally equivalent to one created by the current build:

- `b` contains the org-subset of witnesses returned by `assignWitnesses()`
- `bt` matches that subset's threshold (1 or 2 depending on pool size)
- `s` increments to 1
- Subsequent `addMemberRound1` / `addMemberRound2` calls succeed

The migration is idempotent: running it on an already-witnessed org is a no-op.

## Non-goals

- Migrating admin's personal AID. Their KEL is served by their KERIA agent and works fine even with the stale hardcoded witness (`BBilc4-L3tFUnf…`). The disjoint-witness invariant only matters at *inception* — once incepted, admin's AID can sit on whatever witnesses it has.
- Automatic / silent migration on login. Banner-with-button is explicit and reviewable; an admin sees what's happening and chooses when to commit.
- Migrating witness sets of org AIDs that already have witnesses but want a *different* subset. Out of scope; the trigger is `b.length === 0` only.
- Cross-org migrations from a single admin context. Each org's admin runs their own migration once.

## Architecture

### Sequence

```mermaid
sequenceDiagram
    actor AU as Admin user
    participant DASH as Dashboard
    participant AK as Admin KERIA
    participant OW as New org witnesses

    Note over AU,OW: Banner only renders when b: [] for current org
    AU->>DASH: Log in
    DASH->>AK: keyStates().query(orgPrefix)
    AK-->>DASH: state { b: [], s: '0' }
    DASH->>AU: Banner: "Adopt witnesses [Adopt]"

    AU->>DASH: Click Adopt
    DASH->>DASH: assignWitnesses() → { org, toad }
    DASH->>AK: identifiers().rotate(orgName, { adds: org, toad, states, rstates })
    AK->>OW: rot event (s=1) + receipts
    OW-->>AK: receipts received
    AK-->>DASH: rotation complete
    DASH->>AK: keyStates().query(orgPrefix) — verify
    AK-->>DASH: state { b: [W2, W3], s: '1' }
    DASH->>AU: Banner hides; toast "Org ready for member promotions"
```

### Components

| File | Responsibility |
|---|---|
| `frontend/src/lib/keri/client.ts` | New public method `adoptOrgWitnesses(orgName, masterAidName): Promise<'migrated' \| 'already-migrated'>`. Pure migration logic. Returns the status; throws on failure. |
| `frontend/src/composables/useOrgWitnessState.ts` (new) | Reactive composable that queries `keyStates().query(orgPrefix)` once on dashboard mount + after migration. Exposes `hasWitnesses: Ref<boolean \| undefined>` and `refresh()`. |
| `frontend/src/composables/useAdminActions.ts` | New `runAdoptWitnesses()` orchestrator: progress strings, success/failure toasts, calls `useOrgWitnessState.refresh()` on success. |
| `frontend/src/components/dashboard/WitnessAdoptionBanner.vue` (new) | Stateless banner: receives `visible`, emits `@adopt`. Lives in the dashboard layout. |
| `frontend/src/pages/DashboardPage.vue` | Mounts the banner; binds visibility to `isSteward && hasWitnesses === false`; wires the adopt action. |
| `frontend/tests/e2e/e2e-registration.spec.ts` | After admin login in path B of `beforeAll`, if the banner is visible, click it and wait for it to disappear. Idempotent. |

### `adoptOrgWitnesses` body

```ts
async adoptOrgWitnesses(
  orgName: string,
  masterAidName: string,
): Promise<'migrated' | 'already-migrated'> {
  if (!this.client) throw new Error('Not initialized');
  await this.ensureConnected();

  const orgBefore = await this.client.identifiers().get(orgName);
  const witsBefore = (orgBefore.state as { b?: string[] })?.b ?? [];
  if (witsBefore.length > 0) {
    console.log(`[KERIClient] adoptOrgWitnesses: ${orgName} already has ${witsBefore.length} witnesses — no-op`);
    return 'already-migrated';
  }

  const { assignWitnesses } = await import('./witnessAssignment');
  const { org: targetWits, toad } = await assignWitnesses();
  console.log(
    `[KERIClient] adoptOrgWitnesses: rotating ${orgName} to adopt ${targetWits.length} witnesses (toad=${toad})`,
  );

  // Refresh master state — same pattern as addMemberRound1/2.
  const masterAid = await this.client.identifiers().get(masterAidName);
  const masterQ = await this.client.keyStates().query(masterAid.prefix, undefined, undefined);
  const masterRes = await this.client.operations().wait(masterQ, { signal: AbortSignal.timeout(30000) });
  const masterState = masterRes.response as Record<string, unknown>;

  const rot = await this.client.identifiers().rotate(orgName, {
    states: [masterState],
    rstates: [masterState],
    adds: targetWits,
    toad,
  });
  const rotOp = await rot.op();
  if (!rotOp?.done) {
    let done = false;
    for (let i = 0; i < 10; i++) {
      await new Promise(r => setTimeout(r, 3000));
      const s = await this.client.operations().get(rotOp.name);
      if (s?.done) { done = true; break; }
    }
    if (!done) {
      console.warn('[KERIClient] adoptOrgWitnesses: rotation op not done after 30s — verifying state anyway');
    }
  }

  // Verify by re-querying — fail loudly if witnesses didn't actually land.
  const orgAfter = await this.client.identifiers().get(orgName);
  const witsAfter = (orgAfter.state as { b?: string[] })?.b ?? [];
  if (witsAfter.length !== targetWits.length) {
    throw new Error(
      `adoptOrgWitnesses: expected ${targetWits.length} witnesses after rotation, got ${witsAfter.length}. ` +
      `Org may be in an inconsistent state — check KERIA logs.`,
    );
  }

  console.log(`[KERIClient] adoptOrgWitnesses: complete, b=${JSON.stringify(witsAfter)}`);
  return 'migrated';
}
```

### Why `adds` not `wits`

signify-ts's group `identifiers().rotate(name, opts)` distinguishes:
- `wits` — replace the full witness set
- `adds` — append witnesses to the current set
- `cuts` — remove witnesses from the current set

For an org with `b: []`, `adds: [...]` and `wits: [...]` behave identically. We use `adds` because it expresses intent more precisely (we're adopting witnesses, not redefining a non-existent set), and future migrations that swap one subset for another would use `adds` + `cuts` together.

### Why the rotation only advances `s` to 1

A standard `rot` event with no key changes (`states` unchanged, `rstates` unchanged) is what KERI calls a "witness-only rotation." It commits a new sequence number, attaches the witness changes (`ba`/`br`), and reuses the prior signing keys. This is exactly what we want: bump the KEL by one event, change witness state, leave keys alone.

After the migration, the org's KEL is at `s: 1`. The subsequent `addMemberRound1` will rotate to `s: 2`, and `addMemberRound2` to `s: 3` — fully compatible with the multisig add flow.

### `useOrgWitnessState` composable

```ts
import { ref, computed, type ComputedRef } from 'vue';
import { useKERIClient } from 'src/lib/keri/client';
import { getOrFetchOrgConfig } from 'src/api/config';

export function useOrgWitnessState() {
  const witnessCount = ref<number | undefined>(undefined);

  async function refresh() {
    const config = await getOrFetchOrgConfig();
    if (!config?.organization?.aid) {
      witnessCount.value = undefined;
      return;
    }
    const keri = useKERIClient();
    const client = keri.getSignifyClient();
    if (!client) return;
    try {
      const op = await client.keyStates().query(config.organization.aid, undefined, undefined);
      const res = await client.operations().wait(op, { signal: AbortSignal.timeout(15_000) });
      const state = res.response as { b?: string[] } | undefined;
      witnessCount.value = state?.b?.length ?? 0;
    } catch (err) {
      console.warn('[useOrgWitnessState] query failed:', err);
      witnessCount.value = undefined;
    }
  }

  const hasWitnesses: ComputedRef<boolean | undefined> = computed(() => {
    if (witnessCount.value === undefined) return undefined;
    return witnessCount.value > 0;
  });

  return { hasWitnesses, witnessCount, refresh };
}
```

Three states for `hasWitnesses`: `undefined` (not yet queried — banner hidden, no flash), `false` (banner shown), `true` (banner hidden).

### Banner UX

Plain Vue component, no Quasar dependency. Lives in `DashboardPage.vue`'s template, above the members list:

```html
<WitnessAdoptionBanner
  v-if="isSteward && orgWitnesses.hasWitnesses.value === false"
  :loading="isAdopting"
  @adopt="adoptWitnesses"
/>
```

Banner content:

> ⚠ This org was created before witness-backed upgrades were supported.
> Adopt witnesses to enable promoting members to steward.
> [Adopt witnesses]

Disabled with spinner while running; shows error inline if the migration throws.

## Error handling

| Failure mode | Surface |
|---|---|
| `assignWitnesses()` throws (pool < 2) | Banner error: "Witness pool unavailable — check config server" |
| Rotation rejected by KERIA | Banner error: full error message; banner stays visible for retry |
| Op timeout (30s) but witnesses present after re-query | Treat as success — KERIA may have completed the op without flipping the `done` flag in time |
| Op timeout AND witnesses still absent | Throw; banner shows error; admin retries (next rotation attempts `s: 2`, which KERIA will accept) |
| Retry after a failed rotation | The state machine inside `identifiers().rotate(orgName, ...)` will try to advance from the current `s`, not re-use a stale `s+1`. Multiple retries are safe |

## Testing

### Unit tests

No new unit tests. The method makes real KERIA calls; meaningful coverage requires E2E.

### E2E coverage

Modify `e2e-registration.spec.ts:beforeAll` (path B branch, after admin login):

```ts
// Migrate org witnesses if needed (idempotent — no-op for fresh orgs)
const banner = adminPage.locator('[data-test="witness-adoption-banner"]');
const isVisible = await banner.isVisible().catch(() => false);
if (isVisible) {
  console.log('[Test] Adopting witnesses on pre-existing org…');
  await banner.getByRole('button', { name: /adopt witnesses/i }).click();
  await expect(banner).not.toBeVisible({ timeout: 60_000 });
  console.log('[Test] Org witnesses adopted');
}
```

Add a `data-test="witness-adoption-banner"` attribute on the banner's root element for stable selection.

This makes the E2E:
- Pass for a freshly-cleaned test env (banner absent → branch skipped).
- Pass for the current pre-existing org (banner present → migration runs once → subsequent tests proceed).
- Pass for a re-run on the same env (banner already gone → branch skipped).

### Manual verification

```bash
# Before migration
curl -s http://localhost:4902/oobi/EF6dPj... | head -c 300
# Expect: "b":[]

# After clicking the banner
curl -s http://localhost:4902/oobi/EF6dPj... | head -c 600
# Expect: original icp at s:0 with b:[], plus a rot at s:1 with ba:[W2,W3], b:[W2,W3]
```

## Open questions resolved

1. **Should it run automatically on login?** No — explicit user action. Silent rotations are a long-term debugging hazard.
2. **What if the admin's KERIA session expired mid-rotation?** `ensureConnected()` is called at method entry; signify-ts session refresh handles re-auth. If the rotation truly fails, the banner stays and the admin retries.
3. **What if two admins both click adopt at once?** Out of scope — current orgs have exactly one founding admin. Future multisig orgs already have witnesses (this migration's whole purpose).
4. **What about orgs that were created with witnesses but want a different subset?** Out of scope. The banner only renders when `b: []`. Different-subset migrations are a separate, larger problem.

## Acceptance criteria

- [ ] A pre-existing test org (`bt: 0, b: []`) gets migrated by clicking the banner.
- [ ] Migration is idempotent: clicking again (or re-rendering after success) is a no-op.
- [ ] Banner only appears for steward / admin role on an org with `b: []`.
- [ ] After migration, `addMemberRound1` no longer throws the "Group ... was created without witnesses" error.
- [ ] `addMemberRound1`'s error message is updated from "Re-create the org with the current build" to "Click the 'Adopt witnesses' banner on the admin dashboard, or re-create the org" so admins hitting the guard get a concrete next step.
- [ ] E2E `e2e-registration.spec.ts` passes on the current test env (with migration auto-run in beforeAll).
- [ ] No regression on freshly-created orgs — `assignWitnesses` still produces disjoint sets at `createGroupAID` time.

## References

- `docs/plans/2026-05-18-multisig-upgrade-implementation-plan.md` — the parent multisig plan that introduced the witness requirement.
- `frontend/src/lib/keri/witnessAssignment.ts` — `assignWitnesses()` helper (Task 1 of the parent plan).
- `frontend/src/lib/keri/client.ts:957` — `addMemberRound1`'s witness guard (the error this migration enables admins to avoid).
- KERI whitepaper §6.4 "Witness-only rotations" — the protocol primitive this migration relies on.
