# Steward Peer Registry Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Any steward of an org group AID (1-of-N) can issue and revoke memberships from the one org registry, without forking the group KEL, on KERIA 0.4.0 (IDSS) and `matou-keria-patched` (legacy).

**Architecture:**
- **Five small modules** under `frontend/src/lib/keri/steward/`. Each is pure logic over an injected deps interface, so it's unit-testable without KERIA:
  - group sync from the witnesses (the fork guard);
  - registry adoption via `createFromEvents`;
  - replay of TEL events with the replaying steward's own signature;
  - replication to peers over keripy's native `/multisig/iss` and `/multisig/rev` exns;
  - sender-pushed history.
- **`KERIClient`** gets thin wrappers that bind these modules to signify-ts.
- **Two composables** wire them into the dashboard:
  - `useStewardReadiness` gates the Approve button;
  - `useOrgActInbox` applies replays from peers.
- **Existing defects fixed along the way:** the personal-AID fallback, the double rotation in the join handler, and the per-steward registries.

**Tech Stack:** Vue 3 / Quasar, Pinia, signify-ts ^0.3.0-rc2, vitest (`tests/scripts/*.test.ts`), Playwright e2e, KERIA 0.4.0 + keri-witness-demo 1.1.0 for the integration test.

**Spec:** `docs/superpowers/specs/2026-09-30-steward-peer-registry-design.md`. Task 1 amends §3.3 and §3.5; read the amended version.

## Global Constraints

- The org group stays **kt=1 / nt=1**. No task adds a co-sign round to issuance.
- **Never issue from a personal AID when the group was meant.** A missing group identifier is an error.
- **No new KERIA patches.** Only routes stock KERIA 0.4.0 already handles: `/multisig/iss`, `/multisig/rev`, and the CESR door.
- **One org registry per group:**
  - IDSS: `community.registry` from the descriptor.
  - Legacy: org config `registry.id`.
  - Per-steward registry creation is removed.
- **Every group-anchored act (issue, revoke) is preceded by `syncGroup` and refused on `GroupBehind` / `GroupDiverged`.**
- A replay's own signature is added **only** when the anchoring ixn's sn is greater than the group's latest establishment sn (`state.ee.s`).
- The steward that is `keys[0]` of the group never POSTs a replay that lacks its own signature. It skips and reports (a wedged escrow otherwise; spike round 1).
- Unit tests go in `frontend/tests/scripts/<name>.test.ts`; run them with `cd frontend && npx vitest run --config vitest.config.ts tests/scripts/<name>.test.ts`.
- Lint: `cd frontend && npx eslint <files>`. Type check: `cd frontend && npx vue-tsc --noEmit -p tsconfig.json`.
- Commit messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Branch: `design/steward-peer-registry` (already holds the spec).

## Review Focus

1. **The steward's agent is AHEAD of the witnesses:** it holds a group event no witness serves, e.g. an unwitnessed fork. Expect `syncGroup` to throw `GroupDiverged` and the act to be refused, not a silent issue on a fork. *(Task 3 test.)*
2. **Every witness is unreachable** (offline, or no witness config). Expect a refusal (`GroupBehind` with reason `witnesses unreachable`), never "no data, so assume synced". *(Task 3 test.)*
3. **The same act arrives twice:** a live `/multisig/iss` followed by the same credential in a history push, or two linked devices on one agent. Expect exactly one POST. The second is `already` and marked read. *(Task 6 test.)*
4. **An act for a different group or a different registry arrives** (e.g. a legacy per-steward registry's old `/multisig/iss`). Expect it to be ignored and marked read, never replayed into the org registry. *(Task 8 test.)*
5. **The `keys[0]` steward receives an act whose anchoring ixn predates the group's latest rotation.** Expect `skipped` with a reported reason, and no POST (the POST would wedge its escrow and flood the log). *(Task 6 test.)*

---

## File Structure

**Create:**
- `frontend/src/lib/keri/steward/errors.ts`: typed refusals (`GroupBehind`, `GroupDiverged`, `NotJoined`, `RegistryNotAdopted`, `ReplayFailed`), each carrying `userMessage`.
- `frontend/src/lib/keri/steward/sigs.ts`: indexed-signature parsing and merging; extracting a credential's TEL bundle from a CESR export.
- `frontend/src/lib/keri/steward/groupSync.ts`: `syncGroup`.
- `frontend/src/lib/keri/steward/registryAdoption.ts`: `ensureOrgRegistry`.
- `frontend/src/lib/keri/steward/replay.ts`: `replayAct`, `cosignPolicy`.
- `frontend/src/lib/keri/steward/replicate.ts`: `actEmbeds`, `parseActExn`, `planHistoryPush`.
- `frontend/src/composables/useStewardReadiness.ts`.
- `frontend/src/composables/useOrgActInbox.ts`.
- `frontend/tests/scripts/steward-sigs.test.ts`, `steward-group-sync.test.ts`, `steward-registry-adoption.test.ts`, `steward-replay.test.ts`, `steward-replicate.test.ts`, `admin-actions-org-aid.test.ts`, `multisig-join-dedupe.test.ts`.
- `frontend/tests/infra/keria-0.4/docker-compose.yml`, `keria-config.json` (copied from the spike), and `frontend/tests/infra/steward-peer.infra.ts` (KERIA 0.4.0 integration).

**Modify:**
- `frontend/src/lib/keri/client.ts`: public wrappers; group preflight and replication inside `issueCredential` / `revokeCredential`; `currentGroupSigners` made public; group KEL push targets.
- `frontend/src/lib/keri/registry.ts`: one org registry; `getOrCreateOrgRegistry` removed.
- `frontend/src/composables/useAdminActions.ts:171-224`: `getOrgAidName` throws `NotJoined`.
- `frontend/src/composables/useMultisigJoin.ts`: in-flight guard, rotation-SAID dedupe, `syncGroup` instead of `queryKeyStateToSn`, readiness after the join.
- `frontend/src/lib/keri/multisigRound.ts`: `isInitiatorExn`.
- `frontend/src/composables/useMultisigRotationSignal.ts`: drain the inbox before rotating.
- `frontend/src/pages/DashboardPage.vue`, `frontend/src/components/profiles/ProfileModal.vue`: readiness gate + inbox wiring.
- `frontend/tests/e2e/e2e-registration.spec.ts`: issuer assertion + cross-steward revoke.
- `docs/superpowers/specs/2026-09-30-steward-peer-registry-design.md`: amendments (Task 1).

---

### Task 1: Amend the spec to native routes and sender-pushed history

**Files:**
- Modify: `docs/superpowers/specs/2026-09-30-steward-peer-registry-design.md` (§3.3, §3.4, §3.5, §6, §8)

**Interfaces:** none (docs).

- [ ] **Step 1: Replace §3.3 with native routes**

Replace the whole `### 3.3 actReplication — sending` section with:

````markdown
### 3.3 `actReplication` — sending (native keripy group-issuance exns)
After an issue or revoke, the acting steward sends keripy's own group-issuance exn to each other signer's personal AID. The sender is the acting steward's member AID (the group's `mhab`). Stock KERIA already raises a notification for these routes on any agent that holds the group (`keri/app/grouping.py loadHandlers`, `Multiplexor.add`), so no KERIA patch is needed.

- `/multisig/iss`: payload `{gid}`; embeds `{acdc, iss, anc}` with `anc`'s signature attachment.
- `/multisig/rev`: payload `{gid}`; embeds `{acdc, iss, issanc, rev, anc}`. `acdc`, `iss` and `issanc` let a receiver that lacks the credential replay the issuance first.

Sending to each recipient is best-effort and never rolls the act back. `signify revoke()` does not return the sigs, so the sender reads the anchoring ixn and its sigs back from its own credential export (`credentials().get(said, true)`). The idss control panel implements the same two exns (§6).
````

- [ ] **Step 2: Update §3.4 to read the native exn**

In `### 3.4`, replace "For each unread `/matou/org/act`" with "For each unread `/multisig/iss` or `/multisig/rev` whose `gid` is the org group and whose embedded registry is the org registry (anything else is marked read and ignored)". Add a step before step 1: "Fetch the exn with `groups().getRequest(note.a.d)`. The embeds are in `exn.e` and their attachments in `paths`."

- [ ] **Step 3: Replace §3.5 with sender-pushed history**

Replace the whole `### 3.5` section with:

````markdown
### 3.5 `historyPush` — catch-up without a public ACDC source
The backend's community credential cache is lossy (no raw ACDC; `anystore.CachedCredential`), and the IDSS directory needs a panel session. So backfill is driven by the peer that **holds** the history:
- At every steward sign-in, and right after a promotion completes, each steward's app lists the credentials its own agent holds from the org registry.
- For every other signer it sends the `/multisig/iss` (and, if revoked, `/multisig/rev`) it has not sent that signer before. It records what it sent per peer in secure storage (`matou_org_acts_sent:<group>`).
- Receivers are idempotent (§3.4), so a re-send costs one no-op.
- A peer promoted while nobody who holds the history is online catches up the next time any holder signs in.
- The timestamp search for a revoked credential's `rev.dt` is no longer needed: the holder sends the real `rev`.
````

- [ ] **Step 4: Update §6 and §8**

- §6: replace "send `/matou/org/act` (§3.3)" with "send `/multisig/iss` / `/multisig/rev` (§3.3)", and "§3.5 catch-up at steward sign-in covers panel acts" with "a panel act reaches the other stewards the next time the acting steward signs in to the app (§3.5)".
- §8 step 3: replace "engie's next sign-in adopts the registry and catches up" with "engie's next sign-in adopts the registry; the founder's next sign-in pushes the history to engie".

- [ ] **Step 5: Commit**

```bash
cd /home/benz/Documents/1.projects/matou-app
git add docs/superpowers/specs/2026-09-30-steward-peer-registry-design.md
git commit -m "docs(spec): replicate over native /multisig/iss|rev; history pushed by its holder

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: KERIA 0.4.0 integration harness + the native-route gate

This task answers the one open question before anything builds on it: when a `/multisig/iss` exn arrives, does KERIA's `Multiplexor.add` auto-parse the embedded events, and what state does that leave on a `keys[0]` receiver and on an index-1 receiver?

**Files:**
- Create: `frontend/tests/infra/keria-0.4/docker-compose.yml` (copy `…/scratchpad/spike/docker-compose.yml`, project name `stewardpeer`, ports 5901-5903 → **5911-5913**, witness 5642-5647 → **5652-5657**; keep `--name keria`, NOT `--name agent`, which empties OOBIs on 0.4.0)
- Create: `frontend/tests/infra/keria-0.4/keria-config.json` (copy the spike's, with the witness ports updated)
- Create: `frontend/tests/infra/keria-0.4/witness-config/` (copy the spike's)
- Create: `frontend/tests/infra/steward-peer.infra.ts`
- Create: `frontend/tests/infra/README.md`

**Interfaces:**
- Produces: `frontend/tests/infra/steward-peer.infra.ts`, runnable with `cd frontend/tests/infra && docker compose -f keria-0.4/docker-compose.yml up -d && npx tsx steward-peer.infra.ts`. Exits 0 when every check passes and prints a PASS/FAIL table. Later tasks append checks to it.

- [ ] **Step 1: Copy the spike harness**

```bash
S=/tmp/claude-1000/-home-benz-Documents-1-projects-matou-app/e9e02527-3081-40d9-9c7a-ad6071ba369a/scratchpad/spike
D=/home/benz/Documents/1.projects/matou-app/frontend/tests/infra
mkdir -p $D/keria-0.4
cp $S/docker-compose.yml $S/keria-config.json $D/keria-0.4/
cp -r $S/witness-config $D/keria-0.4/
cat $S/head.ts $S/tail2.ts > $D/steward-peer.infra.ts
```

Then edit `keria-0.4/docker-compose.yml`: set `name: stewardpeer` and remap the host ports as above. In `steward-peer.infra.ts`, change the URL constants at the top to `KERIA_URL=http://localhost:5911`, `KERIA_BOOT_URL=http://localhost:5913`, `KERIA_CESR_URL=http://localhost:5912`, and point `COMPOSE` at `docker compose -f keria-0.4/docker-compose.yml`.

- [ ] **Step 2: Add the gate check (native `/multisig/iss` delivery)**

In `main()` after the promotion and adoption (where round 2's check "a" starts), add:

```ts
// GATE: native /multisig/iss delivery + Multiplexor auto-parse behaviour
{
  const since = nowIso();
  const X = await issueFrom(member, 'member', RECIPIENT_AID);          // member (index 1) issues X
  const exp = await member.credentials().get(X, true) as string;
  const p = partsOf(exp, X);
  const mh = await member.identifiers().get(G);
  await member.exchanges().send(
    MEMBER_NAME, G, (mh as any).group.mhab, '/multisig/iss', { gid: GROUP_PREFIX },
    { acdc: [new Serder(p.acdc!.sad), ''], iss: [new Serder(p.iss!.sad), ''], anc: [new Serder(p.ancIss!.sad), p.ancIss!.atc] },
    [ADMIN_PREFIX],
  );
  // 1. admin (keys[0]) gets a notification
  const note = await waitForNote(admin, '/multisig/iss', 30_000);
  note ? pass('gate: /multisig/iss notifies keys[0]') : fail('gate: /multisig/iss notifies keys[0]', 'no note');
  // 2. what did auto-parse do?
  await new Promise((r) => setTimeout(r, 8000));
  const st = await admin.credentials().state(REGK, X).catch((e: Error) => ({ err: e.message }));
  log(`  gate: admin state(X) after exn only = ${JSON.stringify(st)}`);
  const flood = kl(since, 'gate', /MissingAnchorError|Waiting for fully signed/).length;
  log(`  gate: escrow noise lines = ${flood}`);
  // 3. explicit replay with admin's own sig still converges
  const sigs = [...firstSigs(p.ancIss!.atc), ...(await ownSigs(admin, p.ancIss!.raw))];
  await replayIss(admin, p.acdc!.sad, p.iss!.sad, p.ancIss!, sigs);
  const st2 = await admin.credentials().state(REGK, X);
  st2.et === 'iss' ? pass('gate: replay after exn converges on keys[0]') : fail('gate: replay after exn converges on keys[0]', JSON.stringify(st2));
  await new Promise((r) => setTimeout(r, 6000));
  const flood2 = kl(nowIso(), 'gate-after', /MissingAnchorError|Waiting for fully signed/).length;
  flood2 === 0 ? pass('gate: no lingering escrow after replay') : fail('gate: no lingering escrow after replay', `${flood2} lines`);
}
```

Add these helpers next to the existing ones (`partsOf`, `firstSigs`, `kl` and `nowIso` are already in `tail2.ts`):

```ts
async function waitForNote(c: SignifyClient, route: string, ms: number) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const res = await c.notifications().list();
    const n = (res.notes ?? []).find((x: any) => x.a?.r === route && !x.r);
    if (n) return n;
    await new Promise((r) => setTimeout(r, 1000));
  }
  return null;
}
async function ownSigs(c: SignifyClient, raw: string): Promise<string[]> {
  const gh = await c.identifiers().get(G);
  return (await c.manager!.get(gh).sign(b(raw))) as unknown as string[];
}
async function replayIss(c: SignifyClient, acdc: any, iss: any, anc: { sad: any }, sigs: string[]) {
  const gh = await c.identifiers().get(G); const k = c.manager!.get(gh);
  await c.fetch(`/identifiers/${G}/credentials`, 'POST', { acdc, iss, ixn: anc.sad, sigs, [k.algo]: k.params() });
}
```

Reuse `issueFrom` if the spike defines an equivalent; otherwise wrap the spike's member issuance block into `issueFrom(client, name, issuee): Promise<string>`, which returns the credential SAID.

- [ ] **Step 3: Write `frontend/tests/infra/README.md`**

```markdown
# KERIA 0.4.0 integration harness

Proves the steward-peer design (docs/superpowers/specs/2026-09-30-steward-peer-registry-design.md)
against the KERIA IDSS runs. Isolated compose project `stewardpeer`, host ports 5911-5913 and
5652-5657; it never touches the dev (39xx) or test (49xx) stacks.

    cd frontend/tests/infra
    docker compose -f keria-0.4/docker-compose.yml up -d
    npx tsx steward-peer.infra.ts          # MODE=held (default) or MODE=fresh
    docker compose -f keria-0.4/docker-compose.yml down -v

Gotcha: KERIA 0.4.0 must be started with `--name keria` — `--name agent` makes every OOBI empty.
```

- [ ] **Step 4: Run it**

```bash
cd /home/benz/Documents/1.projects/matou-app/frontend/tests/infra
docker compose -f keria-0.4/docker-compose.yml up -d
npx tsx steward-peer.infra.ts 2>&1 | tee /tmp/claude-1000/-home-benz-Documents-1-projects-matou-app/e9e02527-3081-40d9-9c7a-ad6071ba369a/scratchpad/infra-gate.log | tail -40
docker compose -f keria-0.4/docker-compose.yml down -v
```

Expected: all three gate checks PASS, plus the spike's existing rows.

**Decision point:**
- If `gate: /multisig/iss notifies keys[0]` FAILS, stop and report to the human. §3.3 would need another transport.
- If auto-parse alone already yields `et=iss` on the admin, record that in the README. The replay's `already` branch (Task 6) then handles it, and no code changes.
- If `no lingering escrow after replay` FAILS, stop and report. Auto-parse would be wedging `keys[0]`.

- [ ] **Step 5: Commit**

```bash
cd /home/benz/Documents/1.projects/matou-app
git add frontend/tests/infra
git commit -m "test(infra): KERIA 0.4.0 steward-peer harness + native /multisig/iss gate

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Typed refusals, signature parsing, TEL bundle, and `syncGroup`

**Files:**
- Create: `frontend/src/lib/keri/steward/errors.ts`
- Create: `frontend/src/lib/keri/steward/sigs.ts`
- Create: `frontend/src/lib/keri/steward/groupSync.ts`
- Test: `frontend/tests/scripts/steward-sigs.test.ts`, `frontend/tests/scripts/steward-group-sync.test.ts`

**Interfaces:**
- Consumes: `parseCesrStream`, `filterKelMessages`, `mergeKelMessages`, `CesrMessage` from `src/lib/keri/cesr`.
- Produces:
  - `class StewardRefusal extends Error { userMessage: string }` and its subclasses `GroupBehind`, `GroupDiverged`, `NotJoined`, `RegistryNotAdopted`, `ReplayFailed`.
  - `indexedSigs(atc: string): string[]`, `sigIndex(qb64: string): number`, `mergeSigs(a: string[], b: string[]): string[]`.
  - `interface TelBundle { acdc: CesrMessage; iss?: CesrMessage; rev?: CesrMessage; issAnc?: CesrMessage; revAnc?: CesrMessage }`.
  - `telBundle(cesr: string, credSaid: string): TelBundle`.
  - `interface GroupSyncDeps { witnessUrls(): Promise<string[]>; fetchText(url: string): Promise<string | null>; pushEvent(msg: CesrMessage, destination: string): Promise<boolean>; localGroupSn(group: string): Promise<number> }`.
  - `syncGroup(group: string, memberAid: string, deps: GroupSyncDeps): Promise<{ sn: number }>`.

- [ ] **Step 1: Write the failing tests**

`frontend/tests/scripts/steward-sigs.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { indexedSigs, sigIndex, mergeSigs, telBundle } from 'src/lib/keri/steward/sigs';

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
const sig = (idx: number, fill: string) => `A${B64[idx]}` + fill.repeat(86);
function ev(obj: Record<string, unknown>, proto = 'KERI'): string {
  const body = JSON.stringify({ v: `${proto}10JSON000000_`, ...obj });
  const size = new TextEncoder().encode(body).length;
  return body.replace('000000', size.toString(16).padStart(6, '0'));
}

describe('indexedSigs', () => {
  it('reads a bare -A group', () => {
    const atc = `-AAB${sig(0, 'x')}${sig(1, 'y')}-BAC...`.replace('-AAB', '-AAC');
    expect(indexedSigs(atc)).toEqual([sig(0, 'x'), sig(1, 'y')]);
  });
  it('unwraps a -V## attachment group', () => {
    expect(indexedSigs(`-VAX-AAB${sig(1, 'z')}`)).toEqual([sig(1, 'z')]);
  });
  it('throws on an attachment without signatures', () => {
    expect(() => indexedSigs('-BAC')).toThrow(/indexed signature/);
  });
});

describe('mergeSigs', () => {
  it('dedupes by index and sorts by index, first wins', () => {
    expect(mergeSigs([sig(1, 'a')], [sig(0, 'b'), sig(1, 'c')])).toEqual([sig(0, 'b'), sig(1, 'a')]);
    expect(sigIndex(sig(1, 'a'))).toBe(1);
  });
});

describe('telBundle', () => {
  it('picks the ACDC, its iss/rev and each one\'s anchoring ixn', () => {
    const acdc = ev({ d: 'ECRED', i: 'EGRP', ri: 'EREG', s: 'ESCH', a: { i: 'EHOLDER', dt: '2026-09-30T00:00:00.000000+00:00' } }, 'ACDC');
    const iss = ev({ t: 'iss', d: 'EISS', i: 'ECRED', s: '0', ri: 'EREG', dt: 'x' });
    const ancIss = ev({ t: 'ixn', d: 'EANC1', i: 'EGRP', s: '4', p: 'E', a: [{ i: 'ECRED', s: '0', d: 'EISS' }] });
    const rev = ev({ t: 'rev', d: 'EREV', i: 'ECRED', s: '1', ri: 'EREG', p: 'EISS', dt: 'y' });
    const ancRev = ev({ t: 'ixn', d: 'EANC2', i: 'EGRP', s: '5', p: 'E', a: [{ i: 'ECRED', s: '1', d: 'EREV' }] });
    const stream = `${ancIss}-AAB${sig(0, 'q')}${iss}-GAB${acdc}${ancRev}-AAB${sig(1, 'r')}${rev}`;
    const b = telBundle(stream, 'ECRED');
    expect(b.acdc.event.d).toBe('ECRED');
    expect(b.iss?.event.d).toBe('EISS');
    expect(b.issAnc?.event.d).toBe('EANC1');
    expect(indexedSigs(b.issAnc!.attachment)).toEqual([sig(0, 'q')]);
    expect(b.rev?.event.d).toBe('EREV');
    expect(b.revAnc?.event.d).toBe('EANC2');
  });
  it('throws when the ACDC is not in the export', () => {
    expect(() => telBundle('', 'ECRED')).toThrow(/ECRED/);
  });
});
```

`frontend/tests/scripts/steward-group-sync.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import { syncGroup, type GroupSyncDeps } from 'src/lib/keri/steward/groupSync';
import { GroupBehind, GroupDiverged } from 'src/lib/keri/steward/errors';

function ev(obj: Record<string, unknown>): string {
  const body = JSON.stringify({ v: 'KERI10JSON000000_', ...obj });
  return body.replace('000000', new TextEncoder().encode(body).length.toString(16).padStart(6, '0'));
}
const kel = (upTo: number) =>
  Array.from({ length: upTo + 1 }, (_, s) => ev({ t: s === 0 ? 'icp' : 'ixn', d: `E${s}`, i: 'EGRP', s: s.toString(16) }) + '-AAB' + 'A'.repeat(88)).join('');

function deps(over: Partial<GroupSyncDeps> & { local: number[] }): GroupSyncDeps {
  const local = [...over.local];
  return {
    witnessUrls: over.witnessUrls ?? (async () => ['http://w1', 'http://w2']),
    fetchText: over.fetchText ?? (async () => kel(5)),
    pushEvent: over.pushEvent ?? vi.fn(async () => true),
    localGroupSn: async () => (local.length > 1 ? local.shift()! : local[0]!),
  };
}

describe('syncGroup', () => {
  it('pushes only events above the local sn and returns the synced sn', async () => {
    const push = vi.fn(async () => true);
    const d = deps({ local: [3, 5], pushEvent: push });
    await expect(syncGroup('EGRP', 'EME', d)).resolves.toEqual({ sn: 5 });
    expect(push.mock.calls.map((c) => c[0].event.s)).toEqual(['4', '5']);
    expect(push.mock.calls[0]![1]).toBe('EME');
  });
  it('refuses when the agent is still behind after the push', async () => {
    await expect(syncGroup('EGRP', 'EME', deps({ local: [3, 4] }))).rejects.toBeInstanceOf(GroupBehind);
  });
  it('refuses when every witness is unreachable (Review Focus 2)', async () => {
    const d = deps({ local: [5], fetchText: async () => null });
    await expect(syncGroup('EGRP', 'EME', d)).rejects.toThrow(/witnesses unreachable/);
  });
  it('refuses when there is no witness config at all (Review Focus 2)', async () => {
    const d = deps({ local: [5], witnessUrls: async () => [] });
    await expect(syncGroup('EGRP', 'EME', d)).rejects.toBeInstanceOf(GroupBehind);
  });
  it('refuses when the agent is AHEAD of every witness (Review Focus 1)', async () => {
    await expect(syncGroup('EGRP', 'EME', deps({ local: [7] }))).rejects.toBeInstanceOf(GroupDiverged);
  });
  it('uses the highest sn any witness serves', async () => {
    const d = deps({ local: [5, 6], fetchText: async (u) => (u === 'http://w1/oobi/EGRP' ? kel(5) : kel(6)) });
    await expect(syncGroup('EGRP', 'EME', d)).resolves.toEqual({ sn: 6 });
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd frontend && npx vitest run --config vitest.config.ts tests/scripts/steward-sigs.test.ts tests/scripts/steward-group-sync.test.ts`
Expected: FAIL with "Failed to resolve import src/lib/keri/steward/sigs".

- [ ] **Step 3: Implement `errors.ts`**

```ts
/**
 * Refusals a steward sees instead of an org act that would be wrong: a KEL
 * fork, an issuance from the wrong identity, or a registry this agent cannot
 * issue into. `userMessage` is shown as-is; `message` carries the detail.
 */
export class StewardRefusal extends Error {
  constructor(message: string, readonly userMessage: string) {
    super(message);
    this.name = new.target.name;
  }
}
export class GroupBehind extends StewardRefusal {
  constructor(detail: string) {
    super(`group KEL behind the witnesses: ${detail}`, "Your copy of the community's history is behind — try again in a moment.");
  }
}
export class GroupDiverged extends StewardRefusal {
  constructor(detail: string) {
    super(`group KEL ahead of every witness: ${detail}`, "Your copy of the community's history has events the community's witnesses don't — contact the other stewards before acting.");
  }
}
export class NotJoined extends StewardRefusal {
  constructor(detail: string) {
    super(`not joined to the org group: ${detail}`, "You're still being set up as a steward — finish joining before approving.");
  }
}
export class RegistryNotAdopted extends StewardRefusal {
  constructor(detail: string) {
    super(`org registry not adopted: ${detail}`, "Your wallet can't issue into the community's registry yet — try again in a moment.");
  }
}
export class ReplayFailed extends StewardRefusal {
  constructor(detail: string) {
    super(`replay failed: ${detail}`, "A change another steward made couldn't be applied to your wallet yet.");
  }
}
```

- [ ] **Step 4: Implement `sigs.ts`**

```ts
import { parseCesrStream, type CesrMessage } from 'src/lib/keri/cesr';

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
const SIG_LEN = 88; // Ed25519 indexed signature, qb64

/**
 * The first controller indexed-signature group (`-A##`) of a CESR attachment,
 * optionally wrapped in an attachment group (`-V##`). Enough for the KEL events
 * KERIA exports and witnesses serve.
 */
export function indexedSigs(atc: string): string[] {
  let a = atc.replace(/[\r\n]+/g, '');
  if (a.startsWith('-V')) a = a.slice(4);
  if (!a.startsWith('-A')) throw new Error(`no indexed signature group at start of attachment "${a.slice(0, 8)}"`);
  const n = B64.indexOf(a[2]!) * 64 + B64.indexOf(a[3]!);
  const out: string[] = [];
  for (let i = 0; i < n; i++) out.push(a.substr(4 + i * SIG_LEN, SIG_LEN));
  return out;
}

/** Signing-key index of a single-char-index Ed25519 indexed signature. */
export function sigIndex(qb64: string): number {
  return B64.indexOf(qb64[1]!);
}

/** Union of two signature sets, one per key index (first seen wins), in index order. */
export function mergeSigs(a: string[], b: string[]): string[] {
  const byIdx = new Map<number, string>();
  for (const s of [...a, ...b]) if (!byIdx.has(sigIndex(s))) byIdx.set(sigIndex(s), s);
  return [...byIdx.entries()].sort((x, y) => x[0] - y[0]).map(([, s]) => s);
}

export interface TelBundle {
  acdc: CesrMessage;
  iss?: CesrMessage;
  rev?: CesrMessage;
  issAnc?: CesrMessage;
  revAnc?: CesrMessage;
}

/** Split a `credentials().get(said, true)` export into the parts a replay needs. */
export function telBundle(cesr: string, credSaid: string): TelBundle {
  const ms = parseCesrStream(cesr);
  const acdc = ms.find((m) => !m.event.t && m.event.d === credSaid);
  if (!acdc) throw new Error(`credential ${credSaid} not in export`);
  const anc = (sealSn: string) =>
    ms.find((m) => m.event.t === 'ixn' && Array.isArray(m.event.a) &&
      (m.event.a as Array<{ i?: string; s?: string }>).some((x) => x.i === credSaid && x.s === sealSn));
  return {
    acdc,
    iss: ms.find((m) => m.event.t === 'iss' && m.event.i === credSaid),
    rev: ms.find((m) => m.event.t === 'rev' && m.event.i === credSaid),
    issAnc: anc('0'),
    revAnc: anc('1'),
  };
}
```

- [ ] **Step 5: Implement `groupSync.ts`**

```ts
import { parseCesrStream, filterKelMessages, mergeKelMessages, type CesrMessage } from 'src/lib/keri/cesr';
import { GroupBehind, GroupDiverged } from './errors';

export interface GroupSyncDeps {
  /** Browser-reachable witness base URLs (client config `witnesses.urls`). */
  witnessUrls(): Promise<string[]>;
  /** GET a URL's body, or null on any non-2xx / network failure. */
  fetchText(url: string): Promise<string | null>;
  /** POST one event to OUR agent's CESR door with CESR-DESTINATION = memberAid. */
  pushEvent(msg: CesrMessage, destination: string): Promise<boolean>;
  /** Our agent's current sn for the group, as a number. */
  localGroupSn(group: string): Promise<number>;
}

/**
 * Bring this steward's agent to the group sn the witnesses hold, or refuse.
 * The ONLY fork guard: a steward that anchors from a stale view writes a
 * second event at an sn the witnesses already hold — silently (spike 2b).
 * Pull goes witness → browser → our CESR door because re-resolving an
 * already-known OOBI through the agent does not move sn.
 */
export async function syncGroup(group: string, memberAid: string, deps: GroupSyncDeps): Promise<{ sn: number }> {
  const bases = await deps.witnessUrls();
  if (bases.length === 0) throw new GroupBehind('no witness URLs configured');
  const streams = await Promise.all(bases.map((b) => deps.fetchText(`${b.replace(/\/+$/, '')}/oobi/${group}`)));
  let msgs: CesrMessage[] = [];
  for (const s of streams) if (s) msgs = mergeKelMessages(msgs, filterKelMessages(parseCesrStream(s)));
  const own = msgs.filter((m) => m.event.i === group).sort((a, b) => parseInt(a.event.s, 16) - parseInt(b.event.s, 16));
  if (own.length === 0) throw new GroupBehind('witnesses unreachable or none serves the group');
  const target = parseInt(own[own.length - 1]!.event.s, 16);

  const before = await deps.localGroupSn(group);
  if (before > target) throw new GroupDiverged(`agent sn=${before}, witnesses sn=${target}`);
  for (const m of own) {
    if (parseInt(m.event.s, 16) > before) await deps.pushEvent(m, memberAid);
  }
  const after = await deps.localGroupSn(group);
  if (after > target) throw new GroupDiverged(`agent sn=${after}, witnesses sn=${target}`);
  if (after < target) throw new GroupBehind(`agent sn=${after} after push, witnesses sn=${target}`);
  return { sn: after };
}
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `cd frontend && npx vitest run --config vitest.config.ts tests/scripts/steward-sigs.test.ts tests/scripts/steward-group-sync.test.ts`
Expected: PASS (all cases).

- [ ] **Step 7: Commit**

```bash
cd /home/benz/Documents/1.projects/matou-app
git add frontend/src/lib/keri/steward/errors.ts frontend/src/lib/keri/steward/sigs.ts frontend/src/lib/keri/steward/groupSync.ts frontend/tests/scripts/steward-sigs.test.ts frontend/tests/scripts/steward-group-sync.test.ts
git commit -m "feat(steward): typed refusals, CESR sig/TEL parsing, syncGroup fork guard

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Registry adoption

**Files:**
- Create: `frontend/src/lib/keri/steward/registryAdoption.ts`
- Test: `frontend/tests/scripts/steward-registry-adoption.test.ts`

**Interfaces:**
- Consumes: `indexedSigs`, `parseCesrStream`, `RegistryNotAdopted`.
- Produces:
  - `interface AdoptionDeps { listRegistries(group: string): Promise<string[]>; heldCredentialSaids(regk: string): Promise<string[]>; exportCredential(said: string): Promise<string>; createFromEvents(vcp: Record<string, unknown>, anc: Record<string, unknown>, sigs: string[], name: string): Promise<void>; sleep(ms: number): Promise<void> }`
  - `ensureOrgRegistry(group: string, regk: string, deps: AdoptionDeps, opts?: { timeoutMs?: number; pollMs?: number }): Promise<'present' | 'adopted'>`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, vi } from 'vitest';
import { ensureOrgRegistry, type AdoptionDeps } from 'src/lib/keri/steward/registryAdoption';
import { RegistryNotAdopted } from 'src/lib/keri/steward/errors';

function ev(obj: Record<string, unknown>, proto = 'KERI'): string {
  const body = JSON.stringify({ v: `${proto}10JSON000000_`, ...obj });
  return body.replace('000000', new TextEncoder().encode(body).length.toString(16).padStart(6, '0'));
}
const SIG = 'AA' + 'x'.repeat(86);
const exportText =
  ev({ t: 'icp', d: 'EGRP', i: 'EGRP', s: '0' }) + '-AAB' + SIG +
  ev({ t: 'ixn', d: 'EANC', i: 'EGRP', s: '1', a: [{ i: 'EREG', s: '0', d: 'EREG' }] }) + '-AAB' + SIG +
  ev({ t: 'vcp', d: 'EREG', i: 'EREG', s: '0', ii: 'EGRP' }) + '-GAB' +
  ev({ d: 'ECRED', i: 'EGRP', ri: 'EREG' }, 'ACDC');

function deps(over: Partial<AdoptionDeps> = {}): AdoptionDeps {
  let listed: string[] = [];
  return {
    listRegistries: vi.fn(async () => listed),
    heldCredentialSaids: vi.fn(async () => ['ECRED']),
    exportCredential: vi.fn(async () => exportText),
    createFromEvents: vi.fn(async () => { listed = ['EREG']; }),
    sleep: async () => {},
    ...over,
  };
}

describe('ensureOrgRegistry', () => {
  it('is a no-op when the agent already lists the registry', async () => {
    const d = deps({ listRegistries: async () => ['EREG'] });
    await expect(ensureOrgRegistry('EGRP', 'EREG', d)).resolves.toBe('present');
    expect(d.createFromEvents).not.toHaveBeenCalled();
  });
  it('adopts from the original vcp + anchoring ixn + its sigs', async () => {
    const d = deps();
    await expect(ensureOrgRegistry('EGRP', 'EREG', d)).resolves.toBe('adopted');
    const [vcp, anc, sigs] = (d.createFromEvents as any).mock.calls[0];
    expect(vcp.d).toBe('EREG');
    expect(anc.d).toBe('EANC');
    expect(sigs).toEqual([SIG]);
  });
  it('polls list until the escrow resolves (op done is not trusted)', async () => {
    let calls = 0;
    const d = deps({
      listRegistries: async () => (++calls >= 4 ? ['EREG'] : []),
      createFromEvents: async () => {},
    });
    await expect(ensureOrgRegistry('EGRP', 'EREG', d)).resolves.toBe('adopted');
  });
  it('refuses when the agent holds nothing from the registry', async () => {
    const d = deps({ heldCredentialSaids: async () => [] });
    await expect(ensureOrgRegistry('EGRP', 'EREG', d)).rejects.toBeInstanceOf(RegistryNotAdopted);
  });
  it('refuses when the registry never lists within the budget', async () => {
    const d = deps({ createFromEvents: async () => {} });
    await expect(ensureOrgRegistry('EGRP', 'EREG', d, { timeoutMs: 0 })).rejects.toBeInstanceOf(RegistryNotAdopted);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd frontend && npx vitest run --config vitest.config.ts tests/scripts/steward-registry-adoption.test.ts`
Expected: FAIL, "Failed to resolve import".

- [ ] **Step 3: Implement**

```ts
import { parseCesrStream } from 'src/lib/keri/cesr';
import { indexedSigs } from './sigs';
import { RegistryNotAdopted } from './errors';

export interface AdoptionDeps {
  listRegistries(group: string): Promise<string[]>;
  heldCredentialSaids(regk: string): Promise<string[]>;
  exportCredential(said: string): Promise<string>;
  createFromEvents(vcp: Record<string, unknown>, anc: Record<string, unknown>, sigs: string[], name: string): Promise<void>;
  sleep(ms: number): Promise<void>;
}

/**
 * Give this agent a `Registry` for the org's EXISTING registry, so KERIA's
 * `Registrar.issue` (`rgy.regs[regk]`) stops raising KeyError → 500. Replays
 * the registry's original `vcp` and the group ixn that anchored it — both
 * taken from a credential this steward already holds — through
 * `createFromEvents`. keripy treats the ixn as a duplicate and swallows the
 * vcp's LikelyDuplicitous, so nothing new is anchored (spike 1).
 */
export async function ensureOrgRegistry(
  group: string,
  regk: string,
  deps: AdoptionDeps,
  opts: { timeoutMs?: number; pollMs?: number } = {},
): Promise<'present' | 'adopted'> {
  if ((await deps.listRegistries(group)).includes(regk)) return 'present';

  const held = await deps.heldCredentialSaids(regk);
  if (held.length === 0) throw new RegistryNotAdopted(`agent holds no credential from ${regk} to adopt from`);
  const ms = parseCesrStream(await deps.exportCredential(held[0]!));
  const vcp = ms.find((m) => m.event.t === 'vcp' && m.event.i === regk);
  const anc = ms.find((m) => m.event.t === 'ixn' && m.event.i === group && Array.isArray(m.event.a) &&
    (m.event.a as Array<{ i?: string; s?: string }>).some((x) => x.i === regk && x.s === '0'));
  if (!vcp || !anc) throw new RegistryNotAdopted(`export of ${held[0]} lacks the registry inception or its anchor`);

  await deps.createFromEvents(vcp.event, anc.event, indexedSigs(anc.attachment), `org-${regk.slice(0, 12)}`);

  const deadline = Date.now() + (opts.timeoutMs ?? 15_000);
  do {
    if ((await deps.listRegistries(group)).includes(regk)) return 'adopted';
    await deps.sleep(opts.pollMs ?? 1000);
  } while (Date.now() < deadline);
  throw new RegistryNotAdopted(`${regk} not listed after adoption`);
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `cd frontend && npx vitest run --config vitest.config.ts tests/scripts/steward-registry-adoption.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd /home/benz/Documents/1.projects/matou-app
git add frontend/src/lib/keri/steward/registryAdoption.ts frontend/tests/scripts/steward-registry-adoption.test.ts
git commit -m "feat(steward): adopt the org registry from the steward's own held credential

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: `KERIClient` wrappers binding the steward modules to signify

**Files:**
- Modify: `frontend/src/lib/keri/client.ts` (new public methods next to `pushKelToAgent`; `currentGroupSigners` from `private` to public)

**Interfaces:**
- Consumes: `syncGroup`, `GroupSyncDeps`, `ensureOrgRegistry`, `AdoptionDeps`, `fetchClientConfig`.
- Produces (public methods of `KERIClient`):
  - `syncGroupFromWitnesses(groupPrefix: string): Promise<{ sn: number }>`
  - `ensureOrgRegistryAdopted(groupPrefix: string, regk: string): Promise<'present' | 'adopted'>`
  - `groupMemberAid(groupPrefix: string): Promise<string>` (this steward's `mhab` prefix; throws `NotJoined` when the group isn't a local identifier)
  - `otherGroupSigners(groupPrefix: string): Promise<string[]>`
  - `exportCredential(said: string): Promise<string>`
  - `signAsGroupMember(groupPrefix: string, raw: string): Promise<string[]>`
  - `groupKeyState(groupPrefix: string): Promise<{ k: string[]; latestEstSn: number; memberKey: string }>`
  - `currentGroupSigners` becomes public (signature unchanged).

- [ ] **Step 1: Add the imports at the top of `client.ts`**

```ts
import { syncGroup, type GroupSyncDeps } from 'src/lib/keri/steward/groupSync';
import { ensureOrgRegistry, type AdoptionDeps } from 'src/lib/keri/steward/registryAdoption';
import { NotJoined } from 'src/lib/keri/steward/errors';
```

- [ ] **Step 2: Make `currentGroupSigners` public**

At `client.ts:1778`, change `private async currentGroupSigners(` to `async currentGroupSigners(`.

- [ ] **Step 3: Add the wrappers after `pushKelToAgent`**

```ts
  /** This steward's member AID (the group's local mhab). Throws NotJoined. */
  async groupMemberAid(groupPrefix: string): Promise<string> {
    if (!this.client) throw new Error('Not initialized');
    let hab: { group?: { mhab?: { prefix?: string } } } | null = null;
    try { hab = await this.client.identifiers().get(groupPrefix) as typeof hab; } catch { hab = null; }
    const mhab = hab?.group?.mhab?.prefix;
    if (!mhab) throw new NotJoined(`no local group identifier for ${groupPrefix.slice(0, 12)}`);
    return mhab;
  }

  /** Bring our agent to the witnesses' group sn, or throw GroupBehind / GroupDiverged. */
  async syncGroupFromWitnesses(groupPrefix: string): Promise<{ sn: number }> {
    if (!this.client) throw new Error('Not initialized');
    await this.ensureConnected();
    const client = this.client;
    const base = this.cesrFetchUrl.replace(/\/+$/, '');
    const memberAid = await this.groupMemberAid(groupPrefix);
    const deps: GroupSyncDeps = {
      witnessUrls: async () => {
        const { fetchClientConfig } = await import('../clientConfig');
        return (await fetchClientConfig()).witnesses?.urls ?? [];
      },
      fetchText: async (url) => {
        try {
          const r = await fetch(url, { signal: AbortSignal.timeout(8000) });
          return r.ok ? await r.text() : null;
        } catch { return null; }
      },
      pushEvent: async (msg, destination) => {
        const r = await fetch(`${base}/`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/cesr+json',
            'CESR-ATTACHMENT': msg.attachment.replace(/[\r\n]+/g, ''),
            'CESR-DESTINATION': destination,
          },
          body: msg.eventRaw,
          signal: AbortSignal.timeout(10000),
        });
        return r.ok; // 204 is not proof of acceptance — syncGroup re-reads sn
      },
      localGroupSn: async (g) => {
        const hab = await client.identifiers().get(g) as { state?: { s?: string } };
        return parseInt(hab.state?.s ?? '0', 16);
      },
    };
    const res = await syncGroup(groupPrefix, memberAid, deps);
    console.log(`[KERIClient] group ${groupPrefix.slice(0, 12)}... synced to witnesses at sn=${res.sn}`);
    return res;
  }

  /** Make sure our agent can issue into the org registry (adopting it if needed). */
  async ensureOrgRegistryAdopted(groupPrefix: string, regk: string): Promise<'present' | 'adopted'> {
    if (!this.client) throw new Error('Not initialized');
    const client = this.client;
    const deps: AdoptionDeps = {
      listRegistries: async (g) => ((await client.registries().list(g)) as Array<{ regk: string }>).map((r) => r.regk),
      heldCredentialSaids: async (r) => {
        const creds = await client.credentials().list({ filter: { '-ri': r }, limit: 5 }) as Array<{ sad: { d: string } }>;
        return creds.map((c) => c.sad.d);
      },
      exportCredential: (said) => this.exportCredential(said),
      createFromEvents: async (vcp, anc, sigs, name) => {
        const hab = await client.identifiers().get(groupPrefix);
        const res = await client.registries().createFromEvents(hab, groupPrefix, name, vcp, anc, sigs) as unknown as Response;
        if (res && typeof res.ok === 'boolean' && !res.ok) throw new Error(`createFromEvents HTTP ${res.status}`);
      },
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    };
    const out = await ensureOrgRegistry(groupPrefix, regk, deps);
    if (out === 'adopted') console.log(`[KERIClient] adopted org registry ${regk.slice(0, 12)}...`);
    return out;
  }

  /** Personal AIDs of every OTHER current signer of the group. */
  async otherGroupSigners(groupPrefix: string): Promise<string[]> {
    const me = await this.groupMemberAid(groupPrefix);
    const signers = await this.currentGroupSigners(groupPrefix, [me]);
    return signers.map((s) => s.aid).filter((a) => a !== me);
  }

  /** CESR export of a held credential: its KELs, TEL and ACDC. */
  async exportCredential(said: string): Promise<string> {
    if (!this.client) throw new Error('Not initialized');
    return await this.client.credentials().get(said, true) as unknown as string;
  }

  /** Our group-member signature(s) over an event's exact raw text. */
  async signAsGroupMember(groupPrefix: string, raw: string): Promise<string[]> {
    if (!this.client) throw new Error('Not initialized');
    const signify = await import('signify-ts');
    const hab = await this.client.identifiers().get(groupPrefix);
    const keeper = this.client.manager!.get(hab);
    return (await keeper.sign(signify.b(raw))) as unknown as string[];
  }

  /** Group signing keys, latest establishment sn, and our member's current key. */
  async groupKeyState(groupPrefix: string): Promise<{ k: string[]; latestEstSn: number; memberKey: string }> {
    if (!this.client) throw new Error('Not initialized');
    const hab = await this.client.identifiers().get(groupPrefix) as {
      state?: { k?: string[]; ee?: { s?: string } };
      group?: { mhab?: { state?: { k?: string[] } } };
    };
    return {
      k: hab.state?.k ?? [],
      latestEstSn: parseInt(hab.state?.ee?.s ?? '0', 16),
      memberKey: hab.group?.mhab?.state?.k?.[0] ?? '',
    };
  }
```

If `credentials().list` rejects the `-ri` filter key on KERIA 0.4.0, use `list()` and filter client-side on `c.sad.ri === r`. Keep that fallback inside `heldCredentialSaids`.

- [ ] **Step 4: Type-check and lint**

Run: `cd frontend && npx vue-tsc --noEmit -p tsconfig.json && npx eslint src/lib/keri/client.ts src/lib/keri/steward`
Expected: no errors.

- [ ] **Step 5: Prove the wrappers against KERIA 0.4.0**

In `frontend/tests/infra/steward-peer.infra.ts`, add after the promotion, before adoption:

```ts
// wrappers: adopt through the same code path the app uses
{
  const { ensureOrgRegistry } = await import('../../src/lib/keri/steward/registryAdoption');
  const r = await ensureOrgRegistry(GROUP_PREFIX, REGK, {
    listRegistries: async (g) => ((await member.registries().list(g)) as any[]).map((x) => x.regk),
    heldCredentialSaids: async () => [HELD_CRED_SAID],
    exportCredential: async (s) => (await member.credentials().get(s, true)) as string,
    createFromEvents: async (vcp, anc, sigs, name) => { await member.registries().createFromEvents(await member.identifiers().get(G), G, name, vcp, anc, sigs); },
    sleep: (ms) => new Promise((x) => setTimeout(x, ms)),
  });
  r === 'adopted' ? pass('module: ensureOrgRegistry adopts on 0.4.0') : fail('module: ensureOrgRegistry adopts on 0.4.0', r);
}
```

Run the harness (Task 2, Step 4 commands). Expected: the new row PASSes.

- [ ] **Step 6: Commit**

```bash
cd /home/benz/Documents/1.projects/matou-app
git add frontend/src/lib/keri/client.ts frontend/tests/infra/steward-peer.infra.ts
git commit -m "feat(keri): KERIClient wrappers for group sync, registry adoption and member signing

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Replay with the replaying steward's own signature

**Files:**
- Create: `frontend/src/lib/keri/steward/replay.ts`
- Test: `frontend/tests/scripts/steward-replay.test.ts`

**Interfaces:**
- Consumes: `mergeSigs`, `ReplayFailed`.
- Produces:
  - `interface Anchor { raw: string; sad: Record<string, unknown>; sigs: string[] }`
  - `interface ReplayInput { kind: 'iss' | 'rev'; registry: string; acdc: Record<string, unknown>; event: Record<string, unknown>; anc: Anchor; issForRev?: { event: Record<string, unknown>; anc: Anchor } }`
  - `interface ReplayDeps { credentialState(registry: string, said: string): Promise<'iss' | 'rev' | null>; ownSigs(raw: string): Promise<string[]>; postIss(body: Record<string, unknown>): Promise<number>; deleteRev(said: string, body: Record<string, unknown>): Promise<number>; sync(): Promise<void>; keyState(): Promise<{ k: string[]; latestEstSn: number; memberKey: string }> }`
  - `cosignPolicy(ancSn: number, ks: { k: string[]; latestEstSn: number; memberKey: string }): { sign: boolean; skip: boolean }`
  - `replayAct(input: ReplayInput, deps: ReplayDeps): Promise<'applied' | 'already' | 'skipped'>`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, vi } from 'vitest';
import { replayAct, cosignPolicy, type ReplayDeps, type ReplayInput } from 'src/lib/keri/steward/replay';
import { ReplayFailed } from 'src/lib/keri/steward/errors';

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
const sig = (i: number) => `A${B64[i]}` + 's'.repeat(86);
const anc = (sn: number) => ({ raw: `{"s":"${sn.toString(16)}"}`, sad: { t: 'ixn', s: sn.toString(16), d: `EANC${sn}` }, sigs: [sig(1)] });
const iss: ReplayInput = { kind: 'iss', registry: 'EREG', acdc: { d: 'ECRED' }, event: { t: 'iss', d: 'EISS' }, anc: anc(9) };
const rev: ReplayInput = { kind: 'rev', registry: 'EREG', acdc: { d: 'ECRED' }, event: { t: 'rev', d: 'EREV' }, anc: anc(10),
  issForRev: { event: { t: 'iss', d: 'EISS' }, anc: anc(9) } };

function deps(over: Partial<ReplayDeps> = {}): ReplayDeps {
  return {
    credentialState: vi.fn(async () => null),
    ownSigs: vi.fn(async () => [sig(0)]),
    postIss: vi.fn(async () => 200),
    deleteRev: vi.fn(async () => 200),
    sync: vi.fn(async () => {}),
    keyState: async () => ({ k: ['DKEY0', 'DKEY1'], latestEstSn: 8, memberKey: 'DKEY0' }),
    ...over,
  };
}

describe('cosignPolicy', () => {
  it('signs ixns after the latest establishment event', () => {
    expect(cosignPolicy(9, { k: ['A', 'B'], latestEstSn: 8, memberKey: 'B' })).toEqual({ sign: true, skip: false });
  });
  it('does not sign older ixns, and a non-keys[0] steward still replays', () => {
    expect(cosignPolicy(5, { k: ['A', 'B'], latestEstSn: 8, memberKey: 'B' })).toEqual({ sign: false, skip: false });
  });
  it('keys[0] skips an older ixn it cannot sign (Review Focus 5)', () => {
    expect(cosignPolicy(5, { k: ['A', 'B'], latestEstSn: 8, memberKey: 'A' })).toEqual({ sign: false, skip: true });
  });
});

describe('replayAct', () => {
  it('posts the iss with the sender sigs merged with our own', async () => {
    const d = deps();
    await expect(replayAct(iss, d)).resolves.toBe('applied');
    const body = (d.postIss as any).mock.calls[0][0];
    expect(body.sigs).toEqual([sig(0), sig(1)]);
    expect(body.ixn).toEqual(iss.anc.sad);
  });
  it('is idempotent: already-applied state posts nothing (Review Focus 3)', async () => {
    const d = deps({ credentialState: async () => 'iss' });
    await expect(replayAct(iss, d)).resolves.toBe('already');
    expect(d.postIss).not.toHaveBeenCalled();
  });
  it('a rev already applied is "already"', async () => {
    await expect(replayAct(rev, deps({ credentialState: async () => 'rev' }))).resolves.toBe('already');
  });
  it('replays the issuance first when a rev arrives for an unknown credential', async () => {
    const d = deps();
    await expect(replayAct(rev, d)).resolves.toBe('applied');
    expect(d.postIss).toHaveBeenCalledTimes(1);
    expect(d.deleteRev).toHaveBeenCalledWith('ECRED', expect.objectContaining({ rev: rev.event }));
  });
  it('fails a rev for an unknown credential that carries no issuance', async () => {
    await expect(replayAct({ ...rev, issForRev: undefined }, deps())).rejects.toBeInstanceOf(ReplayFailed);
  });
  it('on 500 syncs and retries once, then succeeds', async () => {
    const post = vi.fn().mockResolvedValueOnce(500).mockResolvedValueOnce(200);
    const d = deps({ postIss: post });
    await expect(replayAct(iss, d)).resolves.toBe('applied');
    expect(d.sync).toHaveBeenCalledTimes(1);
    expect(post).toHaveBeenCalledTimes(2);
  });
  it('fails after the one retry', async () => {
    await expect(replayAct(iss, deps({ postIss: async () => 500 }))).rejects.toBeInstanceOf(ReplayFailed);
  });
  it('keys[0] skips without POSTing an ixn older than the last rotation (Review Focus 5)', async () => {
    const d = deps({ keyState: async () => ({ k: ['DKEY0', 'DKEY1'], latestEstSn: 12, memberKey: 'DKEY0' }) });
    await expect(replayAct(iss, d)).resolves.toBe('skipped');
    expect(d.postIss).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd frontend && npx vitest run --config vitest.config.ts tests/scripts/steward-replay.test.ts`
Expected: FAIL, "Failed to resolve import".

- [ ] **Step 3: Implement**

```ts
import { mergeSigs } from './sigs';
import { ReplayFailed } from './errors';

export interface Anchor { raw: string; sad: Record<string, unknown>; sigs: string[] }
export interface ReplayInput {
  kind: 'iss' | 'rev';
  registry: string;
  acdc: Record<string, unknown>;
  event: Record<string, unknown>;
  anc: Anchor;
  issForRev?: { event: Record<string, unknown>; anc: Anchor };
}
export interface ReplayDeps {
  credentialState(registry: string, said: string): Promise<'iss' | 'rev' | null>;
  ownSigs(raw: string): Promise<string[]>;
  postIss(body: Record<string, unknown>): Promise<number>;
  deleteRev(said: string, body: Record<string, unknown>): Promise<number>;
  sync(): Promise<void>;
  keyState(): Promise<{ k: string[]; latestEstSn: number; memberKey: string }>;
}

/**
 * Whether our signature over an ixn is valid (only after the group's latest
 * establishment event — our key is the current one), and whether we must skip:
 * keys[0] is the group's elected witnesser and parks a replay without its own
 * signature in an escrow it never leaves (spike round 1, route C).
 */
export function cosignPolicy(ancSn: number, ks: { k: string[]; latestEstSn: number; memberKey: string }) {
  const sign = ancSn > ks.latestEstSn;
  const isKeys0 = ks.k[0] === ks.memberKey;
  return { sign, skip: !sign && isKeys0 };
}

async function withRetry(call: () => Promise<number>, deps: ReplayDeps, what: string): Promise<void> {
  let status = await call();
  if (status >= 500) {
    await deps.sync();
    status = await call();
  }
  if (status < 200 || status >= 300) throw new ReplayFailed(`${what} → HTTP ${status}`);
}

async function signed(anc: Anchor, deps: ReplayDeps): Promise<string[] | null> {
  const policy = cosignPolicy(parseInt(String(anc.sad.s), 16), await deps.keyState());
  if (policy.skip) return null;
  return policy.sign ? mergeSigs(anc.sigs, await deps.ownSigs(anc.raw)) : anc.sigs;
}

/**
 * Re-create another steward's TEL event in OUR agent. A shared registry is
 * local to every agent that holds it, and keripy refuses inbound TEL events
 * for a local registry — so each steward's agent must apply each iss/rev
 * itself (spike rounds 1–2). Idempotent on the credential's TEL state.
 */
export async function replayAct(input: ReplayInput, deps: ReplayDeps): Promise<'applied' | 'already' | 'skipped'> {
  const said = String(input.acdc.d);
  const state = await deps.credentialState(input.registry, said);
  if (state === input.kind) return 'already';

  if (input.kind === 'rev' && state === null) {
    if (!input.issForRev) throw new ReplayFailed(`rev for ${said} but its issuance is unknown here`);
    const r = await replayAct({ kind: 'iss', registry: input.registry, acdc: input.acdc, event: input.issForRev.event, anc: input.issForRev.anc }, deps);
    if (r === 'skipped') return 'skipped';
  }

  const sigs = await signed(input.anc, deps);
  if (!sigs) return 'skipped';
  if (input.kind === 'iss') {
    await withRetry(() => deps.postIss({ acdc: input.acdc, iss: input.event, ixn: input.anc.sad, sigs }), deps, `iss ${said}`);
  } else {
    await withRetry(() => deps.deleteRev(said, { rev: input.event, ixn: input.anc.sad, sigs }), deps, `rev ${said}`);
  }
  return 'applied';
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `cd frontend && npx vitest run --config vitest.config.ts tests/scripts/steward-replay.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd /home/benz/Documents/1.projects/matou-app
git add frontend/src/lib/keri/steward/replay.ts frontend/tests/scripts/steward-replay.test.ts
git commit -m "feat(steward): replay a peer's iss/rev with our own signature, idempotent

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Replication messages, history planning and `KERIClient` send/replay bindings

**Files:**
- Create: `frontend/src/lib/keri/steward/replicate.ts`
- Modify: `frontend/src/lib/keri/client.ts` (add `sendOrgAct`, `replayOrgAct`, `pushOrgHistory`)
- Test: `frontend/tests/scripts/steward-replicate.test.ts`

**Interfaces:**
- Consumes: `telBundle`, `TelBundle`, `indexedSigs`, `replayAct`, `ReplayInput`, `ReplayDeps`, and the Task 5 wrappers.
- Produces:
  - `const ORG_ACT_ROUTES = ['/multisig/iss', '/multisig/rev'] as const`
  - `actEmbedParts(bundle: TelBundle, kind: 'iss' | 'rev'): Record<string, { sad: Record<string, unknown>; atc: string }>` (the embed key → event + attachment; `KERIClient` wraps each `sad` in `new Serder`)
  - `parseActExn(exn: { a?: { gid?: string }; e?: Record<string, unknown>; r?: string }, paths: Record<string, string>, org: { group: string; registry: string }): ReplayInput | null` (null = not ours; mark read and ignore)
  - `type SentLedger = Record<string, Record<string, 'iss' | 'rev'>>` (peer → credential SAID → latest kind sent)
  - `planHistoryPush(held: Array<{ said: string; revoked: boolean }>, peers: string[], ledger: SentLedger): Array<{ peer: string; said: string; kind: 'iss' | 'rev' }>`
  - `KERIClient.sendOrgAct(groupPrefix: string, credSaid: string, kind: 'iss' | 'rev', recipients?: string[]): Promise<void>`
  - `KERIClient.replayOrgAct(input: ReplayInput, groupPrefix: string): Promise<'applied' | 'already' | 'skipped'>`
  - `KERIClient.pushOrgHistory(groupPrefix: string, registry: string): Promise<number>` (count sent)

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest';
import { actEmbedParts, parseActExn, planHistoryPush } from 'src/lib/keri/steward/replicate';
import type { TelBundle } from 'src/lib/keri/steward/sigs';

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
const sig = (i: number) => `A${B64[i]}` + 's'.repeat(86);
const m = (event: Record<string, unknown>, attachment = '') => ({ event, eventRaw: JSON.stringify(event), attachment });
const bundle: TelBundle = {
  acdc: m({ d: 'ECRED', ri: 'EREG' }),
  iss: m({ t: 'iss', d: 'EISS', i: 'ECRED' }, '-GAB'),
  issAnc: m({ t: 'ixn', d: 'EA1', s: '9' }, `-AAB${sig(1)}`),
  rev: m({ t: 'rev', d: 'EREV', i: 'ECRED' }),
  revAnc: m({ t: 'ixn', d: 'EA2', s: 'a' }, `-AAB${sig(0)}`),
};
const org = { group: 'EGRP', registry: 'EREG' };

describe('actEmbedParts', () => {
  it('iss carries acdc, iss and the signed anc', () => {
    const e = actEmbedParts(bundle, 'iss');
    expect(Object.keys(e)).toEqual(['acdc', 'iss', 'anc']);
    expect(e.anc!.atc).toBe(`-AAB${sig(1)}`);
  });
  it('rev also carries the issuance so a receiver can replay it first', () => {
    expect(Object.keys(actEmbedParts(bundle, 'rev'))).toEqual(['acdc', 'iss', 'issanc', 'rev', 'anc']);
  });
});

describe('parseActExn', () => {
  const paths = { anc: `-AAB${sig(1)}`, issanc: `-AAB${sig(1)}` };
  const exn = (gid: string, ri: string, r = '/multisig/iss') => ({
    r, a: { gid },
    e: { acdc: { d: 'ECRED', ri }, iss: { t: 'iss', d: 'EISS' }, anc: { t: 'ixn', d: 'EA1', s: '9' }, d: 'EEMB' },
  });
  it('builds a ReplayInput for our group and registry', () => {
    const r = parseActExn(exn('EGRP', 'EREG'), paths, org)!;
    expect(r.kind).toBe('iss');
    expect(r.anc.sigs).toEqual([sig(1)]);
    expect(JSON.parse(r.anc.raw).d).toBe('EA1');
  });
  it('ignores another group (Review Focus 4)', () => {
    expect(parseActExn(exn('EOTHER', 'EREG'), paths, org)).toBeNull();
  });
  it('ignores another registry, e.g. a legacy per-steward one (Review Focus 4)', () => {
    expect(parseActExn(exn('EGRP', 'ESTEWARDREG'), paths, org)).toBeNull();
  });
});

describe('planHistoryPush', () => {
  it('sends each peer what it has not been sent, upgrading iss→rev', () => {
    const plan = planHistoryPush(
      [{ said: 'C1', revoked: false }, { said: 'C2', revoked: true }],
      ['P1', 'P2'],
      { P1: { C1: 'iss', C2: 'iss' } },
    );
    expect(plan).toEqual([
      { peer: 'P1', said: 'C2', kind: 'rev' },
      { peer: 'P2', said: 'C1', kind: 'iss' },
      { peer: 'P2', said: 'C2', kind: 'rev' },
    ]);
  });
  it('sends nothing twice', () => {
    expect(planHistoryPush([{ said: 'C1', revoked: false }], ['P1'], { P1: { C1: 'iss' } })).toEqual([]);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd frontend && npx vitest run --config vitest.config.ts tests/scripts/steward-replicate.test.ts`
Expected: FAIL, "Failed to resolve import".

- [ ] **Step 3: Implement `replicate.ts`**

```ts
import type { TelBundle } from './sigs';
import { indexedSigs } from './sigs';
import type { ReplayInput } from './replay';

export const ORG_ACT_ROUTES = ['/multisig/iss', '/multisig/rev'] as const;

type Part = { sad: Record<string, unknown>; atc: string };

/** Embeds for keripy's native group-issuance exns (spec §3.3). */
export function actEmbedParts(b: TelBundle, kind: 'iss' | 'rev'): Record<string, Part> {
  if (!b.iss || !b.issAnc) throw new Error(`credential ${b.acdc.event.d} export lacks its issuance`);
  const base: Record<string, Part> = { acdc: { sad: b.acdc.event, atc: '' }, iss: { sad: b.iss.event, atc: '' } };
  if (kind === 'iss') return { ...base, anc: { sad: b.issAnc.event, atc: b.issAnc.attachment } };
  if (!b.rev || !b.revAnc) throw new Error(`credential ${b.acdc.event.d} export lacks its revocation`);
  return { ...base, issanc: { sad: b.issAnc.event, atc: b.issAnc.attachment }, rev: { sad: b.rev.event, atc: '' }, anc: { sad: b.revAnc.event, atc: b.revAnc.attachment } };
}

const anchor = (sad: Record<string, unknown>, atc: string | undefined) =>
  ({ raw: JSON.stringify(sad), sad, sigs: atc ? indexedSigs(atc) : [] });

/** A peer's /multisig/iss|rev as a replay for OUR org group + registry; null = not ours. */
export function parseActExn(
  exn: { r?: string; a?: { gid?: string }; e?: Record<string, unknown> },
  paths: Record<string, string>,
  org: { group: string; registry: string },
): ReplayInput | null {
  const e = (exn.e ?? {}) as Record<string, Record<string, unknown> | undefined>;
  const acdc = e.acdc;
  if (exn.a?.gid !== org.group || !acdc || acdc.ri !== org.registry) return null;
  const kind = exn.r?.endsWith('/rev') ? 'rev' : 'iss';
  if (kind === 'iss') {
    if (!e.iss || !e.anc) return null;
    return { kind, registry: org.registry, acdc, event: e.iss, anc: anchor(e.anc, paths.anc) };
  }
  if (!e.rev || !e.anc) return null;
  return {
    kind, registry: org.registry, acdc, event: e.rev, anc: anchor(e.anc, paths.anc),
    issForRev: e.iss && e.issanc ? { event: e.iss, anc: anchor(e.issanc, paths.issanc) } : undefined,
  };
}

export type SentLedger = Record<string, Record<string, 'iss' | 'rev'>>;

/** What each peer still needs from our held credentials (spec §3.5). */
export function planHistoryPush(
  held: Array<{ said: string; revoked: boolean }>,
  peers: string[],
  ledger: SentLedger,
): Array<{ peer: string; said: string; kind: 'iss' | 'rev' }> {
  const out: Array<{ peer: string; said: string; kind: 'iss' | 'rev' }> = [];
  for (const peer of peers) {
    for (const c of held) {
      const want = c.revoked ? 'rev' : 'iss';
      const sent = ledger[peer]?.[c.said];
      if (sent === want || sent === 'rev') continue;
      out.push({ peer, said: c.said, kind: want });
    }
  }
  return out;
}
```

`anchor()` reproduces the raw text with `JSON.stringify(sad)`. KERI events are compact JSON with stable key order, so it matches the signed bytes. `pushKelToAgent` already relies on the same property.

- [ ] **Step 4: Run the unit test to verify it passes**

Run: `cd frontend && npx vitest run --config vitest.config.ts tests/scripts/steward-replicate.test.ts`
Expected: PASS.

- [ ] **Step 5: Add the `KERIClient` bindings (after the Task 5 wrappers)**

```ts
  /** Send our act on credSaid to the other signers over /multisig/iss|rev. Best-effort per recipient. */
  async sendOrgAct(groupPrefix: string, credSaid: string, kind: 'iss' | 'rev', recipients?: string[]): Promise<void> {
    if (!this.client) throw new Error('Not initialized');
    const { telBundle } = await import('src/lib/keri/steward/sigs');
    const { actEmbedParts } = await import('src/lib/keri/steward/replicate');
    const signify = await import('signify-ts');
    const targets = recipients ?? await this.otherGroupSigners(groupPrefix);
    if (targets.length === 0) return;
    const parts = actEmbedParts(telBundle(await this.exportCredential(credSaid), credSaid), kind);
    const embeds: Record<string, [InstanceType<typeof signify.Serder>, string]> = {};
    for (const [k, p] of Object.entries(parts)) embeds[k] = [new signify.Serder(p.sad as never), p.atc];
    const hab = await this.client.identifiers().get(groupPrefix) as { group?: { mhab?: Record<string, unknown> } };
    const mhab = hab.group?.mhab;
    if (!mhab) return;
    for (const to of targets) {
      try {
        await this.client.exchanges().send(String(mhab.name ?? mhab.prefix), groupPrefix, mhab as never,
          `/multisig/${kind}`, { gid: groupPrefix }, embeds as never, [to]);
      } catch (err) {
        console.warn(`[KERIClient] /multisig/${kind} for ${credSaid.slice(0, 12)}... to ${to.slice(0, 12)}... failed:`, err);
      }
    }
    console.log(`[KERIClient] /multisig/${kind} for ${credSaid.slice(0, 12)}... sent to ${targets.length} steward(s)`);
  }

  /** Apply a peer's act to our agent (spec §3.4). */
  async replayOrgAct(input: import('src/lib/keri/steward/replay').ReplayInput, groupPrefix: string) {
    if (!this.client) throw new Error('Not initialized');
    const client = this.client;
    const { replayAct } = await import('src/lib/keri/steward/replay');
    const statusOf = async (p: Promise<unknown>): Promise<number> => {
      try { await p; return 200; } catch (err) {
        const m = /\s-\s(\d{3})\s-\s/.exec(err instanceof Error ? err.message : String(err));
        return m ? Number(m[1]) : 599;
      }
    };
    const keeperParams = async () => {
      const hab = await client.identifiers().get(groupPrefix);
      const k = client.manager!.get(hab);
      return { [k.algo]: k.params() };
    };
    return replayAct(input, {
      credentialState: async (ri, said) => {
        try {
          const st = await client.credentials().state(ri, said) as { et?: string };
          return st.et === 'rev' || st.et === 'brv' ? 'rev' : st.et ? 'iss' : null;
        } catch { return null; }
      },
      ownSigs: (raw) => this.signAsGroupMember(groupPrefix, raw),
      postIss: async (body) => statusOf(client.fetch(`/identifiers/${groupPrefix}/credentials`, 'POST', { ...body, ...(await keeperParams()) })),
      deleteRev: async (said, body) => statusOf(client.fetch(`/identifiers/${groupPrefix}/credentials/${said}`, 'DELETE', { ...body, ...(await keeperParams()) })),
      sync: async () => { await this.syncGroupFromWitnesses(groupPrefix); },
      keyState: () => this.groupKeyState(groupPrefix),
    });
  }

  /** Send the other signers any org-registry credential we hold they have not been sent (spec §3.5). */
  async pushOrgHistory(groupPrefix: string, registry: string): Promise<number> {
    if (!this.client) throw new Error('Not initialized');
    const { planHistoryPush } = await import('src/lib/keri/steward/replicate');
    const { secureStorage } = await import('src/lib/secureStorage');
    const key = `matou_org_acts_sent:${groupPrefix}`;
    const ledger = JSON.parse((await secureStorage.getItem(key)) || '{}');
    const creds = await this.client.credentials().list() as Array<{ sad: { d: string; ri?: string; i?: string }; status?: { et?: string } }>;
    const held = creds
      .filter((c) => c.sad.ri === registry && c.sad.i === groupPrefix)
      .map((c) => ({ said: c.sad.d, revoked: c.status?.et === 'rev' || c.status?.et === 'brv' }));
    const plan = planHistoryPush(held, await this.otherGroupSigners(groupPrefix), ledger);
    for (const step of plan) {
      await this.sendOrgAct(groupPrefix, step.said, step.kind, [step.peer]);
      (ledger[step.peer] ??= {})[step.said] = step.kind;
      await secureStorage.setItem(key, JSON.stringify(ledger));
    }
    if (plan.length) console.log(`[KERIClient] org history: ${plan.length} act(s) pushed to peer stewards`);
    return plan.length;
  }
```

Note: `sendOrgAct` records nothing in the ledger. The live-act path (Task 8) records its own sends, so the next history push doesn't resend them.

- [ ] **Step 6: Prove it end-to-end on KERIA 0.4.0**

Replace the gate block's manual `exchanges().send(...)` + `replayIss` in `steward-peer.infra.ts` with the module path. Construct a real `KERIClient`-equivalent by calling the pure modules with the same deps the wrappers build (copy the dep objects from Step 5, with `client` = `member` / `admin`). Assert:
- `member issues X → sendOrgAct → admin replayOrgAct(parseActExn(getRequest(note.a.d)))` gives `applied` then `et=iss` on the admin.
- `admin revokes X → sendOrgAct rev → member replayOrgAct` gives `et=rev` on the member.
- The same `/multisig/iss` delivered twice gives `already` the second time.

Run the harness. Expected: every row PASSes.

- [ ] **Step 7: Commit**

```bash
cd /home/benz/Documents/1.projects/matou-app
git add frontend/src/lib/keri/steward/replicate.ts frontend/src/lib/keri/client.ts frontend/tests/scripts/steward-replicate.test.ts frontend/tests/infra/steward-peer.infra.ts
git commit -m "feat(steward): replicate acts over native /multisig/iss|rev; history pushed by its holder

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: Group preflight and replication inside `issueCredential` / `revokeCredential`; one org registry; group-AID resolution

**Files:**
- Modify: `frontend/src/lib/keri/client.ts` (`issueCredential` ~2742, `revokeCredential` ~3006, `pushGroupKelToOtherMembers` ~786)
- Modify: `frontend/src/lib/keri/registry.ts`
- Modify: `frontend/src/composables/useAdminActions.ts:171-224`
- Test: `frontend/tests/scripts/admin-actions-org-aid.test.ts`

**Interfaces:**
- Consumes: `syncGroupFromWitnesses`, `ensureOrgRegistryAdopted`, `sendOrgAct`, `otherGroupSigners`, `NotJoined`.
- Produces:
  - `resolveIssuingRegistry(orgAidName: string): Promise<string>`, now the single org registry on every backend (same signature).
  - `resolveOrgRegistryId(): Promise<string>` exported from `registry.ts` (IDSS: `community.registry`; legacy: org config `registry.id`).
  - `getOrgAidName()` throws `NotJoined` instead of falling back.
  - Group issue/revoke now **throws** `GroupBehind` / `GroupDiverged` / `NotJoined` / `RegistryNotAdopted` before anchoring anything.

- [ ] **Step 1: Write the failing test for `getOrgAidName`**

`getOrgAidName` is internal to `useAdminActions`. Extract it into an exported helper `resolveOrgGroupPrefix(client, config, storedOrgAid)` in `useAdminActions.ts` and test that:

```ts
import { describe, it, expect } from 'vitest';
import { resolveOrgGroupPrefix } from 'src/composables/useAdminActions';
import { NotJoined } from 'src/lib/keri/steward/errors';

const client = (aids: Array<{ name: string; prefix: string }>) => ({ identifiers: () => ({ list: async () => ({ aids }) }) });

describe('resolveOrgGroupPrefix', () => {
  it('returns the org AID from config when the wallet holds it', async () => {
    const c = client([{ name: 'me', prefix: 'EME' }, { name: 'matou', prefix: 'EGRP' }]);
    await expect(resolveOrgGroupPrefix(c as never, { organization: { aid: 'EGRP' } } as never, null)).resolves.toBe('EGRP');
  });
  it('falls back to the stored org AID', async () => {
    const c = client([{ name: 'matou', prefix: 'EGRP' }]);
    await expect(resolveOrgGroupPrefix(c as never, null, 'EGRP')).resolves.toBe('EGRP');
  });
  it('never returns a personal AID — throws NotJoined (e2e test 2 false green)', async () => {
    const c = client([{ name: 'matou-member', prefix: 'EME' }]);
    await expect(resolveOrgGroupPrefix(c as never, { organization: { aid: 'EGRP' } } as never, null)).rejects.toBeInstanceOf(NotJoined);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd frontend && npx vitest run --config vitest.config.ts tests/scripts/admin-actions-org-aid.test.ts`
Expected: FAIL, "resolveOrgGroupPrefix is not exported".

- [ ] **Step 3: Replace `getOrgAidName` in `useAdminActions.ts`**

Add at module level (outside `useAdminActions()`):

```ts
import { NotJoined } from 'src/lib/keri/steward/errors';

/**
 * The org group AID's prefix IF this wallet holds the group identifier. Never
 * a personal AID: the old name-pattern fallback made a not-yet-joined steward
 * issue memberships from their own identity (registration e2e, 2026-09-30).
 */
export async function resolveOrgGroupPrefix(
  client: { identifiers(): { list(): Promise<{ aids?: Array<{ prefix: string }> }> } },
  config: { organization?: { aid?: string } } | null,
  storedOrgAid: string | null,
): Promise<string> {
  const aids = (await client.identifiers().list()).aids ?? [];
  for (const want of [config?.organization?.aid, storedOrgAid]) {
    if (want && aids.some((a) => a.prefix === want)) return want;
  }
  throw new NotJoined(`wallet holds no identifier for org ${config?.organization?.aid ?? storedOrgAid ?? '(unknown)'}`);
}
```

Replace the body of `getOrgAidName()` (lines 171-224) with:

```ts
  async function getOrgAidName(): Promise<string> {
    const client = keriClient.getSignifyClient();
    if (!client) throw new Error('Not connected to KERIA');
    let config = null;
    try {
      const r = await fetchOrgConfig();
      config = r.status === 'configured' ? r.config : r.status === 'server_unreachable' ? r.cached : null;
    } catch { /* fall through to stored */ }
    return resolveOrgGroupPrefix(client, config, await secureStorage.getItem('matou_org_aid'));
  }
```

- [ ] **Step 4: Run it to verify it passes**

Run: `cd frontend && npx vitest run --config vitest.config.ts tests/scripts/admin-actions-org-aid.test.ts tests/scripts/admin-actions-idss-membership.test.ts`
Expected: PASS. If `admin-actions-idss-membership.test.ts` mocked the fallback, update its fixture so the wallet holds the org AID.

- [ ] **Step 5: One org registry in `registry.ts`**

Replace `getOrCreateOrgRegistry` and `resolveIssuingRegistry` (lines 39-108) with:

```ts
/**
 * The ONE registry every steward issues memberships into (spec §2):
 * `community.registry` on IDSS, the org config's `registry.id` on legacy.
 * Per-steward registries are gone — each steward's agent ADOPTS this one
 * (KERIClient.ensureOrgRegistryAdopted).
 */
export async function resolveOrgRegistryId(): Promise<string> {
  try {
    const descriptor = await getCommunityDescriptor();
    if (descriptor.backend_kind === BACKEND_KIND_IDSS) {
      const reg = descriptor.community?.registry ?? '';
      if (!reg) throw new Error('IDSS backend descriptor names no community.registry (ADR 0235 decision 4).');
      return reg;
    }
  } catch (err) {
    if (err instanceof Error && err.message.includes('community.registry')) throw err;
  }
  const { fetchOrgConfig } = await import('src/api/config');
  const r = await fetchOrgConfig();
  const config = r.status === 'configured' ? r.config : r.status === 'server_unreachable' ? r.cached : null;
  const id = config?.registry?.id;
  if (!id) throw new Error('Org config names no registry — cannot issue membership credentials.');
  return id;
}

/** Kept for call sites: the org registry, regardless of which steward asks. */
export async function resolveIssuingRegistry(_orgAidName: string): Promise<string> {
  return resolveOrgRegistryId();
}
```

Delete `getOrCreateOrgRegistry`. Run `grep -rn getOrCreateOrgRegistry frontend/src frontend/tests` and remove any remaining imports.

- [ ] **Step 6: Group preflight + replication in `issueCredential`**

In `client.ts` `issueCredential`, right after `issuerAid` is resolved (before `credentials().issue`), insert:

```ts
    const isGroup = !!(issuerAid as { group?: unknown }).group;
    if (isGroup) {
      // Fork guard + registry (spec §4.1): refuse BEFORE anything is anchored.
      await this.syncGroupFromWitnesses(issuerAid.prefix);
      await this.ensureOrgRegistryAdopted(issuerAid.prefix, registryId);
    }
```

Replace the existing `pushGroupKelToOtherMembers(...)` call inside the `if (group)` block (after `awaitGroupAnchorWitnessed`) with:

```ts
      await this.pushGroupKelToOtherMembers(issuerAid.prefix, (issuerAid as { group?: { mhab?: { prefix?: string } } }).group?.mhab?.prefix);
      await this.sendOrgActRecorded(issuerAid.prefix, credentialSaid, 'iss');
```

Add a private helper that sends and records in the history ledger, so `pushOrgHistory` does not resend:

```ts
  private async sendOrgActRecorded(groupPrefix: string, said: string, kind: 'iss' | 'rev'): Promise<void> {
    try {
      const peers = await this.otherGroupSigners(groupPrefix);
      await this.sendOrgAct(groupPrefix, said, kind, peers);
      const { secureStorage } = await import('src/lib/secureStorage');
      const key = `matou_org_acts_sent:${groupPrefix}`;
      const ledger = JSON.parse((await secureStorage.getItem(key)) || '{}');
      for (const p of peers) (ledger[p] ??= {})[said] = kind;
      await secureStorage.setItem(key, JSON.stringify(ledger));
    } catch (err) {
      console.warn('[KERIClient] org act replication failed (history push will retry):', err);
    }
  }
```

- [ ] **Step 7: Group preflight + replication in `revokeCredential`**

Replace the body of `revokeCredential` with:

```ts
    if (!this.client) throw new Error('Not initialized');
    await this.ensureConnected();
    let issuer: { prefix: string; group?: unknown };
    try { issuer = await this.client.identifiers().get(issuerAidName) as typeof issuer; }
    catch { throw new Error(`Issuer AID "${issuerAidName}" not found`); }
    if (issuer.group) await this.syncGroupFromWitnesses(issuer.prefix);

    console.log(`[KERIClient] Revoking credential ${credentialSaid}...`);
    const result = await this.client.credentials().revoke(issuerAidName, credentialSaid);
    await this.client.operations().wait(result.op, { signal: AbortSignal.timeout(60000) });

    if (issuer.group) {
      const ancSaid = (result.anc as { said?: string; sad?: { d?: string } } | undefined)?.said
        ?? (result.anc as { sad?: { d?: string } } | undefined)?.sad?.d;
      if (ancSaid) await this.awaitGroupAnchorWitnessed(ancSaid, { label: 'revocation' });
      await this.pushGroupKelToOtherMembers(issuer.prefix, (issuer as { group?: { mhab?: { prefix?: string } } }).group?.mhab?.prefix);
      await this.sendOrgActRecorded(issuer.prefix, credentialSaid, 'rev');
    }
    console.log(`[KERIClient] Credential ${credentialSaid} revoked`);
```

- [ ] **Step 8: Group KEL push targets from the signers**

In `pushGroupKelToOtherMembers`, replace the org-config target block with:

```ts
      let targets: string[] = [];
      try {
        targets = await this.otherGroupSigners(groupAidPrefix);
      } catch (err) {
        console.warn('[KERIClient] Group KEL push: signer lookup failed, falling back to org-config admins:', err);
        const { fetchOrgConfig } = await import('../../api/config');
        const result = await fetchOrgConfig();
        const config = result.status === 'configured' ? result.config : result.status === 'server_unreachable' ? result.cached : null;
        targets = selectGroupKelPushTargets((config?.admins ?? []).map((a) => a.aid), groupAidPrefix, actingMemberAid);
      }
```

Leave the per-target push loop below unchanged.

- [ ] **Step 9: Type-check, lint, and run the unit suite**

Run:
```bash
cd frontend && npx vue-tsc --noEmit -p tsconfig.json && npx eslint src/lib/keri src/composables/useAdminActions.ts && npx vitest run --config vitest.config.ts
```
Expected: no type errors, and every test file passes. Fix any test that stubbed `getOrCreateOrgRegistry` or the personal-AID fallback.

- [ ] **Step 10: Commit**

```bash
cd /home/benz/Documents/1.projects/matou-app
git add frontend/src/lib/keri/client.ts frontend/src/lib/keri/registry.ts frontend/src/composables/useAdminActions.ts frontend/tests/scripts
git commit -m "feat(steward): sync+adopt before every group act, replicate after; one org registry; no personal-AID fallback

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: Replay inbox, steward readiness and the Approve gate

**Files:**
- Create: `frontend/src/composables/useOrgActInbox.ts`
- Create: `frontend/src/composables/useStewardReadiness.ts`
- Modify: `frontend/src/pages/DashboardPage.vue` (start both for stewards; pass the readiness reason to `ProfileModal`)
- Modify: `frontend/src/components/profiles/ProfileModal.vue:304-312` (disable Approve with a reason)
- Test: `frontend/tests/scripts/org-act-inbox.test.ts`

**Interfaces:**
- Consumes: `ORG_ACT_ROUTES`, `parseActExn`, `KERIClient.replayOrgAct`, `syncGroupFromWitnesses`, `ensureOrgRegistryAdopted`, `pushOrgHistory`, `resolveOrgRegistryId`, `useKERINotificationService`, `StewardRefusal`.
- Produces:
  - `useOrgActInbox(): { pending: Ref<number>; lastError: Ref<string | null>; drain(): Promise<void>; start(): void; stop(): void }`
  - `useStewardReadiness(): { ready: Ref<boolean>; reason: Ref<string | null>; ensureReady(): Promise<boolean> }`
  - `processOrgActNotes(notes, deps): Promise<{ applied: number; failed: number }>` exported from `useOrgActInbox.ts` for testing.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, vi } from 'vitest';
import { processOrgActNotes } from 'src/composables/useOrgActInbox';

const note = (i: string, r = '/multisig/iss', read = false) => ({ i, r: read, a: { r, d: `EX${i}` } });

describe('processOrgActNotes', () => {
  const org = { group: 'EGRP', registry: 'EREG' };
  const exnFor = (gid: string) => ({ exn: { r: '/multisig/iss', a: { gid }, e: { acdc: { d: 'EC', ri: 'EREG' }, iss: { t: 'iss' }, anc: { t: 'ixn', s: '9' } } }, paths: { anc: '-AAB' + 'AB' + 's'.repeat(86) } });

  it('replays ours oldest-first and marks each read after success', async () => {
    const mark = vi.fn(async () => {});
    const replay = vi.fn(async () => 'applied' as const);
    const res = await processOrgActNotes([note('1'), note('2')], { org, getRequest: async () => [exnFor('EGRP')], replay, mark });
    expect(res).toEqual({ applied: 2, failed: 0 });
    expect(mark.mock.calls.map((c) => c[0])).toEqual(['1', '2']);
  });
  it('marks a foreign group act read without replaying (Review Focus 4)', async () => {
    const mark = vi.fn(async () => {});
    const replay = vi.fn();
    await processOrgActNotes([note('1')], { org, getRequest: async () => [exnFor('EOTHER')], replay, mark });
    expect(replay).not.toHaveBeenCalled();
    expect(mark).toHaveBeenCalledWith('1');
  });
  it('leaves a failed replay unread and counts it', async () => {
    const mark = vi.fn(async () => {});
    const res = await processOrgActNotes([note('1')], { org, getRequest: async () => [exnFor('EGRP')], replay: async () => { throw new Error('boom'); }, mark });
    expect(res.failed).toBe(1);
    expect(mark).not.toHaveBeenCalled();
  });
  it('ignores read notes and other routes', async () => {
    const replay = vi.fn();
    await processOrgActNotes([note('1', '/multisig/iss', true), note('2', '/multisig/rot')], { org, getRequest: async () => [], replay, mark: async () => {} });
    expect(replay).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd frontend && npx vitest run --config vitest.config.ts tests/scripts/org-act-inbox.test.ts`
Expected: FAIL, "Failed to resolve import".

- [ ] **Step 3: Implement `useOrgActInbox.ts`**

```ts
import { ref, watch } from 'vue';
import { useKERIClient } from 'src/lib/keri/client';
import { useKERINotificationService } from 'src/composables/useKERINotificationService';
import { ORG_ACT_ROUTES, parseActExn } from 'src/lib/keri/steward/replicate';
import type { ReplayInput } from 'src/lib/keri/steward/replay';
import { resolveOrgRegistryId } from 'src/lib/keri/registry';
import { secureStorage } from 'src/lib/secureStorage';

type Note = { i: string; r: boolean; a?: { r?: string; d?: string } };
export interface InboxDeps {
  org: { group: string; registry: string };
  getRequest(said: string): Promise<Array<{ exn: Record<string, unknown>; paths: Record<string, string> }>>;
  replay(input: ReplayInput): Promise<'applied' | 'already' | 'skipped'>;
  mark(noteId: string): Promise<void>;
}

/** Apply unread /multisig/iss|rev notes oldest-first; act-then-mark (notifications.ts invariant). */
export async function processOrgActNotes(notes: Note[], deps: InboxDeps): Promise<{ applied: number; failed: number }> {
  let applied = 0; let failed = 0;
  for (const n of notes) {
    if (n.r || !ORG_ACT_ROUTES.includes(n.a?.r as never) || !n.a?.d) continue;
    try {
      const [req] = await deps.getRequest(n.a.d);
      const input = req ? parseActExn(req.exn as never, req.paths ?? {}, deps.org) : null;
      if (!input) { await deps.mark(n.i); continue; }
      const out = await deps.replay(input);
      if (out === 'skipped') console.warn(`[OrgActInbox] skipped ${input.kind} for ${String(input.acdc.d).slice(0, 12)}... (predates our last rotation)`);
      await deps.mark(n.i);
      applied++;
    } catch (err) {
      failed++;
      console.warn('[OrgActInbox] replay failed, left unread:', err);
    }
  }
  return { applied, failed };
}

export function useOrgActInbox() {
  const keriClient = useKERIClient();
  const notes = useKERINotificationService();
  const pending = ref(0);
  const lastError = ref<string | null>(null);
  let running: Promise<void> | null = null;
  let stopWatch: (() => void) | null = null;

  async function drainOnce(): Promise<void> {
    const client = keriClient.getSignifyClient();
    const group = await secureStorage.getItem('matou_org_aid');
    if (!client || !group) return;
    const org = { group, registry: await resolveOrgRegistryId() };
    const list = (notes.notifications.value as Note[]).filter((n) => !n.r && ORG_ACT_ROUTES.includes(n.a?.r as never));
    pending.value = list.length;
    if (list.length === 0) return;
    await keriClient.syncGroupFromWitnesses(group);
    const res = await processOrgActNotes(list, {
      org,
      getRequest: async (said) => await client.groups().getRequest(said) as never,
      replay: (input) => keriClient.replayOrgAct(input, group),
      mark: async (id) => { await keriClient.markNotificationRead(id); },
    });
    pending.value = res.failed;
    lastError.value = res.failed ? `${res.failed} change(s) from other stewards not applied yet` : null;
  }

  /** Single-flight: concurrent callers share one pass. */
  function drain(): Promise<void> {
    running ??= drainOnce().finally(() => { running = null; });
    return running;
  }

  function start(): void {
    if (stopWatch) return;
    void drain();
    stopWatch = watch(() => notes.lastFetchTime.value, () => { void drain(); });
  }
  function stop(): void { stopWatch?.(); stopWatch = null; }

  return { pending, lastError, drain, start, stop };
}
```

If `keriClient.markNotificationRead` isn't the method name, use the one `useMultisigJoin.ts` calls (`keriClient.markNotificationRead(notification.i)`); it is.

- [ ] **Step 4: Implement `useStewardReadiness.ts`**

```ts
import { ref } from 'vue';
import { useKERIClient } from 'src/lib/keri/client';
import { resolveOrgRegistryId } from 'src/lib/keri/registry';
import { secureStorage } from 'src/lib/secureStorage';
import { StewardRefusal } from 'src/lib/keri/steward/errors';

/** joined + synced + registry adopted, then history pushed (spec §3.6). */
export function useStewardReadiness() {
  const keriClient = useKERIClient();
  const ready = ref(false);
  const reason = ref<string | null>('Checking your steward setup…');

  async function ensureReady(): Promise<boolean> {
    try {
      const group = await secureStorage.getItem('matou_org_aid');
      if (!group) throw new StewardRefusal('no org AID stored', "You're still being set up as a steward — finish joining before approving.");
      await keriClient.groupMemberAid(group);                 // NotJoined
      await keriClient.syncGroupFromWitnesses(group);         // GroupBehind / GroupDiverged
      const registry = await resolveOrgRegistryId();
      await keriClient.ensureOrgRegistryAdopted(group, registry); // RegistryNotAdopted
      ready.value = true;
      reason.value = null;
      void keriClient.pushOrgHistory(group, registry).catch((e) => console.warn('[StewardReadiness] history push failed:', e));
      return true;
    } catch (err) {
      ready.value = false;
      reason.value = err instanceof StewardRefusal ? err.userMessage : `Steward setup check failed: ${err instanceof Error ? err.message : String(err)}`;
      console.warn('[StewardReadiness]', err);
      return false;
    }
  }
  return { ready, reason, ensureReady };
}
```

- [ ] **Step 5: Wire into `DashboardPage.vue`**

In `<script setup>`, next to the other composables:

```ts
import { useOrgActInbox } from 'src/composables/useOrgActInbox';
import { useStewardReadiness } from 'src/composables/useStewardReadiness';
const orgActInbox = useOrgActInbox();
const stewardReadiness = useStewardReadiness();
```

In `onMounted`, inside `if (isSteward.value) { startPolling(); }`, add after `startPolling()`:

```ts
    orgActInbox.start();
    void stewardReadiness.ensureReady();
```

Add the same two lines inside the `watch(hasJoinedMultisig, …)` block after its `startPolling()`. Add `orgActInbox.stop();` to `onUnmounted`.

Where `ProfileModal` is rendered with `:isSteward="isSteward"` (line ~214), add:

```vue
      :stewardBlockedReason="stewardReadiness.ready.value ? null : stewardReadiness.reason.value"
```

- [ ] **Step 6: Gate Approve in `ProfileModal.vue`**

Add the prop to the props interface (~line 463) and its default:

```ts
  stewardBlockedReason?: string | null;
```
```ts
  stewardBlockedReason: null,
```

Change the Approve button (lines 304-312) to add `:disabled="!!props.stewardBlockedReason"`, and below the button add:

```vue
              <p v-if="props.isSteward && registration && requirementsMet && props.stewardBlockedReason" class="steward-blocked" data-testid="steward-blocked-reason">
                {{ props.stewardBlockedReason }}
              </p>
```

Add the style in the component's `<style>` block, using the existing muted-text token:

```scss
.steward-blocked { font-size: 0.85rem; opacity: 0.8; margin-top: 0.25rem; }
```

- [ ] **Step 7: Run tests, types and lint**

Run: `cd frontend && npx vitest run --config vitest.config.ts tests/scripts/org-act-inbox.test.ts && npx vue-tsc --noEmit -p tsconfig.json && npx eslint src/composables/useOrgActInbox.ts src/composables/useStewardReadiness.ts src/pages/DashboardPage.vue src/components/profiles/ProfileModal.vue`
Expected: PASS, no errors.

- [ ] **Step 8: Commit**

```bash
cd /home/benz/Documents/1.projects/matou-app
git add frontend/src/composables/useOrgActInbox.ts frontend/src/composables/useStewardReadiness.ts frontend/src/pages/DashboardPage.vue frontend/src/components/profiles/ProfileModal.vue frontend/tests/scripts/org-act-inbox.test.ts
git commit -m "feat(steward): replay inbox for peer acts, readiness check gates Approve

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 10: Multisig join fixes: one rotation per proposal, in-flight guard, witness sync, drain before rotating

**Files:**
- Modify: `frontend/src/lib/keri/multisigRound.ts` (add `isInitiatorExn`, `rotationSaidOf`)
- Modify: `frontend/src/composables/useMultisigJoin.ts`
- Modify: `frontend/src/composables/useMultisigRotationSignal.ts` (drain before the per-round rotation)
- Modify: `frontend/src/composables/useAdminActions.ts` (promotion start: sync + drain)
- Test: `frontend/tests/scripts/multisig-join-dedupe.test.ts`

**Interfaces:**
- Consumes: `syncGroupFromWitnesses`, `useOrgActInbox().drain`.
- Produces:
  - `isInitiatorExn(exn: { i?: string; a?: { smids?: string[] } }): boolean` (sender === `smids[0]`)
  - `rotationSaidOf(exn: { e?: { rot?: { d?: string } } }): string | undefined`
  - `shouldRotateForRound1(exn, handled: Set<string>): { rotate: boolean; said?: string }`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest';
import { isInitiatorExn, rotationSaidOf, shouldRotateForRound1 } from 'src/lib/keri/multisigRound';

const exn = (i: string, rot: string) => ({ i, a: { smids: ['EADMIN', 'ESTEWARD1'], rmids: ['EADMIN', 'ESTEWARD1', 'EJOINER'], round: 'round-1' }, e: { rot: { d: rot, s: '9' } } });

describe('round-1 dedupe (registration e2e test 5, 2026-09-30)', () => {
  it('the initiator is smids[0]', () => {
    expect(isInitiatorExn(exn('EADMIN', 'EROT'))).toBe(true);
    expect(isInitiatorExn(exn('ESTEWARD1', 'EROT'))).toBe(false);
  });
  it('reads the embedded rotation SAID', () => {
    expect(rotationSaidOf(exn('EADMIN', 'EROT'))).toBe('EROT');
  });
  it('rotates once for the initiator, never for a co-signer forward of the same proposal', () => {
    const handled = new Set<string>();
    expect(shouldRotateForRound1(exn('EADMIN', 'EROT'), handled)).toEqual({ rotate: true, said: 'EROT' });
    handled.add('EROT');
    expect(shouldRotateForRound1(exn('ESTEWARD1', 'EROT'), handled)).toEqual({ rotate: false, said: 'EROT' });
    expect(shouldRotateForRound1(exn('EADMIN', 'EROT'), handled)).toEqual({ rotate: false, said: 'EROT' });
  });
  it('a co-signer forward of an unseen proposal does not rotate either', () => {
    expect(shouldRotateForRound1(exn('ESTEWARD1', 'EROT2'), new Set())).toEqual({ rotate: false, said: 'EROT2' });
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd frontend && npx vitest run --config vitest.config.ts tests/scripts/multisig-join-dedupe.test.ts`
Expected: FAIL, "isInitiatorExn is not exported".

- [ ] **Step 3: Implement in `multisigRound.ts`**

Append:

```ts
/** The promotion's initiator is by convention smids[0]; a co-signer's forwarded /multisig/rot has another sender. */
export function isInitiatorExn(exn: { i?: string; a?: { smids?: unknown } }): boolean {
  const smids = Array.isArray(exn?.a?.smids) ? (exn.a!.smids as string[]) : [];
  return !!exn?.i && exn.i === smids[0];
}

export function rotationSaidOf(exn: { e?: { rot?: { d?: string } } }): string | undefined {
  return exn?.e?.rot?.d;
}

/**
 * The joining member rotates its personal AID ONCE per proposed group
 * rotation — on the initiator's exn only. A co-signer forwards the same
 * proposal (d29ab75); treating that as a new round 1 rotated member2 three
 * times while round 2 committed its first new key (e2e test 5, 2026-09-30).
 */
export function shouldRotateForRound1(
  exn: { i?: string; a?: { smids?: unknown }; e?: { rot?: { d?: string } } },
  handled: Set<string>,
): { rotate: boolean; said?: string } {
  const said = rotationSaidOf(exn);
  if (!said || handled.has(said) || !isInitiatorExn(exn)) return { rotate: false, said };
  return { rotate: true, said };
}
```

- [ ] **Step 4: Apply it in `useMultisigJoin.ts`**

1. Add a module-level single-flight and a persisted handled set:

```ts
import { shouldRotateForRound1 } from 'src/lib/keri/multisigRound';
let inFlight: Promise<boolean> | null = null;
const HANDLED_KEY = 'matou_round1_rotations_handled';
async function loadHandled(): Promise<Set<string>> {
  try { return new Set(JSON.parse((await secureStorage.getItem(HANDLED_KEY)) || '[]')); } catch { return new Set(); }
}
async function saveHandled(s: Set<string>): Promise<void> {
  await secureStorage.setItem(HANDLED_KEY, JSON.stringify([...s].slice(-50)));
}
```

2. Rename the existing `checkAndJoinMultisig` function to `checkAndJoinMultisigOnce`, and add a guarded wrapper with the original name that `startPolling` and the return object use:

```ts
  function checkAndJoinMultisig(): Promise<boolean> {
    inFlight ??= checkAndJoinMultisigOnce().finally(() => { inFlight = null; });
    return inFlight;
  }
```

3. In the `round === 'round-1'` branch, replace the `embeddedSn` witness pull block and the `rotatePersonalAid` call with:

```ts
          const handled = await loadHandled();
          const decision = shouldRotateForRound1(exn as never, handled);
          if (!decision.rotate) {
            console.log(`[MultisigJoin] round-1 ${decision.said?.slice(0, 12) ?? '?'} already handled or not from the initiator — marking read`);
            await keriClient.markNotificationRead(notification.i);
            return false;
          }
          const personalName = aids.aids[0]?.name as string;
          await keriClient.rotatePersonalAid(personalName);
          handled.add(decision.said!);
          await saveHandled(handled);
          await keriClient.markNotificationRead(notification.i);
```

The group's round-1 rotation reaches the joiner through the admin's KEL push (`addMemberRound1`) and `joinGroup`'s own group resolve. Nothing here needs `queryKeyStateToSn`, which always timed out on KERIA.

4. After `round-2 done, joined` succeeds, before `return true`, add:

```ts
          try {
            await keriClient.syncGroupFromWitnesses(gid);
            const { resolveOrgRegistryId } = await import('src/lib/keri/registry');
            await keriClient.ensureOrgRegistryAdopted(gid, await resolveOrgRegistryId());
          } catch (readyErr) {
            console.warn('[MultisigJoin] post-join readiness incomplete (dashboard will retry):', readyErr);
          }
```

- [ ] **Step 5: Drain before rotating (co-signer) and before starting a promotion (promoter)**

In `useMultisigRotationSignal.ts`, immediately before the co-signer's own `rotatePersonalAid` call, add:

```ts
      const { useOrgActInbox } = await import('src/composables/useOrgActInbox');
      await useOrgActInbox().drain();
      const group = await secureStorage.getItem('matou_org_aid');
      if (group) await keriClient.syncGroupFromWitnesses(group);
```

If the drain throws, do NOT ack. The existing handler already doesn't ack on failure, so rethrow.

In `useAdminActions.ts` at the start of the steward-upgrade function (right after `const orgAidPrefix = await getOrgAidName();` at ~line 791), add:

```ts
      await keriClient.syncGroupFromWitnesses(orgAidPrefix);
      const { useOrgActInbox } = await import('src/composables/useOrgActInbox');
      await useOrgActInbox().drain();
```

- [ ] **Step 6: Run tests, types and lint**

Run: `cd frontend && npx vitest run --config vitest.config.ts && npx vue-tsc --noEmit -p tsconfig.json && npx eslint src/lib/keri/multisigRound.ts src/composables/useMultisigJoin.ts src/composables/useMultisigRotationSignal.ts src/composables/useAdminActions.ts`
Expected: PASS, no errors.

- [ ] **Step 7: Commit**

```bash
cd /home/benz/Documents/1.projects/matou-app
git add frontend/src/lib/keri/multisigRound.ts frontend/src/composables/useMultisigJoin.ts frontend/src/composables/useMultisigRotationSignal.ts frontend/src/composables/useAdminActions.ts frontend/tests/scripts/multisig-join-dedupe.test.ts
git commit -m "fix(multisig): joiner rotates once per proposal from the initiator; single-flight; sync+drain before rotating

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 11: Registration e2e asserts the issuer and cross-steward revoke; full run on elitebook-03

**Files:**
- Modify: `frontend/tests/e2e/e2e-registration.spec.ts` (test 2 ~line 861; a new test after test 5 ~line 1468)

**Interfaces:**
- Consumes: the existing e2e helpers in the spec file (`loadAccounts`, `backends.start`, `setupTestConfig`, `setupBackendRouting`, the KERIA helpers test 5 uses for `groupBefore/groupAfter`).
- Produces: nothing downstream.

- [ ] **Step 1: Assert the issuer in test 2**

After the log `[Test] User1 (upgraded steward) clicked Approve` and the wait for member2's credential, add. Use the same page-evaluate helper test 5 uses to read KERIA state; search the file for `groupAfter` to find it.

```ts
      const member2Cred = await user2Page.evaluate(async () => {
        const c = (window as any).__keriClient?.getSignifyClient?.();
        const list = await c.credentials().list();
        return list.map((x: any) => ({ d: x.sad.d, i: x.sad.i, ri: x.sad.ri }));
      });
      const orgAid = loadAccounts().orgAid ?? accounts.orgAid;
      expect(member2Cred.some((x: { i: string }) => x.i === orgAid), 'member2 Membership must be issued by the ORG GROUP AID, not a steward personal AID').toBe(true);
```

If the page exposes no KERIA client handle, reuse the mechanism the file already uses for `member2After.k`. If there's none, read the credential from the backend with `GET /api/v1/community/credentials` on user2's backend and assert `issuerAID === orgAid`. `orgAid` is stored in `test-accounts.json` by the org-setup project. If it isn't, read it from `GET /api/v1/org/config` → `organization.aid`.

- [ ] **Step 2: Add the cross-steward revoke test after test 5**

```ts
  test('stewards revoke each other\'s issuances', async ({ browser }) => {
    test.setTimeout(420_000);
    accounts = loadAccounts();
    test.skip(!accounts.member?.mnemonic || !accounts.member2?.mnemonic, 'needs tests 1-5');
    // 1. Admin issues a throwaway membership to a fresh registrant (reuse registerUser + admin approve helpers from test 1).
    // 2. member1 (steward) signs in; wait for [OrgActInbox] to apply the /multisig/iss (poll its credentials().state until et=iss).
    // 3. member1 revokes it through the member-removal UI (the same flow e2e-member-removal.spec.ts drives).
    // 4. Admin's agent: poll credentials().state(registry, said) until et === 'rev' (via its OrgActInbox).
    // 5. Reverse: member1 approves another fresh registrant; admin removes that member; member1's state shows 'rev'.
  });
```

Implement each numbered step with the existing helpers in this spec file and in `e2e-member-removal.spec.ts`. Copy the helper calls; don't import across spec files. Each "poll state" is a `expect.poll(async () => page.evaluate(...), { timeout: 120_000 }).toBe('rev')`.

- [ ] **Step 3: Run the registration project on elitebook-03**

Sync the branch to the e2e host, following the memory recipe: rsync excluding worktrees/node_modules/data/`client-test.yml`, and bundle the infra if needed. Then:

```bash
ssh swarm@100.98.240.186 'bash -s' <<'EOF'
flock -n /tmp/matou-swarm.lock -c true || { echo "slot busy"; exit 1; }
OUT=~/test5/reg-steward-peer; rm -rf $OUT; mkdir -p $OUT
nohup setsid flock -o /tmp/matou-swarm.lock bash -c "~/test5/clean-run.sh > $OUT/run.log 2>&1; docker logs matou-keri-test-keria-1 > $OUT/keria.log 2>&1; cp -r ~/test5/matou-app/frontend/tests/e2e/results $OUT/results 2>/dev/null; echo DONE > $OUT/done" >/dev/null 2>&1 </dev/null &
EOF
```

Expected: every registration test passes on the FIRST attempt, including test 2's issuer assertion, test 5, and the new test. Also grep the run log: `grep -c "Rotating Member2" run.log` should be 1 per round, `grep "MultisigJoin.*handler failed"` should be empty, and `grep "\[OrgActInbox\] replay failed"` should be empty. Afterwards, kill only the `~/test5` backend on 9080 (by exe path), as in `clean-run.sh`.

- [ ] **Step 4: Commit**

```bash
cd /home/benz/Documents/1.projects/matou-app
git add frontend/tests/e2e/e2e-registration.spec.ts
git commit -m "test(e2e): steward-issued membership comes from the org group; stewards revoke each other's issuances

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 12: Final KERIA 0.4.0 run, idss issue, incident note

**Files:**
- Modify: `frontend/tests/infra/README.md` (record the final PASS table)
- Create: `docs/incidents/2026-09-30-whakatohea-second-steward-issuance.md` (only if `docs/incidents/` exists; otherwise add the note to `../matou-incidents` following that repo's existing layout)

- [ ] **Step 1: Run the full harness in both modes**

```bash
cd /home/benz/Documents/1.projects/matou-app/frontend/tests/infra
docker compose -f keria-0.4/docker-compose.yml up -d
MODE=held npx tsx steward-peer.infra.ts | tail -40
docker compose -f keria-0.4/docker-compose.yml down -v && docker compose -f keria-0.4/docker-compose.yml up -d
MODE=fresh npx tsx steward-peer.infra.ts | tail -40
docker compose -f keria-0.4/docker-compose.yml down -v
```

Expected: every row PASSes in both modes. Paste the table into the README under "Last run".

- [ ] **Step 2: Draft the idss issue body and ask the human before filing**

The body goes to `…/scratchpad/idss-issue.md`:
- Title: `control panel: sync the org group before an issue/revoke, and send /multisig/iss|rev to the other stewards after`
- Link the matou-app spec §3.1, §3.3 and §6.
- Include the exact embed shapes from `replicate.ts` `actEmbedParts`.
- State the acceptance check: a panel-issued credential shows `et=iss` on the other steward's agent after they sign in.

Show the draft to the human. File it on Forgejo `Matou/idss` only after they say yes.

- [ ] **Step 3: Write the incident note**

Cover:
- the 500's cause;
- the four orphan ixns (group sn 17–20, index-1 signatures, anchoring `iss` events that never existed);
- that they are harmless;
- the repair path (new app: founder syncs → engie adopts → founder's history push → approve);
- the two e2e defects found and fixed.

- [ ] **Step 4: Commit**

```bash
cd /home/benz/Documents/1.projects/matou-app
git add frontend/tests/infra/README.md docs/incidents 2>/dev/null
git commit -m "docs: KERIA 0.4.0 steward-peer run, whakatohea second-steward incident note

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```
