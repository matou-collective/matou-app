# Witness-Adoption Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a founding admin migrate an org incepted with `toad: 0, wits: []` into a witness-backed org via a single one-click rotation, so the multisig member-promotion flow can run on pre-existing orgs.

**Architecture:** A new `KERIClient.adoptOrgWitnesses(orgName, masterAidName)` performs a witness-only KERI rotation (no key change) on the existing group AID using `assignWitnesses().org` and `.toad`. A reactive `useOrgWitnessState` composable polls the org's KEL once on dashboard mount + after migration. A `WitnessAdoptionBanner.vue` renders only when `isSteward && hasWitnesses === false`, calls a thin `runAdoptWitnesses` orchestrator in `useAdminActions`, and disappears on success.

**Tech Stack:** signify-ts 0.3.x (`identifiers().rotate()` with `adds`/`toad`/`states`/`rstates`), Vue 3 composables, Quasar dashboard layout, Playwright E2E.

**Reference docs:**
- `docs/plans/2026-05-18-witness-adoption-migration-design.md` — approved design spec
- `docs/plans/2026-05-18-multisig-upgrade-implementation-plan.md` — parent multisig plan
- `frontend/src/lib/keri/witnessAssignment.ts` — `assignWitnesses()` helper

---

## File Structure

### New files

| File | Responsibility |
|---|---|
| `frontend/src/composables/useOrgWitnessState.ts` | Reactive composable: `witnessCount: Ref<number \| undefined>`, `hasWitnesses: ComputedRef<boolean \| undefined>`, `refresh(): Promise<void>`. Three-state semantics: `undefined` (not queried), `false` (no witnesses), `true` (has witnesses). |
| `frontend/src/components/dashboard/WitnessAdoptionBanner.vue` | Stateless presentational banner: props `loading: boolean`, emits `@adopt`. Root element carries `data-test="witness-adoption-banner"`. Renders text + button + inline spinner + inline error slot. |

### Modified files

| File | Change |
|---|---|
| `frontend/src/lib/keri/client.ts` | Add `adoptOrgWitnesses(orgName, masterAidName)` method between `createGroupAID` and `rotatePersonalAid`. Update `addMemberRound1`'s witness-guard error message. |
| `frontend/src/composables/useAdminActions.ts` | Add `runAdoptWitnesses()` orchestrator with progress + error state. Export from the composable's return object. |
| `frontend/src/pages/DashboardPage.vue` | Mount `<WitnessAdoptionBanner>` above members list, bind to `isSteward && orgWitnesses.hasWitnesses === false`. Call `orgWitnesses.refresh()` in `onMounted` after `checkAdminStatus`. |
| `frontend/tests/e2e/e2e-registration.spec.ts` | After admin login in `beforeAll` path B, click the banner if visible. Idempotent for fresh orgs. |

---

## Task 1: `useOrgWitnessState` composable

**Files:**
- Create: `frontend/src/composables/useOrgWitnessState.ts`

- [ ] **Step 1: Write the composable**

Create `frontend/src/composables/useOrgWitnessState.ts`:

```ts
import { ref, computed, type ComputedRef, type Ref } from 'vue';
import { useKERIClient } from 'src/lib/keri/client';
import { getOrFetchOrgConfig } from 'src/api/config';

/**
 * Reactive state for the current org's witness configuration.
 *
 * Three states for `hasWitnesses`:
 *   undefined — not yet queried (banner hidden, no flash)
 *   false     — org has b: [] (banner shown to stewards)
 *   true      — org has witnesses (banner hidden)
 *
 * Call `refresh()` on dashboard mount and after running the migration to
 * re-evaluate.
 */
export function useOrgWitnessState(): {
  witnessCount: Ref<number | undefined>;
  hasWitnesses: ComputedRef<boolean | undefined>;
  refresh: () => Promise<void>;
} {
  const witnessCount = ref<number | undefined>(undefined);

  async function refresh(): Promise<void> {
    const config = await getOrFetchOrgConfig();
    if (!config?.organization?.aid) {
      witnessCount.value = undefined;
      return;
    }
    const keri = useKERIClient();
    const client = keri.getSignifyClient();
    if (!client) {
      witnessCount.value = undefined;
      return;
    }
    try {
      const op = await client.keyStates().query(config.organization.aid, undefined, undefined);
      const res = await client.operations().wait(op, { signal: AbortSignal.timeout(15_000) });
      const state = res.response as { b?: string[] } | undefined;
      witnessCount.value = state?.b?.length ?? 0;
      console.log(`[useOrgWitnessState] org ${config.organization.aid.slice(0, 12)}... has ${witnessCount.value} witnesses`);
    } catch (err) {
      console.warn('[useOrgWitnessState] keyStates().query failed:', err);
      witnessCount.value = undefined;
    }
  }

  const hasWitnesses = computed<boolean | undefined>(() => {
    if (witnessCount.value === undefined) return undefined;
    return witnessCount.value > 0;
  });

  return { witnessCount, hasWitnesses, refresh };
}
```

- [ ] **Step 2: Verify imports resolve**

```bash
cd frontend && npx vue-tsc --noEmit 2>&1 | grep useOrgWitnessState | head -10
```

Expected: zero errors.

- [ ] **Step 3: Commit**

```bash
git add frontend/src/composables/useOrgWitnessState.ts
git commit -m "feat(witness-adoption): useOrgWitnessState composable"
```

---

## Task 2: `adoptOrgWitnesses` method on `KERIClient`

**Files:**
- Modify: `frontend/src/lib/keri/client.ts`

- [ ] **Step 1: Locate the insertion point**

```bash
grep -n "async createGroupAID\|async rotatePersonalAid" frontend/src/lib/keri/client.ts
```

Place `adoptOrgWitnesses` between `createGroupAID`'s closing `}` and `rotatePersonalAid`'s JSDoc. (Both are org-AID-lifecycle methods; the migration belongs with them.)

- [ ] **Step 2: Add the method**

```ts
  /**
   * Adopt witnesses on a pre-existing group AID that was created with
   * `toad: 0, wits: []` (pre-multisig-fix build). Executes a single
   * witness-only KERI rotation (no key changes) that adds the org-subset
   * of witnesses returned by `assignWitnesses()`.
   *
   * Idempotent: if the org already has any witnesses, returns
   * `'already-migrated'` without sending a rotation.
   *
   * @param orgName - Local alias of the group AID
   * @param masterAidName - Local alias of the admin's personal AID (sole signer)
   * @returns `'migrated'` on success, `'already-migrated'` if the org already has witnesses
   * @throws if the rotation completes but witnesses are not visible after re-query
   */
  async adoptOrgWitnesses(
    orgName: string,
    masterAidName: string,
  ): Promise<'migrated' | 'already-migrated'> {
    if (!this.client) throw new Error('Not initialized');
    await this.ensureConnected();

    const orgBefore = await this.client.identifiers().get(orgName);
    const witsBefore = (orgBefore.state as { b?: string[] })?.b ?? [];
    if (witsBefore.length > 0) {
      console.log(
        `[KERIClient] adoptOrgWitnesses: ${orgName} already has ${witsBefore.length} witnesses — no-op`,
      );
      return 'already-migrated';
    }

    const { assignWitnesses } = await import('./witnessAssignment');
    const { org: targetWits, toad } = await assignWitnesses();
    console.log(
      `[KERIClient] adoptOrgWitnesses: rotating ${orgName} to adopt ${targetWits.length} witnesses (toad=${toad})`,
    );

    // Refresh master state — same pattern as addMemberRound1/Round2.
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

- [ ] **Step 3: Type-check**

```bash
cd frontend && npx vue-tsc --noEmit 2>&1 | grep client.ts | head -10
```

Expected: zero errors.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/lib/keri/client.ts
git commit -m "feat(witness-adoption): adoptOrgWitnesses method on KERIClient"
```

---

## Task 3: `runAdoptWitnesses` orchestrator in `useAdminActions`

**Files:**
- Modify: `frontend/src/composables/useAdminActions.ts`

- [ ] **Step 1: Locate the insertion point**

Add the orchestrator near the other admin actions. A good spot is right after `upgradeMemberToSteward` (which lives around line 460–470 in the file). Use:

```bash
grep -n "function upgradeMemberToSteward\|function addStewardToOrgMultisig\|function declineRegistration" frontend/src/composables/useAdminActions.ts | head -5
```

- [ ] **Step 2: Add the orchestrator function**

Insert after `upgradeMemberToSteward`'s closing brace (before the `@deprecated addStewardToOrgMultisig` shim):

```ts
  /**
   * Adopt witnesses on the current org's group AID. Used to migrate orgs
   * created before the witness-fix landed (`toad: 0, wits: []`) into a
   * witness-backed shape so the multisig member-promotion flow can run.
   *
   * Idempotent: a no-op for orgs that already have witnesses.
   */
  async function runAdoptWitnesses(
    onStep?: (step: string) => void,
  ): Promise<'migrated' | 'already-migrated' | 'failed'> {
    const client = keriClient.getSignifyClient();
    if (!client) {
      console.error('[AdminActions] No SignifyClient for adopt-witnesses');
      return 'failed';
    }
    if (isProcessing.value) {
      console.warn('[AdminActions] Already processing — refusing concurrent adopt-witnesses');
      return 'failed';
    }
    isProcessing.value = true;
    processingStep.value = 'Adopting witnesses...';
    onStep?.('Adopting witnesses...');
    error.value = null;

    try {
      const aids = await client.identifiers().list();
      const personalAid = aids.aids?.find((a: { prefix: string; name: string }) =>
        !a.name?.toLowerCase().includes('matou') && !a.name?.toLowerCase().includes('org')
      );
      if (!personalAid) throw new Error('Could not find admin personal AID');

      const orgAidPrefix = await getOrgAidName();
      const orgAid = aids.aids?.find((a: { prefix: string }) => a.prefix === orgAidPrefix);
      const orgName = orgAid?.name;
      if (!orgName) throw new Error('Could not find org AID name');

      const result = await keriClient.adoptOrgWitnesses(orgName, personalAid.name);
      onStep?.('Complete');
      console.log(`[AdminActions] adopt-witnesses result: ${result}`);
      return result;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error('[AdminActions] Adopt witnesses failed:', err);
      error.value = msg;
      return 'failed';
    } finally {
      isProcessing.value = false;
      processingStep.value = '';
    }
  }
```

- [ ] **Step 3: Export it from the composable's return object**

Locate the `return { ... }` at the bottom of `useAdminActions()`. Add `runAdoptWitnesses` to the export list:

```bash
grep -n "return {" frontend/src/composables/useAdminActions.ts | tail -3
```

In the returned object, add the line:

```ts
    runAdoptWitnesses,
```

(Place it adjacent to `upgradeMemberToSteward`.)

- [ ] **Step 4: Verify `getOrgAidName` is in scope**

```bash
grep -n "getOrgAidName\|function getOrgAidName\|const getOrgAidName" frontend/src/composables/useAdminActions.ts | head -3
```

Expected: at least one definition or import line. The function is already used by `upgradeMemberToSteward` (line ~388), so it's in scope.

- [ ] **Step 5: Type-check**

```bash
cd frontend && npx vue-tsc --noEmit 2>&1 | grep useAdminActions | head -10
```

Expected: zero errors.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/composables/useAdminActions.ts
git commit -m "feat(witness-adoption): runAdoptWitnesses orchestrator"
```

---

## Task 4: `WitnessAdoptionBanner.vue` component

**Files:**
- Create: `frontend/src/components/dashboard/WitnessAdoptionBanner.vue`

- [ ] **Step 1: Inspect a sibling banner for stylistic precedent**

```bash
ls frontend/src/components/dashboard/ | head -10
```

If a similar warning banner already exists (e.g. an update prompt or onboarding banner), match its class structure. If not, use the plain styled-div pattern below.

- [ ] **Step 2: Create the component**

```vue
<template>
  <div data-test="witness-adoption-banner" class="witness-adoption-banner">
    <div class="banner-content">
      <span class="banner-icon" aria-hidden="true">⚠</span>
      <div class="banner-text">
        <strong>Org needs witness migration</strong>
        <p>
          This org was created before witness-backed upgrades were supported.
          Adopt witnesses to enable promoting members to steward.
        </p>
        <p v-if="errorMessage" class="banner-error">{{ errorMessage }}</p>
      </div>
      <button
        type="button"
        class="banner-button"
        :disabled="loading"
        @click="$emit('adopt')"
      >
        <span v-if="loading">Adopting…</span>
        <span v-else>Adopt witnesses</span>
      </button>
    </div>
  </div>
</template>

<script setup lang="ts">
defineProps<{
  loading: boolean;
  errorMessage?: string;
}>();
defineEmits<{
  (e: 'adopt'): void;
}>();
</script>

<style scoped>
.witness-adoption-banner {
  background: #fff5e6;
  border: 1px solid #f4b860;
  border-radius: 8px;
  padding: 12px 16px;
  margin: 12px 0;
  color: #5a3a00;
}
.dark .witness-adoption-banner {
  background: #3a2a10;
  border-color: #f4b860;
  color: #ffd9a5;
}
.banner-content {
  display: flex;
  gap: 12px;
  align-items: flex-start;
}
.banner-icon {
  font-size: 1.4em;
  line-height: 1;
}
.banner-text {
  flex: 1;
}
.banner-text strong {
  display: block;
  margin-bottom: 4px;
}
.banner-text p {
  margin: 0;
  font-size: 0.92em;
  line-height: 1.4;
}
.banner-error {
  color: #b00020;
  margin-top: 6px !important;
}
.banner-button {
  background: #5a3a00;
  color: #fff;
  border: none;
  padding: 8px 14px;
  border-radius: 6px;
  cursor: pointer;
  font-size: 0.9em;
  align-self: center;
  white-space: nowrap;
}
.banner-button:disabled {
  opacity: 0.6;
  cursor: progress;
}
.dark .banner-button {
  background: #f4b860;
  color: #2a1a00;
}
</style>
```

- [ ] **Step 3: Type-check**

```bash
cd frontend && npx vue-tsc --noEmit 2>&1 | grep WitnessAdoption | head -5
```

Expected: zero errors.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/components/dashboard/WitnessAdoptionBanner.vue
git commit -m "feat(witness-adoption): WitnessAdoptionBanner component"
```

---

## Task 5: Wire the banner into `DashboardPage.vue`

**Files:**
- Modify: `frontend/src/pages/DashboardPage.vue`

- [ ] **Step 1: Add the imports + composable wiring**

Find the existing block of imports near the top of `<script setup>` (around line 234 — `import { useAdminAccess } from 'src/composables/useAdminAccess';`). Add these imports below it:

```ts
import { useOrgWitnessState } from 'src/composables/useOrgWitnessState';
import WitnessAdoptionBanner from 'src/components/dashboard/WitnessAdoptionBanner.vue';
```

Find the `useAdminAccess` hook call (around line 250). After it, add:

```ts
const { hasWitnesses: orgHasWitnesses, refresh: refreshOrgWitnesses } = useOrgWitnessState();
const isAdoptingWitnesses = ref(false);
const adoptError = ref<string | null>(null);
```

Destructuring here so `orgHasWitnesses` is a top-level ref in the script-setup scope — Vue's template auto-unwraps top-level refs but NOT nested object members.

And destructure `runAdoptWitnesses` from `useAdminActions` (look for where `useAdminActions()` is called — likely just below `useAdminAccess`). The destructure must include `runAdoptWitnesses`:

```bash
grep -n "useAdminActions" frontend/src/pages/DashboardPage.vue | head -5
```

Add `runAdoptWitnesses` to the destructure list at that call site.

- [ ] **Step 2: Add the adopt action handler**

Below the new refs, add:

```ts
async function adoptWitnesses() {
  isAdoptingWitnesses.value = true;
  adoptError.value = null;
  try {
    const result = await runAdoptWitnesses();
    if (result === 'failed') {
      adoptError.value = 'Witness adoption failed. See console for details.';
      return;
    }
    await refreshOrgWitnesses();
  } catch (err) {
    adoptError.value = err instanceof Error ? err.message : String(err);
  } finally {
    isAdoptingWitnesses.value = false;
  }
}
```

- [ ] **Step 3: Hook the refresh into `onMounted`**

Find the existing `onMounted(async () => { ... })` block (around line 476). Right after `await checkAdminStatus();` (around line 483), add:

```ts
  // Query the org's witness state for the migration banner
  await refreshOrgWitnesses();
```

- [ ] **Step 4: Mount the banner in the template**

Find the template's members-card region (around line 127, `<div ref="membersCardRef" class="card members-card">`). Insert the banner immediately ABOVE that div, so it appears between the dashboard header and the members card:

```html
<WitnessAdoptionBanner
  v-if="isSteward && orgHasWitnesses === false"
  :loading="isAdoptingWitnesses"
  :error-message="adoptError ?? undefined"
  @adopt="adoptWitnesses"
/>
```

- [ ] **Step 5: Type-check + lint**

```bash
cd frontend && npx vue-tsc --noEmit 2>&1 | grep DashboardPage | head -10
```

Expected: zero errors.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/pages/DashboardPage.vue
git commit -m "feat(witness-adoption): wire banner + adopt action into dashboard"
```

---

## Task 6: Update `addMemberRound1`'s error message

**Files:**
- Modify: `frontend/src/lib/keri/client.ts:974`

- [ ] **Step 1: Locate the error**

```bash
grep -n "cannot be upgraded" frontend/src/lib/keri/client.ts
```

Expected: one match at the witness guard inside `addMemberRound1`.

- [ ] **Step 2: Replace the error message**

Find:

```ts
      throw new Error(
        `Group "${groupName}" was created without witnesses (toad=0) and cannot be upgraded. ` +
        `Re-create the org with the current build to enable member promotions.`,
      );
```

Replace with:

```ts
      throw new Error(
        `Group "${groupName}" was created without witnesses (toad=0) and cannot be upgraded. ` +
        `Click the "Adopt witnesses" banner on the admin dashboard, or re-create the org.`,
      );
```

- [ ] **Step 3: Verify**

```bash
grep -n "Adopt witnesses" frontend/src/lib/keri/client.ts
```

Expected: one match.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/lib/keri/client.ts
git commit -m "fix(keri): point witnessless-org error at the banner workflow"
```

---

## Task 7: E2E hook in `e2e-registration.spec.ts`

**Files:**
- Modify: `frontend/tests/e2e/e2e-registration.spec.ts`

- [ ] **Step 1: Locate the `beforeAll` path B block**

```bash
grep -n "Path B\|loginWithMnemonic" frontend/tests/e2e/e2e-registration.spec.ts | head -5
```

The path B branch is where admin recovers identity from saved mnemonic (around line 158–171). The hook needs to run *after* admin reaches the dashboard but *before* any test starts spawning user backends.

- [ ] **Step 2: Insert the migration check after `loginWithMnemonic`**

Find:

```ts
      await loginWithMnemonic(adminPage, accounts.admin.mnemonic);
      console.log('[Test] Admin logged in and on dashboard');
    }
  });
```

Replace with:

```ts
      await loginWithMnemonic(adminPage, accounts.admin.mnemonic);
      console.log('[Test] Admin logged in and on dashboard');
    }

    // Migrate pre-existing orgs that were created without witnesses
    // (idempotent — no-op when the banner isn't rendered).
    const banner = adminPage.locator('[data-test="witness-adoption-banner"]');
    const bannerVisible = await banner.isVisible().catch(() => false);
    if (bannerVisible) {
      console.log('[Test] Pre-existing org has no witnesses — adopting via banner...');
      await banner.getByRole('button', { name: /adopt witnesses/i }).click();
      await expect(banner).not.toBeVisible({ timeout: 90_000 });
      console.log('[Test] Org witnesses adopted');
    }
  });
```

- [ ] **Step 3: Type-check**

```bash
cd frontend && npx vue-tsc --noEmit 2>&1 | grep e2e-registration | head -5
```

Expected: zero errors.

- [ ] **Step 4: Commit**

```bash
git add frontend/tests/e2e/e2e-registration.spec.ts
git commit -m "test(e2e): auto-migrate witnessless orgs in beforeAll"
```

---

## Task 8: Final verification

- [ ] **Step 1: Type-check the whole frontend**

```bash
cd frontend && npx vue-tsc --noEmit 2>&1 | grep -E "useOrgWitnessState|WitnessAdoptionBanner|adoptOrgWitnesses|runAdoptWitnesses|DashboardPage|client\.ts|e2e-registration" | head -20
```

Expected: zero output (zero errors in files we touched).

- [ ] **Step 2: Run unit tests**

```bash
cd frontend && npm run test:script 2>&1 | tail -20
```

Expected: same baseline as before this plan — 50 passed + 1 pre-existing failure (`test-oobi-messaging`).

- [ ] **Step 3: Manual smoke against the live test infra**

Confirm the test infra is up:

```bash
cd /home/benz/Documents/1.projects/matou-app/../matou-infrastructure/keri && make health-test
```

Inspect the current org's witnesses BEFORE running the migration:

```bash
ORG_AID=$(grep '^    aid:' /home/benz/Documents/1.projects/matou-app/backend/data-test/org-config.yaml | head -1 | awk '{print $2}')
curl -s "http://localhost:4902/oobi/$ORG_AID" | head -c 400
```

Expect `"b":[]`.

Start backend + frontend in test mode (separate terminals):

```bash
cd /home/benz/Documents/1.projects/matou-app/backend && MATOU_ENV=test make run-test
cd /home/benz/Documents/1.projects/matou-app/frontend && MATOU_ENV=test npm run dev
```

Open the dashboard at the test-mode URL, log in as admin, click the banner.

Confirm the org's KEL advanced:

```bash
curl -s "http://localhost:4902/oobi/$ORG_AID" | head -c 800
```

Expect the original `icp` at `s:0` with `b:[]` AND a new `rot` at `s:1` with non-empty `ba` and `b`.

- [ ] **Step 4: Run the E2E suite**

```bash
cd /home/benz/Documents/1.projects/matou-app/frontend && npx playwright test e2e-registration.spec.ts --reporter=line
```

Expected: all 4 tests pass. The first test now auto-runs the migration via the banner in `beforeAll`.

- [ ] **Step 5: Final commit if anything was tweaked**

```bash
git status
# if dirty:
git add -A
git commit -m "chore(witness-adoption): final fixes after verification"
```

---

## Out of scope (documented for follow-up)

These are intentionally **not** in this plan:

1. **Auto-migrating admin's personal AID.** Their KEL is served via KERIA agent OOBI and works regardless of the stale hardcoded witness in `b`. Migrating personal AIDs is a separate concern.
2. **Cross-org migrations from a single admin.** Each org's admin runs this on their own dashboard.
3. **Different-subset migrations.** If the org has witnesses but wants a different subset, that's a separate operation (using `adds` + `cuts` together). The banner explicitly only renders for `b: []`.
4. **Silent automatic migration on login.** Explicit user click only.

---

## Spec coverage check (self-review)

| Spec requirement | Task |
|---|---|
| New method `adoptOrgWitnesses(orgName, masterAidName)` with idempotent return type | Task 2 |
| Single witness-only rotation using `adds`, `toad`, `states`, `rstates` | Task 2 |
| Verify witnesses present after rotation, throw if not | Task 2 |
| `useOrgWitnessState` composable with three-state `hasWitnesses` | Task 1 |
| `runAdoptWitnesses` orchestrator in `useAdminActions` | Task 3 |
| `WitnessAdoptionBanner.vue` with `data-test` attribute, `loading` prop, `@adopt` emit | Task 4 |
| Banner mounts in dashboard, gated on `isSteward && hasWitnesses === false` | Task 5 |
| `orgWitnesses.refresh()` runs on dashboard mount | Task 5 |
| Banner refreshes after successful migration | Task 5 |
| Update `addMemberRound1`'s error message to point at the banner | Task 6 |
| E2E auto-runs migration via banner in `beforeAll` | Task 7 |
| Manual verification — KEL inspection before and after | Task 8 |
| No regression on freshly-created orgs (banner stays hidden) | Task 7 (idempotent), Task 8 (E2E) |
