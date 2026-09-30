# Every steward is a full peer of the org group

**Status:** design, approved in session 2026-09-30. The spec awaits review.
**Scope:** matou-app (frontend) + one obligation on idss (the control panel).
**Signing model:** the org group AID stays **1-of-N**. Any single steward can issue, revoke or promote, and no founder is needed.

## 1. Why

### 1.1 The incident

On whakatohea-demo (IDSS, KERIA 0.4.0, 2026-09-30), engie is the second steward and was promoted into the org group AID from the community app. Their Approve on a membership failed with `POST /identifiers/whakatohea-demo/credentials → 500`.

- IDSS issues every Membership from the one `community.registry` (ADR 0235 d.4; `resolveIssuingRegistry`, `frontend/src/lib/keri/registry.ts:86`).
- ADR 0235 d.4 also says "promotion carries the ledger into the new steward's agent". Nothing implements that.
- engie's agent knows the registry only as a verifier: they hold a Membership from it. So KERIA's `regk not in tevers` check (404) passes.
- `identifierResource.interact` then accepts and **witnesses** the group ixn.
- `Registrar.issue` then does `rgy.regs[regk]`, which raises `KeyError`, which KERIA returns as a 500. `regs` holds only registries the agent itself made.
- Every retry therefore left a witnessed ixn anchoring an `iss` that never happened. The group KEL shows sn 17–20 signed at index 1 (engie's key). They are orphans: harmless, and never removable.
- The founder's agent may not know those four events. If it issues from a stale view it re-anchors sn 17 and **forks the group KEL** (the #63 shape).

### 1.2 The legacy e2e hides the same gap

A registration e2e on elitebook-03 (app `8e58475`, infra `79fb999`) went 3 passed / 1 flaky / 1 failed.

- **Test 2 passed on its first attempt, but it is a false green.** The promoted steward clicked Approve *before* its app had joined the group: the round-2 join is logged after the issuance.
  - `getOrgAidName` (`useAdminActions.ts:171`) found no group identifier and silently fell back to the steward's **personal AID**.
  - member2's Membership was issued by User1 personally. The spec never checks the issuer.
- **Test 5 (second promotion) fails** with `member2 must now sign for the group`: the group has 3 keys, and none of them is member2's current key.
  - member2 handled a co-signer's *forwarded* round-1 `/multisig/rot` (d29ab75) as a new round 1.
  - It handled that one twice at once, because `checkAndJoinMultisig` has no in-flight guard and each run blocked ~30 s in `queryKeyStateToSn`, which always times out.
  - So member2 rotated 0→1→2→3 while round 2 committed its s=1 key.
  - The likely regression window is #520 (`ef5d122`, 2026-09-16), which added that slow pull. The suite was 5/5 green on 2026-09-12.

### 1.3 What KERIA 0.4.0 allows (spike, 2026-09-30)

Two spikes ran against `weboftrust/keria:0.4.0` + `keri-witness-demo:1.1.0` + signify-ts 0.3.0. Scripts are in the session scratchpad: `spike.ts`, `spike2.ts`.

| Finding | Consequence for the design |
|---|---|
| `registries().createFromEvents(groupHab, group, name, vcp, anc, sigs)`, fed the registry's **original** `vcp` + its **original** anchoring ixn and signatures (all taken from the steward's own held credential export), gives the agent a working registry. Nothing new is anchored. It works for an agent that never held from the registry too. The registry op reports `done` before `registries().list` shows it (≤ ~3 s). | Adoption is self-serve and costs no events. Poll `list`; don't trust the op. |
| Once an agent holds or has adopted a registry, keripy's `Tevery` refuses inbound TEL events for it (`Local event regk=… when nonlocal mode`). This holds over the CESR door, IPEX grant/admit, anything. The door still answers 204. | A shared registry is kept in step **only by replay**: each steward's agent re-creates each TEL event itself. A 204 from the door proves nothing. |
| Replaying an issuance: `POST /identifiers/{g}/credentials {acdc, iss, ixn, sigs}`. It works on any steward **if the sigs include that steward's own signature over the ixn**. `keys[0]` is the elected witnesser and wedges forever without its own sig. A second, different signature set on an already-accepted ixn is accepted and merged. | Every replay adds the replaying steward's own signature. |
| Replaying a revocation: `DELETE /identifiers/{g}/credentials/{said} {rev, ixn, sigs}`. It works both directions, but only once the credential's `iss` is held. A `rev` before its `iss` is a clean 404 with no side effect. | Replay `iss` before `rev`. |
| `iss` is rebuilt exactly from the ACDC: `{t:'iss', i:acdc.d, s:'0', ri:acdc.ri, dt:acdc.a.dt}` → saidify → equals the SAID sealed in the witness-held group ixn. The `rev` SAID is sealed publicly, but its `dt` (ms resolution) is not; a bounded brute force from the issuance found it in ~4,000 tries (<1 s). | Backfill needs only the ACDC + the witness KEL. |
| A replayed credential whose issuee is the steward shows in their `credentials().list()`, and they can grant it onward. Inbound IPEX from that registry to an adopted steward fails. | Credentials *to* a steward from the org registry arrive by replay. |
| A steward whose agent is behind the group KEL issues at an already-used sn with **no error**. The witnesses reject it, so the result is a silent fork. `keyStates().query(group, sn)` times out every time. Resolving the witness OOBI doesn't move sn. **A CESR push of the witness KEL (with receipts) into the agent works.** | Sync from the witnesses before every act. It is the only fork guard. |
| A replay whose anchoring ixn is ahead of the agent's KEL returns 500 and does not self-heal after the KEL arrives. Re-POSTing after a sync succeeds, and the agent is never wedged. | The replayer syncs and retries once. |
| A steward's own signature uses its current key, so it is valid only for ixns made since its last rotation. | Drain replays before any group rotation (§4). |

## 2. Model

Every steward's agent holds the same four things:
- the group KEL;
- the group identifier;
- the org registry;
- every credential issued or revoked from it.

The **roster** is the group's own current signers (`currentGroupSigners`, `frontend/src/lib/keri/client.ts:1778`), never `org-config.admins` (on IDSS that holds only the founder).

There is **one org registry** on every backend:
- IDSS: `community.registry` from the descriptor.
- Legacy: the org config's existing `registry.id`, the admin's original registry.
- Per-steward registry creation (`getOrCreateOrgRegistry`) stops. Existing per-steward registries stay readable.

## 3. Units

Each unit is its own module under `frontend/src/lib/keri/steward/`, with a narrow interface and unit tests. Composables wire them to the UI.

### 3.1 `groupSync` — the fork guard
- `syncGroup(group): Promise<{ sn: number }>`.
- Fetches the group KEL **with receipts** by a plain HTTP GET of each witness's `/oobi/{group}` stream. Witness base URLs are discovered the same way `resolveViaWitnesses` (`client.ts:489`) does it.
- It does *not* resolve the OOBI through the agent. In the spike, re-resolving an OOBI the agent had already resolved left sn unchanged.
- Pushes each event into this steward's agent through the CESR door, one event per request (the `pushKelToAgent` shape).
- Then reads the agent's group sn and **throws `GroupBehind`** unless it equals the highest witness sn.
- Never trusts the door's 204.

### 3.2 `registryAdoption`
- `ensureOrgRegistry(group, regk): Promise<void>`.
- If `registries().list(group)` lacks `regk`:
  1. export one of this steward's own held credentials from that registry (`credentials().get(said, true)`);
  2. extract the `vcp` whose `i == regk` and the group ixn whose seal has `i == regk`, with its signatures;
  3. call `createFromEvents`;
  4. poll `list` (≤ 15 s, else throw `RegistryNotAdopted`).
- A steward always holds a Membership from the org registry, because they were a member before promotion. The founder made the registry. So if this agent holds nothing from `regk`, throw `RegistryNotAdopted("no held credential to adopt from")`. Don't guess.

### 3.3 `actReplication` — sending
After an issue or revoke, send an exn to each other signer's personal AID. Sending to one recipient is best-effort and never rolls the act back.

Route `/matou/org/act`, payload:

```ts
{
  v: 1,
  kind: 'iss' | 'rev',
  group: string,        // group AID prefix
  registry: string,     // regk
  acdc: object,         // the credential SAD
  event: object,        // the iss or rev SAD
  anc: string,          // the anchoring ixn's exact raw JSON text
  sigs: string[],       // its indexed signatures, qb64
}
```

`signify revoke()` doesn't return the sigs, so the sender reads them back from its own KEL export after the act. This format is the contract idss implements (§6).

### 3.4 `replayInbox` — receiving
- Runs while a steward is signed in. It follows the existing notification service and is **single-flight**.
- For each unread `/matou/org/act`, oldest first:
  1. `syncGroup`.
  2. If `credentials().state(registry, acdc.d).et` already equals `event.t`, mark it read. Done.
  3. Sign `anc` with this steward's group-member key (`client.manager.get(groupHab).sign(raw)`) and merge that signature with `sigs`.
  4. `iss`: POST. `rev`: DELETE. On a `rev` 404 (not held), replay the `iss` built from `acdc` first, then the `rev`.
  5. On a 500: `syncGroup`, then retry once. If it still fails, leave the notification unread and surface it.
  6. Mark it read.
- `drainReplays(): Promise<void>` runs the loop to empty and throws if anything is left.

### 3.5 `backfill` — catch-up without messages
- `catchUp(group, regk)`.
- Keeps a watermark: the last group sn scanned, stored per steward and per group.
- Walks the witness group KEL above the watermark. For each ixn seal on a credential of `regk`, it replays what this agent lacks:
  - `iss`: rebuilt from the ACDC.
  - `rev`: its `dt` is recovered by a millisecond search from the `iss` dt, bounded by the ixn's first-seen time on the witness. A failed search is reported and never guessed.
- ACDC source:
  - IDSS: the gateway directory (`GET /api/v1/idip/directory`).
  - Legacy: the backend's credential store.
- It runs:
  - after adoption (a full scan);
  - at every steward sign-in (incremental). This also covers acts that sent no exn: IDSS panel acts until §6 lands, and missed messages.

### 3.6 `stewardReady`
- One reactive state: `joined` (a local group identifier matches the org AID), `registry` (adopted), `synced` (the last `syncGroup` succeeded).
- Approve and role changes are enabled only when all three hold. Otherwise the screen names the pending step.

## 4. Flows

### 4.1 Any org act (approve, role change, revoke; app or panel)
1. `stewardReady`, adopting now if needed. If it isn't ready, refuse with the named reason. Nothing is anchored.
2. `syncGroup`. On `GroupBehind`, refuse: "your copy of the community's history is behind — try again".
3. Issue or revoke from the group AID; wait for the anchoring ixn to be witnessed (existing `awaitGroupAnchorWitnessed`).
4. `actReplication` to the other signers.
5. Push the KEL to the holder and grant, as today.

### 4.2 Promotion (the rounds are unchanged; every current steward must be signed in, as today)
1. **Before round 1**, the promoter, each co-signer (through the existing rotation signal) and the joiner run `syncGroup` + `drainReplays`. Promotion refuses to start if any participant can't confirm.
2. **Joiner, round 1:**
   - Rotate the personal AID **once per proposed group rotation**, keyed by `exn.e.rot.d`, and only on the initiator's exn (`exn.i === smids[0]`).
   - Any other `/multisig/rot` carrying an already-handled rotation SAID is only marked read.
   - `checkAndJoinMultisig` gets a real in-flight guard.
   - `queryKeyStateToSn` is replaced by `syncGroup` there.
3. **Joiner, round 2:** join, then `syncGroup` → `ensureOrgRegistry` → `catchUp`. Only then does `stewardReady` turn true.

## 5. Changes to existing code

- `getOrgAidName` (`useAdminActions.ts:171`): throws `NotJoined` when the org group isn't in the wallet. The name-pattern and first-AID fallbacks are removed.
- `pushGroupKelToOtherMembers` and `selectGroupKelPushTargets`: targets come from `currentGroupSigners`, not `org-config.admins`.
- `resolveIssuingRegistry` returns the single org registry on every backend. `getOrCreateOrgRegistry` is deleted.
- The remaining `queryKeyStateToSn` callers (`communityStanding.ts:62`, `useCredentialPolling.ts:709`) are best-effort non-controller pulls and are out of scope. Leave them.

## 6. Obligation on idss

The control panel's steward bundle signs from a steward's agent. It must:
- run the §3.1 sync before each issue or revoke and refuse on `GroupBehind`;
- send `/matou/org/act` (§3.3) after each one.

To file: an idss issue. Until it lands, §3.5 catch-up at steward sign-in covers panel acts.

## 7. Testing

- **Unit (vitest):**
  - `iss`/`rev` rebuild + SAID;
  - CESR signature parsing;
  - the bounded `dt` search;
  - the join handler's rotation-SAID dedupe and in-flight guard;
  - `getOrgAidName` refusing;
  - the `replayInbox` decision table (already applied / rev-404-then-iss / 500-sync-retry / still failing);
  - `groupSync` refusing when behind.
- **KERIA integration** (new; KERIA 0.4.0 + witness demo, isolated ports): the spike, kept as a test. It covers adoption (held and fresh), issue and revoke by each of `keys[0]` and index 1 with replay to the other, backfill of a live and a revoked credential, out-of-order replay, and fork refusal. The e2e stack runs `matou-keria-patched`, which is a different base version, so this test covers the gap.
- **Registration e2e:**
  - Test 2 asserts that member2's Membership **issuer is the group AID**.
  - Test 5 is green.
  - New test: the promoted steward revokes a credential the admin issued, and the admin revokes one the steward issued. `state()` shows `rev` on both agents.

## 8. Rollout

1. matou-app release. Legacy orgs need no data migration: `registry.id` is already the org registry.
2. File the idss issue (§6).
3. whakatohea-demo repairs itself with the new app:
   - The founder's next act syncs to sn 20 first, so there's no fork.
   - engie's next sign-in adopts the registry and catches up.
   - The waiting applicant is then approved by either steward.
   - Group sn 17–20 stay as anchor-less orphans. Record them in the incident notes.

## 9. Out of scope

- Threshold co-signing (`kt > 1`). The replay channel is a natural place for it later, but not now.
- Removing a steward from the group.
- Signing replays of ixns older than the replaying steward's last rotation. §4.2's drain-before-rotate makes this unreachable in normal operation. If it happens anyway, `catchUp` replays without an own signature: that works for a non-`keys[0]` steward, and `keys[0]` reports it.
