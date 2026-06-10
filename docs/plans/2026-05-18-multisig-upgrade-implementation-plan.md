# Member-to-Admin Multisig Upgrade Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire the validated multisig protocol (POC in `matou-infrastructure/keri/test-multisig.ts`) into the matou-app frontend so that an admin can promote a regular member to admin status, after which the promoted member can issue org-signed credentials indistinguishably from the founding admin.

**Architecture:** The org AID stays a 1-of-N group AID. Promotion is a two-round KERI rotation protocol: round 1 adds the member to `rstates` (next-key holders); the member then rotates their personal hab; round 2 promotes the member into `states` (current signers) and the member signs the rotation. Witnesses are sourced dynamically from the config server and assigned to disjoint personal/org subsets so the org inception isn't byte-identical to the admin's personal inception. The admin-side coordinator (`useAdminActions.upgradeMemberToSteward`) calls split `addMemberRound1` / `waitForMemberRotation` / `addMemberRound2` methods. The member-side watcher (`useMultisigJoin`) routes each `/multisig/rot` notification to a round-1 handler (refresh admin OOBI, rotate personal hab, do **not** join) or a round-2 handler (refresh admin OOBI, `joinGroup`).

**Tech Stack:** signify-ts 0.3.x (identifiers, keyStates, exchanges, groups, oobis), Vue 3 composables, Vitest (unit), Playwright (E2E), KERIA (via `matou-infrastructure/keri`).

**Reference docs in this repo:**
- `docs/multisig-upgrade-implementation-plan.md` — design rationale + sequence diagram
- `matou-infrastructure/keri/MULTISIG-POC-FINDINGS.md` — protocol-level explanation
- `matou-infrastructure/keri/test-multisig.ts` — 13-phase validated POC

---

## File Structure

### New files

| File | Responsibility |
|---|---|
| `frontend/src/lib/keri/witnessAssignment.ts` | Pure helper: read `fetchClientConfig().witnesses`, return disjoint `{ personal, org, toad }`. Sorts pool deterministically. |
| `frontend/src/lib/keri/multisigRound.ts` | Pure helper: given an EXN payload + my prefix, return `'round-1' \| 'round-2' \| 'unknown'`. Extracted from `useMultisigJoin` so it's unit-testable. |
| `frontend/tests/scripts/witness-assignment.test.ts` | Unit tests for `witnessAssignment.ts`. |
| `frontend/tests/scripts/multisig-round.test.ts` | Unit tests for `multisigRound.ts`. |
| `frontend/tests/e2e/e2e-multisig-upgrade.spec.ts` | Full admin-promotes-member E2E across two browser contexts. |

### Modified files

| File | What changes |
|---|---|
| `frontend/src/lib/keri/client.ts:219` (`createAID`) | Pull personal witnesses from `assignWitnesses()` instead of hardcoded `WITNESS_AID`. |
| `frontend/src/lib/keri/client.ts:748` (`createGroupAID`) | Pull org witnesses from `assignWitnesses()` instead of `toad: 0, wits: []`. |
| `frontend/src/lib/keri/client.ts:837` (`addMemberToGroup`) | Split into `addMemberRound1` + `addMemberRound2`. Add `rotatePersonalAid` + `waitForMemberRotation` helpers. Use FRESH master hab for each EXN send. |
| `frontend/src/lib/keri/client.ts:1027` (`joinGroup`) | `await keeper.sign(...)` with group-level `[memberIdx]` for `indices` and `ondices`. |
| `frontend/src/composables/useMultisigJoin.ts` | Use `multisigRound.ts` to dispatch; round-1 handler refreshes admin OOBI + rotates personal hab + does NOT call `joinGroup`; round-2 handler refreshes admin OOBI + calls `joinGroup`. |
| `frontend/src/composables/useAdminActions.ts:368` (`upgradeMemberToSteward`) | Replace the single `addMemberToGroup` call with `addMemberRound1` → `waitForMemberRotation` → `addMemberRound2`. Add `processingStep` markers for each phase. |
| `frontend/src/components/dashboard/ChangeRoleModal.vue` | Display the new `processingStep` strings (round-1, waiting-for-member, round-2). |

---

## Task 1: `assignWitnesses` helper — failing test first

**Files:**
- Create: `frontend/src/lib/keri/witnessAssignment.ts`
- Test: `frontend/tests/scripts/witness-assignment.test.ts`

- [ ] **Step 1: Write the failing test**

Create `frontend/tests/scripts/witness-assignment.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('src/lib/clientConfig', () => ({
  fetchClientConfig: vi.fn(),
}));

import { assignWitnesses } from 'src/lib/keri/witnessAssignment';
import { fetchClientConfig } from 'src/lib/clientConfig';

const mockConfig = (aids: Record<string, string>) => {
  (fetchClientConfig as ReturnType<typeof vi.fn>).mockResolvedValue({
    witnesses: { urls: [], aids, oobis: [] },
  });
};

describe('assignWitnesses', () => {
  beforeEach(() => vi.clearAllMocks());

  it('splits a 6-witness pool into disjoint halves with toad=2', async () => {
    mockConfig({
      wit0: 'BAAA', wit1: 'BBBB', wit2: 'BCCC',
      wit3: 'BDDD', wit4: 'BEEE', wit5: 'BFFF',
    });
    const out = await assignWitnesses();
    expect(out.personal).toEqual(['BAAA', 'BBBB', 'BCCC']);
    expect(out.org).toEqual(['BDDD', 'BEEE', 'BFFF']);
    expect(out.toad).toBe(2);
    expect(new Set([...out.personal, ...out.org]).size).toBe(6);
  });

  it('splits a 4-witness pool with toad=2', async () => {
    mockConfig({ a: 'BAAA', b: 'BBBB', c: 'BCCC', d: 'BDDD' });
    const out = await assignWitnesses();
    expect(out.personal).toEqual(['BAAA', 'BBBB']);
    expect(out.org).toEqual(['BCCC', 'BDDD']);
    expect(out.toad).toBe(2);
  });

  it('drops to toad=1 for a 3-witness pool', async () => {
    mockConfig({ a: 'BAAA', b: 'BBBB', c: 'BCCC' });
    const out = await assignWitnesses();
    expect(out.personal).toEqual(['BAAA']);
    expect(out.org).toEqual(['BBBB', 'BCCC']);
    expect(out.toad).toBe(1);
  });

  it('throws on a pool of < 2 witnesses', async () => {
    mockConfig({ a: 'BAAA' });
    await expect(assignWitnesses()).rejects.toThrow(/at least 2/i);
  });

  it('is deterministic regardless of map iteration order', async () => {
    mockConfig({ wit3: 'BDDD', wit1: 'BBBB', wit0: 'BAAA', wit2: 'BCCC' });
    const a = await assignWitnesses();
    mockConfig({ wit2: 'BCCC', wit0: 'BAAA', wit1: 'BBBB', wit3: 'BDDD' });
    const b = await assignWitnesses();
    expect(a).toEqual(b);
  });
});
```

- [ ] **Step 2: Run test, confirm it fails**

```bash
cd frontend && npx vitest run tests/scripts/witness-assignment.test.ts
```

Expected: FAIL with `Cannot find module 'src/lib/keri/witnessAssignment'`.

- [ ] **Step 3: Implement `witnessAssignment.ts`**

Create `frontend/src/lib/keri/witnessAssignment.ts`:

```ts
import { fetchClientConfig } from 'src/lib/clientConfig';

export interface WitnessAssignment {
  personal: string[];
  org: string[];
  toad: number;
}

/**
 * Pick disjoint witness subsets for an admin's personal AID and the org AID.
 *
 * Deterministic: pool is sorted by AID prefix, then split in half.
 * - personal = first half
 * - org = second half (always non-empty when pool >= 2)
 * - toad = 2 when pool >= 4, else 1
 *
 * Throws if the active witness pool has fewer than 2 entries — a multisig
 * upgrade flow cannot be made to work without disjoint sets.
 */
export async function assignWitnesses(): Promise<WitnessAssignment> {
  const config = await fetchClientConfig();
  const pool = Object.values(config.witnesses?.aids ?? {}).sort();
  if (pool.length < 2) {
    throw new Error(
      `Witness pool has ${pool.length} entries; need at least 2 for disjoint personal/org sets.`,
    );
  }
  const mid = Math.floor(pool.length / 2);
  return {
    personal: pool.slice(0, mid),
    org: pool.slice(mid),
    toad: pool.length >= 4 ? 2 : 1,
  };
}
```

- [ ] **Step 4: Run test, confirm it passes**

```bash
cd frontend && npx vitest run tests/scripts/witness-assignment.test.ts
```

Expected: 5 passed.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/lib/keri/witnessAssignment.ts frontend/tests/scripts/witness-assignment.test.ts
git commit -m "feat(keri): assignWitnesses helper for disjoint personal/org subsets"
```

---

## Task 2: Use `assignWitnesses` in `createAID`

**Files:**
- Modify: `frontend/src/lib/keri/client.ts:219`

- [ ] **Step 1: Read the current `createAID` body** to identify the exact `wits: [WITNESS_AID]` block (around line 232) and the `useWitnesses` flag.

- [ ] **Step 2: Replace the hardcoded witness block**

Find:

```ts
    // Witness AIDs (from witness-demo image):
    // - BBilc4-L3tFUnfM_wJr4S4OJanAv_VmF_dJNN6vkf2Ha (wan, port 5642)
    // Using only 1 witness with toad=1 to match signify-ts test pattern
    const WITNESS_AID = 'BBilc4-L3tFUnfM_wJr4S4OJanAv_VmF_dJNN6vkf2Ha';

    let result;
    if (options?.useWitnesses) {
      // Create AID with witness backing
      // Using 1 witness with toad=1 (matching signify-ts test pattern)
      console.log('[KERIClient] Creating AID with witness backing (1 witness, toad=1)...');
      result = await this.client.identifiers().create(name, {
        wits: [WITNESS_AID],
        toad: 1, // Threshold: need 1 witness to acknowledge
      });
    } else {
      // Create without witnesses (faster for development)
      console.log('[KERIClient] Creating AID (without witnesses for faster dev)...');
      result = await this.client.identifiers().create(name);
    }
```

Replace with:

```ts
    const { assignWitnesses } = await import('./witnessAssignment');
    const { personal, toad } = await assignWitnesses();
    console.log(
      `[KERIClient] Creating AID "${name}" with ${personal.length} personal witnesses (toad=${toad})`,
    );
    const result = await this.client.identifiers().create(name, {
      wits: personal,
      toad,
    });
```

(Remove the now-unused `options?: { useWitnesses?: boolean }` parameter from the signature in a follow-up only if no caller depends on it — grep first; if any caller passes the option, leave the signature alone and just ignore the flag.)

- [ ] **Step 3: Check for callers of `useWitnesses` option**

```bash
cd frontend && grep -rn "useWitnesses" src/
```

Expected: zero or one match outside `client.ts`. If one match passes `useWitnesses: true`, that call site is now safe to leave alone (witnesses are unconditional). If it passes `false`, leave it; the AID will now get witnesses anyway — this is the desired behaviour for upgradeability.

- [ ] **Step 4: Type-check**

```bash
cd frontend && npx vue-tsc --noEmit 2>&1 | head -20
```

Expected: no errors related to `client.ts` lines around 232.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/lib/keri/client.ts
git commit -m "feat(keri): personal AIDs use dynamic witness subset from config server"
```

---

## Task 3: Use `assignWitnesses` in `createGroupAID`

**Files:**
- Modify: `frontend/src/lib/keri/client.ts:748`

- [ ] **Step 1: Replace the `toad: 0, wits: []` block**

Find:

```ts
    const result = await this.client.identifiers().create(name, {
      algo: 'group' as never, // GroupIdentifierManager — required for multisig rotation
      isith: '1', // Signing threshold of 1
      nsith: '1', // Next signing threshold of 1
      toad: 0, // No witnesses for now (faster for dev)
      wits: [],
      mhab: masterAid, // Master AID controls this group
      states: [masterAid.state], // Include master's key state
      rstates: [masterAid.state], // Include master's rotation state
    });
```

Replace with:

```ts
    const { assignWitnesses } = await import('./witnessAssignment');
    const { org: orgWits, toad } = await assignWitnesses();
    console.log(
      `[KERIClient] Creating group AID "${name}" with ${orgWits.length} org witnesses (toad=${toad})`,
    );
    const result = await this.client.identifiers().create(name, {
      algo: 'group' as never,
      isith: '1',
      nsith: '1',
      toad,
      wits: orgWits,
      mhab: masterAid,
      states: [masterAid.state],
      rstates: [masterAid.state],
    });
```

- [ ] **Step 2: Type-check**

```bash
cd frontend && npx vue-tsc --noEmit 2>&1 | head -20
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add frontend/src/lib/keri/client.ts
git commit -m "feat(keri): org group AID uses disjoint witness subset (was toad=0)"
```

---

## Task 4: `rotatePersonalAid` helper

**Files:**
- Modify: `frontend/src/lib/keri/client.ts` (add near `createAID`, around line 300)

- [ ] **Step 1: Add the method to `KERIClient`**

```ts
  /**
   * Rotate a personal (non-group) AID by one step.
   *
   * Used during the multisig upgrade flow:
   *  - admin rotates between round 1 and round 2 so the next-key the
   *    group rotation commits to becomes the current signing key
   *  - member rotates after round 1 so admin can include member's new
   *    key state in the round-2 group rotation
   *
   * @param aidName - Local alias of the AID to rotate (NOT a group AID)
   * @returns The new sequence number after rotation
   */
  async rotatePersonalAid(aidName: string): Promise<string> {
    if (!this.client) throw new Error('Not initialized');
    await this.ensureConnected();
    const before = await this.client.identifiers().get(aidName);
    console.log(`[KERIClient] Rotating ${aidName} (sn=${before.state?.s})...`);

    const rot = await this.client.identifiers().rotate(aidName);
    const op = await rot.op();
    await this.client.operations().wait(op, { signal: AbortSignal.timeout(60000) });

    const after = await this.client.identifiers().get(aidName);
    const newSn = after.state?.s as string;
    console.log(`[KERIClient] Rotated ${aidName}: sn=${before.state?.s} -> sn=${newSn}`);
    return newSn;
  }
```

- [ ] **Step 2: Type-check + commit**

```bash
cd frontend && npx vue-tsc --noEmit 2>&1 | head -10
git add frontend/src/lib/keri/client.ts
git commit -m "feat(keri): rotatePersonalAid helper for multisig upgrade flow"
```

---

## Task 5: `waitForMemberRotation` helper

**Files:**
- Modify: `frontend/src/lib/keri/client.ts` (add after `rotatePersonalAid`)

- [ ] **Step 1: Add the method**

```ts
  /**
   * Poll until the given AID's KEL on this agent reaches a target sequence number.
   * Used by admin to wait for the promoted member's personal-hab rotation to
   * propagate before constructing round 2 of the multisig add.
   *
   * @param aidPrefix - Prefix of the AID to watch
   * @param targetSn - Sequence number to wait for (as a hex string, e.g. '1')
   * @param opts.timeoutMs - Total timeout (default 5 minutes)
   * @param opts.intervalMs - Poll interval (default 3 seconds)
   * @throws if timeout elapses before target sn is reached
   */
  async waitForMemberRotation(
    aidPrefix: string,
    targetSn: string,
    opts: { timeoutMs?: number; intervalMs?: number } = {},
  ): Promise<void> {
    if (!this.client) throw new Error('Not initialized');
    const timeoutMs = opts.timeoutMs ?? 5 * 60_000;
    const intervalMs = opts.intervalMs ?? 3000;
    const targetSnInt = parseInt(targetSn, 16);
    const deadline = Date.now() + timeoutMs;
    let lastSeen: string | undefined;

    while (Date.now() < deadline) {
      try {
        await this.ensureConnected();
        const op = await this.client.keyStates().query(aidPrefix, targetSn, undefined);
        const res = await this.client.operations().wait(op, { signal: AbortSignal.timeout(intervalMs * 2) });
        const ks = res.response as { s?: string } | undefined;
        lastSeen = ks?.s;
        if (ks?.s !== undefined && parseInt(ks.s, 16) >= targetSnInt) {
          console.log(`[KERIClient] waitForMemberRotation: ${aidPrefix.slice(0, 12)}... reached sn=${ks.s}`);
          return;
        }
      } catch (err) {
        // keyStates().query throws while the KEL hasn't caught up yet — that's expected
        console.log(`[KERIClient] waitForMemberRotation: not yet (lastSeen=${lastSeen}, err=${err instanceof Error ? err.message : err})`);
      }
      await new Promise(r => setTimeout(r, intervalMs));
    }
    throw new Error(
      `Timed out waiting for ${aidPrefix.slice(0, 12)}... to reach sn=${targetSn} (last seen: ${lastSeen ?? 'none'})`,
    );
  }
```

- [ ] **Step 2: Type-check + commit**

```bash
cd frontend && npx vue-tsc --noEmit 2>&1 | head -10
git add frontend/src/lib/keri/client.ts
git commit -m "feat(keri): waitForMemberRotation poller for round-2 timing"
```

---

## Task 6: Extract `sendMultisigRotExn` private helper

**Files:**
- Modify: `frontend/src/lib/keri/client.ts` (add right above `addMemberToGroup`)

This extraction lets both round-1 and round-2 share a single EXN-send code path with the FRESH-hab fix baked in.

- [ ] **Step 1: Add the private helper**

```ts
  /**
   * Send a /multisig/rot EXN for the given rotation result.
   *
   * CRITICAL: re-fetches the master hab inside this method. The hab object
   * returned at the top of a longer flow is stale by the time the EXN is
   * sent (master may have rotated in between), and a stale hab signs the
   * EXN with the old key — KERIA then rejects with "Not enough signatures".
   *
   * @param masterAidName - Local alias of the admin's personal AID
   * @param groupName - Local alias of the group AID
   * @param groupPrefix - Prefix of the group AID
   * @param rot - Result of `identifiers().rotate(groupName, ...)`
   * @param smids - signing-member ids (admin's prefix, plus member if round 2)
   * @param rmids - rotating-member ids (always [admin, member])
   * @param recipients - prefixes to deliver the EXN to (usually [memberPrefix])
   */
  private async sendMultisigRotExn(
    masterAidName: string,
    groupName: string,
    groupPrefix: string,
    rot: { serder: unknown; sigs: string[] },
    smids: string[],
    rmids: string[],
    recipients: string[],
  ): Promise<void> {
    if (!this.client) throw new Error('Not initialized');
    await this.ensureConnected();
    const signify = await import('signify-ts');

    // Re-fetch master hab so signing uses the current key state, not a stale snapshot.
    const masterFresh = await this.client.identifiers().get(masterAidName);

    const serder = rot.serder as { raw: Uint8Array; size: number };
    const sigers = rot.sigs.map(s => new signify.Siger({ qb64: s }));
    const ims = signify.d(signify.messagize(serder as never, sigers));
    const atc = ims.substring(serder.size);

    console.log(
      `[KERIClient] sendMultisigRotExn: gid=${groupPrefix.slice(0, 12)}, smids=${smids.length}, rmids=${rmids.length}, recipients=${recipients.length}`,
    );

    await this.client.exchanges().send(
      masterAidName,
      groupName,
      masterFresh,
      '/multisig/rot',
      { gid: groupPrefix, smids, rmids },
      { rot: [serder, atc] },
      recipients,
    );
  }
```

- [ ] **Step 2: Type-check + commit**

```bash
cd frontend && npx vue-tsc --noEmit 2>&1 | head -10
git add frontend/src/lib/keri/client.ts
git commit -m "refactor(keri): extract sendMultisigRotExn with fresh-hab fix"
```

---

## Task 7: Replace `addMemberToGroup` with `addMemberRound1`

**Files:**
- Modify: `frontend/src/lib/keri/client.ts:837`

- [ ] **Step 1: Delete the entire body of the existing `addMemberToGroup`** (lines 837 through ~1018) and replace with two new public methods. Add `addMemberRound1` first.

Replace the existing `async addMemberToGroup(...)` block with:

```ts
  /**
   * Round 1 of the member-to-admin upgrade.
   *
   * Pre-rotates the master personal AID so the next-key already committed
   * in the prior group event becomes the *current* signing key, then
   * executes the group rotation that adds the new member to `rstates`
   * (next-key holders) only — NOT to `states` yet.
   *
   * @param groupName - Local alias of the group AID
   * @param newMemberAidPrefix - Prefix of the AID to add
   * @param masterAidName - Local alias of admin's personal AID (master controller)
   */
  async addMemberRound1(
    groupName: string,
    newMemberAidPrefix: string,
    masterAidName: string,
  ): Promise<void> {
    if (!this.client) throw new Error('Not initialized');
    await this.ensureConnected();
    console.log(`[KERIClient] addMemberRound1: ${newMemberAidPrefix.slice(0, 12)} -> ${groupName}`);

    // Guard: org must have witnesses, otherwise this protocol can't work.
    // (Pre-existing orgs with toad=0 / wits=[] are unrecoverable here.)
    const groupBefore = await this.client.identifiers().get(groupName);
    const groupWits = (groupBefore.state as { b?: string[] })?.b ?? [];
    if (groupWits.length === 0) {
      throw new Error(
        `Group "${groupName}" was created without witnesses (toad=0) and cannot be upgraded. ` +
        `Re-create the org with the current build to enable member promotions.`,
      );
    }

    // (a) Pre-rotate master so next-key becomes current.
    await this.rotatePersonalAid(masterAidName);

    // (b) Query refreshed states for both parties.
    const masterAid = await this.client.identifiers().get(masterAidName);
    const masterQ = await this.client.keyStates().query(masterAid.prefix, undefined, undefined);
    const masterRes = await this.client.operations().wait(masterQ, { signal: AbortSignal.timeout(30000) });
    const masterState = masterRes.response;

    const memberQ = await this.client.keyStates().query(newMemberAidPrefix, undefined, undefined);
    const memberRes = await this.client.operations().wait(memberQ, { signal: AbortSignal.timeout(30000) });
    const memberState = memberRes.response;

    // (c) Group rotation R1: admin signs alone; member joins rstates only.
    const rot1 = await this.client.identifiers().rotate(groupName, {
      states: [masterState],
      rstates: [masterState, memberState],
    });
    const rot1Op = await rot1.op();
    if (!rot1Op?.done) {
      for (let i = 0; i < 10; i++) {
        await new Promise(r => setTimeout(r, 3000));
        const s = await this.client.operations().get(rot1Op.name);
        if (s?.done) break;
      }
    }

    // (d) Send /multisig/rot EXN with FRESH master hab.
    const smids = [masterState.i as string];
    const rmids = [masterState.i as string, memberState.i as string];
    await this.sendMultisigRotExn(
      masterAidName,
      groupName,
      groupBefore.prefix,
      { serder: rot1.serder, sigs: rot1.sigs },
      smids,
      rmids,
      [newMemberAidPrefix],
    );
    console.log('[KERIClient] addMemberRound1 complete');
  }
```

- [ ] **Step 2: Type-check**

```bash
cd frontend && npx vue-tsc --noEmit 2>&1 | grep client.ts | head -10
```

Expected: no errors for `client.ts`.

- [ ] **Step 3: Commit**

```bash
git add frontend/src/lib/keri/client.ts
git commit -m "feat(keri): addMemberRound1 splits out the first multisig rotation round"
```

---

## Task 8: Add `addMemberRound2`

**Files:**
- Modify: `frontend/src/lib/keri/client.ts` (immediately after `addMemberRound1`)

- [ ] **Step 1: Add `addMemberRound2`**

```ts
  /**
   * Round 2 of the member-to-admin upgrade.
   *
   * Called AFTER `waitForMemberRotation` confirms the member's personal hab
   * has advanced to sn=1 (their acceptance step). Pre-rotates master again
   * so admin signs round 2 with the key already committed in round 1's nks,
   * then rotates the group to promote the member into `states`.
   */
  async addMemberRound2(
    groupName: string,
    newMemberAidPrefix: string,
    masterAidName: string,
  ): Promise<void> {
    if (!this.client) throw new Error('Not initialized');
    await this.ensureConnected();
    console.log(`[KERIClient] addMemberRound2: ${newMemberAidPrefix.slice(0, 12)} -> ${groupName}`);

    // (a) Pre-rotate master again.
    await this.rotatePersonalAid(masterAidName);

    // (b) Query both refreshed states.
    const masterAid = await this.client.identifiers().get(masterAidName);
    const masterQ = await this.client.keyStates().query(masterAid.prefix, undefined, undefined);
    const masterRes = await this.client.operations().wait(masterQ, { signal: AbortSignal.timeout(30000) });
    const masterState = masterRes.response;

    const memberQ = await this.client.keyStates().query(newMemberAidPrefix, undefined, undefined);
    const memberRes = await this.client.operations().wait(memberQ, { signal: AbortSignal.timeout(30000) });
    const memberState = memberRes.response;

    // (c) Group rotation R2: both parties in states + rstates.
    const rot2 = await this.client.identifiers().rotate(groupName, {
      states: [masterState, memberState],
      rstates: [masterState, memberState],
    });
    const rot2Op = await rot2.op();
    if (!rot2Op?.done) {
      for (let i = 0; i < 10; i++) {
        await new Promise(r => setTimeout(r, 3000));
        const s = await this.client.operations().get(rot2Op.name);
        if (s?.done) break;
      }
    }

    // (d) Send /multisig/rot EXN with FRESH master hab.
    const groupAid = await this.client.identifiers().get(groupName);
    const smids = [masterState.i as string, memberState.i as string];
    const rmids = [masterState.i as string, memberState.i as string];
    await this.sendMultisigRotExn(
      masterAidName,
      groupName,
      groupAid.prefix,
      { serder: rot2.serder, sigs: rot2.sigs },
      smids,
      rmids,
      [newMemberAidPrefix],
    );

    // (e) Refresh agent end role (group prefix can roll forward).
    const agentId = this.client.agent?.pre;
    if (agentId) {
      try {
        const r = await this.client.identifiers().addEndRole(groupAid.prefix, 'agent', agentId);
        const op = await r.op();
        await this.client.operations().wait(op, { signal: AbortSignal.timeout(30000) });
      } catch (err) {
        console.warn('[KERIClient] addMemberRound2: end-role refresh failed:', err);
      }
    }

    console.log('[KERIClient] addMemberRound2 complete');
  }
```

- [ ] **Step 2: Remove the now-dead `addMemberToGroup`**

The original method body was already replaced by `addMemberRound1`. Make sure no leftover `async addMemberToGroup(` declaration remains — the old method must not coexist with the new split.

```bash
grep -n "addMemberToGroup" frontend/src/lib/keri/client.ts
```

Expected: zero matches.

- [ ] **Step 3: Type-check + commit**

```bash
cd frontend && npx vue-tsc --noEmit 2>&1 | grep client.ts | head -10
git add frontend/src/lib/keri/client.ts
git commit -m "feat(keri): addMemberRound2 completes the multisig upgrade"
```

---

## Task 9: Fix `joinGroup` — await + indexed sign

**Files:**
- Modify: `frontend/src/lib/keri/client.ts:1135` (the `keeper.sign` line inside `joinGroup`)

- [ ] **Step 1: Locate and replace the broken `keeper.sign` block**

Find (around line 1135):

```ts
    const serder = rotEvent instanceof signify.Serder
      ? rotEvent
      : new signify.Serder(rotEvent);

    const sigs = keeper.sign(signify.b(serder.raw));
```

Replace with:

```ts
    const serder = rotEvent instanceof signify.Serder
      ? rotEvent
      : new signify.Serder(rotEvent);

    // GROUP-level index: KERIA verifies sig.index against rot.k[index].
    // Defaulting to 0 verifies member's sig against admin's key -> fails.
    const memberIdx = smids.indexOf(personalAid.prefix);
    if (memberIdx < 0) {
      throw new Error(
        `Member ${personalAid.prefix.slice(0, 12)}... not in smids ${JSON.stringify(smids)} — ` +
        `this notification is not a round-2 EXN addressed to us.`,
      );
    }
    // keeper.sign is async in signify-ts 0.3.x. Without await, sigs is a Promise
    // that serializes to {} -> KERIA returns "No verified signatures for evt."
    const sigs = await keeper.sign(
      signify.b(serder.raw),
      true,
      [memberIdx],
      [memberIdx],
    );
```

- [ ] **Step 2: Type-check + commit**

```bash
cd frontend && npx vue-tsc --noEmit 2>&1 | grep client.ts | head -10
git add frontend/src/lib/keri/client.ts
git commit -m "fix(keri): joinGroup awaits keeper.sign and uses group-level index"
```

---

## Task 10: `multisigRound` pure helper — failing test first

**Files:**
- Create: `frontend/src/lib/keri/multisigRound.ts`
- Test: `frontend/tests/scripts/multisig-round.test.ts`

- [ ] **Step 1: Write the failing test**

Create `frontend/tests/scripts/multisig-round.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { classifyMultisigRot } from 'src/lib/keri/multisigRound';

const ADMIN = 'BADM';
const MEMBER = 'BMEM';

describe('classifyMultisigRot', () => {
  it('returns round-1 when member is in rmids only', () => {
    const exn = { a: { smids: [ADMIN], rmids: [ADMIN, MEMBER] } };
    expect(classifyMultisigRot(exn, MEMBER)).toBe('round-1');
  });

  it('returns round-2 when member is in smids', () => {
    const exn = { a: { smids: [ADMIN, MEMBER], rmids: [ADMIN, MEMBER] } };
    expect(classifyMultisigRot(exn, MEMBER)).toBe('round-2');
  });

  it('returns unknown when member appears in neither', () => {
    const exn = { a: { smids: [ADMIN], rmids: [ADMIN] } };
    expect(classifyMultisigRot(exn, MEMBER)).toBe('unknown');
  });

  it('returns unknown for malformed payloads', () => {
    expect(classifyMultisigRot({}, MEMBER)).toBe('unknown');
    expect(classifyMultisigRot({ a: {} }, MEMBER)).toBe('unknown');
    expect(classifyMultisigRot({ a: { smids: null, rmids: null } }, MEMBER)).toBe('unknown');
  });

  it('admin (first smid) is exposed by adminPrefixFromExn', async () => {
    const { adminPrefixFromExn } = await import('src/lib/keri/multisigRound');
    expect(adminPrefixFromExn({ a: { smids: [ADMIN, MEMBER] } })).toBe(ADMIN);
    expect(adminPrefixFromExn({ a: { smids: [] } })).toBeUndefined();
    expect(adminPrefixFromExn({})).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run, confirm fails**

```bash
cd frontend && npx vitest run tests/scripts/multisig-round.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `frontend/src/lib/keri/multisigRound.ts`:

```ts
export type MultisigRotRound = 'round-1' | 'round-2' | 'unknown';

interface ExnLike {
  a?: { smids?: unknown; rmids?: unknown } | undefined;
}

/**
 * Classify a /multisig/rot EXN from this member's perspective.
 *
 * round-1: member is in rmids only -> need to rotate own personal hab.
 * round-2: member is in smids       -> need to sign the rotation (joinGroup).
 * unknown: malformed payload, or this notification isn't addressed to us.
 */
export function classifyMultisigRot(exn: ExnLike, myPrefix: string): MultisigRotRound {
  const smids = Array.isArray(exn?.a?.smids) ? (exn.a!.smids as string[]) : undefined;
  const rmids = Array.isArray(exn?.a?.rmids) ? (exn.a!.rmids as string[]) : undefined;
  if (!smids || !rmids) return 'unknown';
  if (smids.includes(myPrefix)) return 'round-2';
  if (rmids.includes(myPrefix)) return 'round-1';
  return 'unknown';
}

/**
 * Admin is by convention the first entry in smids of a /multisig/rot EXN.
 * Returns undefined when the payload is malformed.
 */
export function adminPrefixFromExn(exn: ExnLike): string | undefined {
  const smids = Array.isArray(exn?.a?.smids) ? (exn.a!.smids as string[]) : undefined;
  return smids?.[0];
}
```

- [ ] **Step 4: Run, confirm passes**

```bash
cd frontend && npx vitest run tests/scripts/multisig-round.test.ts
```

Expected: 5 passed.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/lib/keri/multisigRound.ts frontend/tests/scripts/multisig-round.test.ts
git commit -m "feat(keri): classifyMultisigRot helper for round-1 vs round-2 routing"
```

---

## Task 11: `useMultisigJoin` — route round-1 vs round-2

**Files:**
- Modify: `frontend/src/composables/useMultisigJoin.ts`

- [ ] **Step 1: Replace the body of `checkAndJoinMultisig`**

Replace the existing function (`useMultisigJoin.ts:27` through line ~80) with:

```ts
  async function checkAndJoinMultisig(): Promise<boolean> {
    const client = keriClient.getSignifyClient();
    if (!client) return false;

    try {
      const allNotifications = notificationService.notifications.value;
      const notifications = allNotifications.filter(
        n => n.a?.r === MULTISIG_ROT_ROUTE && !n.r,
      );
      if (notifications.length === 0) return false;
      console.log(`[MultisigJoin] Found ${notifications.length} unread /multisig/rot notifications`);

      const config = await getOrFetchOrgConfig();
      if (!config?.organization?.aid) {
        console.warn('[MultisigJoin] No org config available');
        return false;
      }
      const orgName = (config.organization.name || 'matou').toLowerCase().replace(/\s+/g, '-');

      const notification = notifications[0];
      isJoining.value = true;
      error.value = null;

      const { classifyMultisigRot, adminPrefixFromExn } = await import('src/lib/keri/multisigRound');
      const exchResp = await client.exchanges().get(notification.a.d);
      const exn = exchResp?.exn ?? {};

      const aids = await client.identifiers().list();
      const me = aids?.aids?.[0]?.prefix as string | undefined;
      if (!me) throw new Error('No personal AID');
      const round = classifyMultisigRot(exn, me);
      const adminPrefix = adminPrefixFromExn(exn);
      console.log(`[MultisigJoin] notification ${notification.a.d.slice(0, 12)} classified as ${round}, admin=${adminPrefix?.slice(0, 12)}`);

      try {
        if (round === 'round-1') {
          if (!adminPrefix) throw new Error('round-1 EXN missing admin prefix');
          const cesrUrl = keriClient.getCesrUrl();
          await keriClient.resolveOOBI(`${cesrUrl}/oobi/${adminPrefix}`, undefined, 30000);
          const personalName = aids.aids[0]?.name as string;
          await keriClient.rotatePersonalAid(personalName);
          await keriClient.markNotificationRead(notification.i);
          console.log('[MultisigJoin] round-1 done; waiting for round-2 EXN');
          return false; // keep watcher running
        }

        if (round === 'round-2') {
          if (!adminPrefix) throw new Error('round-2 EXN missing admin prefix');
          const cesrUrl = keriClient.getCesrUrl();
          await keriClient.resolveOOBI(`${cesrUrl}/oobi/${adminPrefix}`, undefined, 30000);
          const gid = await keriClient.joinGroup(orgName, notification.a.d);
          await secureStorage.setItem('matou_org_aid', gid);
          keriClient.setOrgAID(gid);
          await keriClient.markNotificationRead(notification.i);
          hasJoined.value = true;
          console.log(`[MultisigJoin] round-2 done, joined ${gid.slice(0, 12)}`);
          return true;
        }

        console.warn('[MultisigJoin] unknown round — leaving unread for diagnostic');
        return false;
      } catch (joinErr) {
        const msg = joinErr instanceof Error ? joinErr.message : String(joinErr);
        console.error('[MultisigJoin] handler failed:', joinErr);
        error.value = msg;
        return false;
      } finally {
        isJoining.value = false;
      }
    } catch (err) {
      console.warn('[MultisigJoin] check failed:', err);
      return false;
    }
  }
```

- [ ] **Step 2: Type-check**

```bash
cd frontend && npx vue-tsc --noEmit 2>&1 | grep useMultisigJoin | head -10
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add frontend/src/composables/useMultisigJoin.ts
git commit -m "feat(multisig): useMultisigJoin routes round-1 (rotate-only) vs round-2 (join)"
```

---

## Task 12: `upgradeMemberToSteward` — split into rounds with wait

**Files:**
- Modify: `frontend/src/composables/useAdminActions.ts:368`

- [ ] **Step 1: Find and replace the rotation step**

Find this block (around `useAdminActions.ts:404`):

```ts
      // --- Step 2: Key rotation ---
      processingStep.value = 'Performing key rotation...';
      onStep?.('Performing key rotation...');
      await keriClient.addMemberToGroup(orgName, stewardAid, personalAid.name);
      console.log('[AdminActions] Steward added to org multisig');
```

Replace with:

```ts
      // --- Step 2a: Round 1 — admin pre-rotates, group rotation adds member to rstates ---
      processingStep.value = 'Inviting steward (round 1)...';
      onStep?.('Inviting steward (round 1)...');
      await keriClient.addMemberRound1(orgName, stewardAid, personalAid.name);

      // --- Step 2b: Wait for the steward's frontend to accept and rotate ---
      processingStep.value = 'Waiting for steward to accept...';
      onStep?.('Waiting for steward to accept...');
      await keriClient.waitForMemberRotation(stewardAid, '1', { timeoutMs: 5 * 60_000 });

      // --- Step 2c: Round 2 — admin pre-rotates again, member becomes signer ---
      processingStep.value = 'Promoting steward to signer (round 2)...';
      onStep?.('Promoting steward to signer (round 2)...');
      await keriClient.addMemberRound2(orgName, stewardAid, personalAid.name);
      console.log('[AdminActions] Steward added to org multisig');
```

- [ ] **Step 2: Type-check**

```bash
cd frontend && npx vue-tsc --noEmit 2>&1 | grep useAdminActions | head -10
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add frontend/src/composables/useAdminActions.ts
git commit -m "feat(admin): upgradeMemberToSteward runs round-1, waits, then round-2"
```

---

## Task 13: ChangeRoleModal — surface the three new processing steps

**Files:**
- Modify: `frontend/src/components/dashboard/ChangeRoleModal.vue`

- [ ] **Step 1: Inspect the existing step UI**

```bash
grep -n "processingStep\|step\|processing" frontend/src/components/dashboard/ChangeRoleModal.vue | head -20
```

The modal already calls `upgradeMemberToSteward` with an `advanceStep` callback that drives a step indicator. The three new strings (`Inviting steward (round 1)...`, `Waiting for steward to accept...`, `Promoting steward to signer (round 2)...`) flow through unchanged if the modal renders whatever the callback receives.

- [ ] **Step 2: Verify the modal renders the callback's string**

Open `ChangeRoleModal.vue` and confirm the template binds the current step text to something like `{{ currentStep }}` and the callback is `(s) => (currentStep.value = s)`. If yes, no UI changes needed — the new strings will show up automatically.

If the template uses a hard-coded step list (e.g. `<li v-for="s in fixedSteps">`), update the list to include the three new strings. Replace any existing `'Performing key rotation...'` entry with:

```ts
const upgradeSteps = [
  'Resolving steward identity...',
  'Inviting steward (round 1)...',
  'Waiting for steward to accept...',
  'Promoting steward to signer (round 2)...',
  'Revoking old credential...',
  'Issuing new credential...',
  'Complete',
];
```

- [ ] **Step 3: Build the dev server and click through manually**

```bash
cd frontend && npm run dev
```

In a browser, open the admin dashboard, click "Change role" on a pending member, pick "Community Steward", and confirm the modal walks through `round 1 -> waiting -> round 2 -> revoking -> issuing` (the wait step may sit for many seconds in dev with a single browser; in a two-context E2E it advances when the second context rotates).

- [ ] **Step 4: Commit**

```bash
git add frontend/src/components/dashboard/ChangeRoleModal.vue
git commit -m "feat(ui): ChangeRoleModal shows round-1/wait/round-2 steps"
```

---

## Task 14: E2E test — unskip and extend the existing "promote User1" flow

**Files:**
- Modify: `frontend/tests/e2e/e2e-registration.spec.ts:692` (the existing "Role upgrade is skipped" block)

The existing registration suite already establishes a working **admin** and **User1** (a regular member) by the time it reaches `test('register and approve a second member', ...)`. There is even a comment at `e2e-registration.spec.ts:692`:

> "NOTE: Role upgrade (promoting User1 to Community Steward) is skipped for now — the ChangeRoleModal needs investigation."

The cleanest E2E for this plan is to **unskip and complete that block**, plus add one new test in the same file that proves the upgraded User1 can approve a fresh registrant.

- [ ] **Step 1: Read the current skip block + surrounding context**

```bash
grep -n "Role upgrade\|skip\|User1\|Change role\|Community Steward" frontend/tests/e2e/e2e-registration.spec.ts | head -30
```

Note the real helper names used in this file (no `import` invention required):

```ts
import { BackendManager } from './utils/backend-manager';
import {
  registerUser, loginWithMnemonic, setupTestConfig, setupBackendRouting,
  setupPageLogging, uniqueSuffix, /* …others as needed */
} from './utils/test-helpers';
```

The pattern is `const backends = new BackendManager(); const { port } = await backends.start('name'); ...; await backends.stopAll();`.

- [ ] **Step 2: Replace the skip with a real upgrade sequence**

In `test('register and approve a second member', ...)`, find the comment block at line ~692 and the surrounding logic that currently bypasses the role upgrade. After admin has approved User1 (which already happens in the existing flow), insert these steps in the admin's page:

```ts
// --- Promote User1 to Community Steward via the multisig upgrade flow ---
console.log('[Test] Opening ChangeRoleModal to promote User1');
await adminPage.goto('/dashboard');
await adminPage.locator(`[data-aid="${user1Aid}"]`).getByRole('button', { name: /change role/i }).click();
await adminPage.locator('text=Community Steward').click();
await adminPage.locator('button:has-text("Confirm")').click();

await expect(adminPage.locator('text=Inviting steward (round 1)')).toBeVisible({ timeout: 60_000 });
await expect(adminPage.locator('text=Waiting for steward to accept')).toBeVisible({ timeout: 120_000 });

// User1's frontend (already logged in via loginWithMnemonic earlier in this test)
// runs useMultisigJoin in the background; once its round-1 handler completes
// (resolveOOBI + rotatePersonalAid), admin's waitForMemberRotation returns.
await expect(adminPage.locator('text=Promoting steward to signer (round 2)')).toBeVisible({ timeout: 5 * 60_000 });
await expect(adminPage.locator('text=Complete')).toBeVisible({ timeout: 2 * 60_000 });
console.log('[Test] User1 upgrade complete');
```

Adjust `user1Aid` to whatever variable the existing test holds it in (find it with `grep -n "user1.*[Aa]id\|user1Aid\|aid.*user1" frontend/tests/e2e/e2e-registration.spec.ts`).

- [ ] **Step 3: Add the post-upgrade assertion in a new test**

Append this test inside the same `test.describe.serial` block, after the second-member test:

```ts
test('upgraded steward can approve a new registration', async ({ browser }) => {
  test.setTimeout(360_000);

  // Reload accounts persisted by earlier tests
  accounts = loadAccounts();
  if (!accounts.member?.mnemonic) {
    test.skip(true, 'Earlier tests must run first');
    return;
  }

  // Spin up a fresh registrant (User3)
  const user3Backend = await backends.start('user3-by-steward');
  const user3Context = await browser.newContext();
  await setupTestConfig(user3Context);
  await setupBackendRouting(user3Context, user3Backend.port);
  const user3Page = await user3Context.newPage();
  setupPageLogging(user3Page, 'User3');

  // Spin up User1 (the now-upgraded steward) using their saved mnemonic
  const user1Backend = await backends.start('user1-as-steward');
  const user1Context = await browser.newContext();
  await setupTestConfig(user1Context);
  await setupBackendRouting(user1Context, user1Backend.port);
  const user1Page = await user1Context.newPage();
  setupPageLogging(user1Page, 'User1');

  try {
    await registerUser(user3Page, `User3_${uniqueSuffix()}`);
    await loginWithMnemonic(user1Page, accounts.member!.mnemonic);

    // User1 should now see the steward-only "Approve" button (post-multisig-upgrade)
    await user1Page.goto('/dashboard');
    const approveBtn = user1Page.locator('[data-test="approve-registration"]').first();
    await expect(approveBtn).toBeVisible({ timeout: 60_000 });
    await approveBtn.click();

    // Verify a membership credential was issued from the ORG AID (not User1's personal AID).
    // The receiving user's credential view should reference the org prefix.
    await user3Page.reload();
    await expect(user3Page.locator('text=/Member|Community/')).toBeVisible({ timeout: 60_000 });
    // (Adjust the assertion above to match the actual credential-display UI; the
    //  important thing is the credential exists — its issuer field will be the org AID.)
  } finally {
    await backends.stop('user3-by-steward').catch(() => {});
    await backends.stop('user1-as-steward').catch(() => {});
    await user3Context.close().catch(() => {});
    await user1Context.close().catch(() => {});
  }
});
```

If the actual approve-button selector differs from `[data-test="approve-registration"]`, find the real one:

```bash
grep -n "data-test\|Approve\|onboard" frontend/src/components/dashboard/*.vue | head -20
```

- [ ] **Step 4: Run the registration suite**

```bash
cd frontend && npm run test -- e2e-registration.spec.ts --headed
```

Expected: all tests in the file pass, including the newly-completed upgrade block and the post-upgrade approval test.

- [ ] **Step 5: Commit**

```bash
git add frontend/tests/e2e/e2e-registration.spec.ts
git commit -m "test(e2e): complete the User1 multisig upgrade + steward issuance"
```

---

## Task 15: Update the design doc to reflect production behaviour

**Files:**
- Modify: `docs/multisig-upgrade-implementation-plan.md`

The design doc still carries a "Member's agent must learn admin's new key state before the EXN arrives" comment from the POC (in §2 step (b)). In production this is solved on EXN receipt, not before — fix the misleading phrasing.

- [ ] **Step 1: Replace the misleading comment**

Find in `docs/multisig-upgrade-implementation-plan.md` (around line 120):

```
  // (b) [Tests only — production has no in-process member.]
  // Member's agent must learn admin's new key state before the EXN arrives,
  // or member rejects the EXN as "sender not in kevers."
  // In production this is solved by the member's frontend re-resolving
  // admin's OOBI as part of the upgrade-acceptance flow.
```

Replace with:

```
  // (b) Production note: member's KERIA learns admin's new key state lazily.
  // The /multisig/rot EXN is delivered via mailbox regardless of whether
  // member's KEL view of admin is current. Member's notification handler
  // (useMultisigJoin) re-resolves admin's OOBI before acting on the EXN,
  // so verification at sign-time succeeds. No explicit pre-EXN sync is
  // required in production.
```

- [ ] **Step 2: Commit**

```bash
git add docs/multisig-upgrade-implementation-plan.md
git commit -m "docs(multisig): clarify production OOBI-refresh timing"
```

---

## Task 16: Verify all tests pass + smoke-check the build

- [ ] **Step 1: Run unit tests**

```bash
cd frontend && npm run test:script
```

Expected: all green, including the two new files.

- [ ] **Step 2: Type-check**

```bash
cd frontend && npx vue-tsc --noEmit
```

Expected: zero errors.

- [ ] **Step 3: Lint**

```bash
cd frontend && npm run lint
```

Expected: zero errors (warnings ok).

- [ ] **Step 4: Run the registration E2E (includes the new upgrade coverage)**

```bash
cd frontend && npm run test -- e2e-registration.spec.ts
```

Expected: all tests pass, including the unskipped upgrade block from Task 14 and the new "upgraded steward can approve" test.

- [ ] **Step 5: Final commit if anything was tweaked**

```bash
git status
# if dirty:
git add -A
git commit -m "chore(multisig): final lint / type fixes"
```

---

## Out of scope (documented for follow-up)

These are intentionally **not** in this plan; they are listed so they don't get silently lost.

1. **Migration for existing zero-witness orgs.** Pre-multisig-fix orgs in deployed databases have `toad: 0, wits: []` and cannot be upgraded. `addMemberRound1` now throws a clear error if called against one. A migration that rotates such orgs to adopt witnesses is its own follow-up plan.
2. **`useAdminActions.addStewardToOrgMultisig` `@deprecated` shim.** It still calls through to `upgradeMemberToSteward` and works as-is. Removing it is a separate cleanup.
3. **Mailbox-attached KEL bundling.** Option E in the design doc — bundle admin's `rot` events with the EXN so member doesn't need a separate OOBI fetch. Optimization, not a correctness fix.
4. **Idempotency / resume on browser refresh mid-upgrade.** Phase D in the design doc. Cover after this plan ships.

---

## Troubleshooting reference

If the E2E test fails, the most common causes (each maps to a step above):

| Symptom in admin context | Likely cause | Where to look |
|---|---|---|
| Stuck on "Inviting steward (round 1)" | `assignWitnesses` threw — pool < 2 witnesses | Task 1 — confirm `clean-start` test infra brought up all 6 witnesses |
| Stuck on "Waiting for steward to accept" past 5 min | Member's round-1 handler failed silently | Member context devtools — look for `[MultisigJoin] handler failed` |
| Round-2 EXN rejected with "Not enough signatures" | Stale master hab in `sendMultisigRotExn` | Task 6 — confirm the `masterFresh` re-fetch is in place |
| `joinGroup` rejected with "No verified signatures for evt" | Missing `await` on `keeper.sign` | Task 9 |
| `joinGroup` rejected with "sig verification failed" | Wrong index (defaulted to 0) | Task 9 — confirm `[memberIdx]` is passed |
| Member's KERIA returns "sender not in kevers" | Round-1 handler didn't refresh admin OOBI before processing | Task 11 — confirm `resolveOOBI(adminPrefix)` runs first |
