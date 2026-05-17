# Member → Admin upgrade implementation plan

Plan to wire the validated multisig protocol (see
`matou-infrastructure/keri/MULTISIG-POC-FINDINGS.md`) into matou-app so that
an admin can upgrade a regular member to admin status, and the upgraded
member can then issue membership credentials from the shared org identity.

## Goal

A community admin can promote any existing member to "admin." After the
promotion completes successfully on both sides, that member's frontend can
issue org-signed membership credentials (e.g., approve new registrations)
indistinguishably from the original founding admin.

The org identity stays one shared multisig with threshold = 1. Adding a
member to that multisig is what unlocks their authority — there is no
separate "admin role" credential to issue.

## What's already in place

The shapes of the four key functions exist in
`frontend/src/lib/keri/client.ts`:

| Function | Status |
|---|---|
| `createGroupAID(name, masterAidName)` | Creates the org but with `toad: 0, wits: []` — needs witnesses, otherwise upgrade can't work later. |
| `addMemberToGroup(groupName, newMemberAidPrefix, masterAidName)` | Two-rotation protocol + EXN, but missing pre-rotate, fresh-hab, and member-side key-state sync. |
| `joinGroup(groupName, notificationSaid)` | Receives EXN, parses, signs, calls join — but `keeper.sign()` isn't awaited and produces a wrong-index signature. |
| `issueCredential(...)` | Works from group AID — ships today. |

A coordinator already exists at `composables/useAdminActions.ts` ->
`upgradeMemberToSteward()` and `composables/useMultisigJoin.ts` already
watches `/multisig/rot` notifications and triggers `joinGroup`. So the
orchestration scaffolding is there; the gap is correctness inside
`addMemberToGroup` and `joinGroup`.

## What needs to change

Listed in dependency order. Each item is small in isolation; the danger is
landing one without the others (which produces silent failures).

### 1. `createGroupAID` — give the org witnesses

**File:** `frontend/src/lib/keri/client.ts:748`

**Change:** Replace `toad: 0, wits: []` with a witness set that is
*disjoint* from the personal AID's witness set, plus `toad >= 2`.

```ts
// Top of file or constants module
export const PERSONAL_WITNESSES = [
  'BLskRTInXnMxWaGqcpSyMgo0nYbalW99cGZESrz3zapM',
  'BM35JN8XeJSEfpxopjn5jr7tAHCE5749f0OobhMLCorE',
  'BF2rZTW79z4IXocYRQnjjsOuvFUQv-ptCf8Yltd7PfsM',
];
export const ORG_WITNESSES = [
  'BBilc4-L3tFUnfM_wJr4S4OJanAv_VmF_dJNN6vkf2Ha',
  'BIKKuvBwpmDVA4Ds-EpL5bt9OqPzWPja2LigFYZN2YfX',
  'BIj15u5V11bkbtAxMA7gcNJZcax-7TgaBMLsQnMHpYHP',
];

// Inside createGroupAID
const result = await this.client.identifiers().create(name, {
  algo: 'group',
  isith: '1',
  nsith: '1',
  toad: 2,
  wits: ORG_WITNESSES,   // was: wits: []
  mhab: masterAid,
  states: [masterAid.state],
  rstates: [masterAid.state],
});
```

**Why:** Without witnesses, the org's KEL only exists in the founding
admin's local KERIA. When we later try to add a new member, that member's
agent has no way to fetch the org's prior history → joining is impossible.
Witnesses act as the public history book.

**Why disjoint witnesses:** If the org uses the same witnesses *and* the
same threshold as the founding admin's personal AID, the org's inception
event ends up byte-identical to the admin's personal inception event (same
`k`, `n`, `b`, `bt`, `kt`, `nt`). KERIA rejects with `Already incepted
pre=<admin>`. Two disjoint sets sidestep this.

**Backward-compat note:** Existing orgs in deployed databases were created
with `toad: 0`. Upgrade for those orgs is permanently blocked at the
protocol level. We either (a) accept that and require these orgs to be
re-created, or (b) write a one-shot migration that rotates the org to
adopt witnesses. Option (a) is simpler and matches the "still pre-production"
status; option (b) would be its own follow-up.

### 2. `addMemberToGroup` — port the POC's three protocol fixes

**File:** `frontend/src/lib/keri/client.ts:837`

**Changes:** Replace the body with the POC's two-round shape and add three
critical steps the current code skips.

```ts
async addMemberToGroup(
  groupName: string,
  newMemberAidPrefix: string,
  masterAidName: string,
  newMemberClient?: SignifyClient,  // optional: same-process member for tests
): Promise<void> {
  // ROUND 1 ----------------------------------------------------------------

  // (a) Pre-rotate the master personal AID. signify-ts signs the group
  // rotation with the master's current signing key, but KERI requires that
  // key to be the *next-key* committed in the prior group event. Master must
  // rotate first to expose that key as current.
  await this.rotatePersonalAid(masterAidName);
  const masterState = (await this.client.keyStates().query(
    masterAid.prefix, masterAid.state.s, undefined,
  )).response;

  // (b) [Tests only — production has no in-process member.]
  // Member's agent must learn admin's new key state before the EXN arrives,
  // or member rejects the EXN as "sender not in kevers."
  // In production this is solved by the member's frontend re-resolving
  // admin's OOBI as part of the upgrade-acceptance flow.

  // (c) Query member's current key state.
  const memberState = (await this.client.keyStates().query(
    newMemberAidPrefix, '0', undefined,
  )).response;

  const rot1 = await this.client.identifiers().rotate(groupName, {
    states: [masterState],
    rstates: [masterState, memberState],
  });
  const rot1Op = await rot1.op();
  if (!rot1Op?.done) await this.pollOp(rot1Op.name, 30);
  await this.sendMultisigRotExn(
    masterAidName, groupName, groupPrefix, rot1, [newMemberAidPrefix],
  );

  // PAUSE for member: member must rotate their own personal hab before
  // ROUND 2 can be constructed. The original flow had no pause — admin
  // would do both rounds back-to-back, but ROUND 2 was built off stale
  // member state and silently produced an invalid rotation.
  await this.waitForMemberRotation(newMemberAidPrefix, '1');  // see §5

  // ROUND 2 ----------------------------------------------------------------

  await this.rotatePersonalAid(masterAidName);
  const masterState2 = (await this.client.keyStates().query(
    masterAid.prefix, /* new sn */, undefined,
  )).response;
  const memberState2 = (await this.client.keyStates().query(
    newMemberAidPrefix, '1', undefined,
  )).response;

  const rot2 = await this.client.identifiers().rotate(groupName, {
    states: [masterState2, memberState2],
    rstates: [masterState2, memberState2],
  });
  const rot2Op = await rot2.op();
  if (!rot2Op?.done) await this.pollOp(rot2Op.name, 30);

  // Re-fetch master hab before sending EXN — stale hab signs with the
  // old (no-longer-current) key and KERIA rejects the EXN as
  // "Not enough signatures."
  await this.sendMultisigRotExn(
    masterAidName, groupName, groupPrefix, rot2, [newMemberAidPrefix],
  );
}

private async sendMultisigRotExn(
  masterAidName: string,
  groupName: string,
  groupPrefix: string,
  rot: { serder: Serder; sigs: string[] },
  recipients: string[],
): Promise<void> {
  const signify = await import('signify-ts');
  const masterFresh = await this.client.identifiers().get(masterAidName);
  const sigers = rot.sigs.map(s => new signify.Siger({ qb64: s }));
  const ims = signify.d(signify.messagize(rot.serder, sigers));
  const atc = ims.substring(rot.serder.size);
  const smids = /* derive from rot event's k */;
  const rmids = /* derive from rot event's n indices */;

  await this.client.exchanges().send(
    masterAidName,
    groupName,
    masterFresh,                  // FRESH, not the stale top-of-fn fetch
    '/multisig/rot',
    { gid: groupPrefix, smids, rmids },
    { rot: [rot.serder, atc] },
    recipients,
  );
}
```

**Why each step matters:** see the "seven things that have to be exactly
right" section of `matou-infrastructure/keri/MULTISIG-POC-FINDINGS.md`.

### 3. `joinGroup` — await the sign call and use the group-level index

**File:** `frontend/src/lib/keri/client.ts:1027`

**Changes:** Two one-line fixes.

```ts
// BEFORE
const sigs = keeper.sign(signify.b(serder.raw));

// AFTER
const memberIdx = smids.indexOf(personalAid.prefix);
if (memberIdx < 0) {
  throw new Error(`member ${personalAid.prefix} not in smids ${JSON.stringify(smids)}`);
}
const sigs = await keeper.sign(
  signify.b(serder.raw),
  true,
  [memberIdx],
  [memberIdx],
);
```

**Why:** `keeper.sign()` is async in signify-ts 0.3.x. Without `await`,
`sigs` is a Promise that serializes as `{}` in the JSON body and KERIA
returns "No verified signatures for evt." And the GROUP-level index is
required so KERIA's verifier matches `sig.index → rot.k[index]` —
defaulting to 0 tries to verify against admin's key.

### 4. Member-side: re-resolve admin's OOBI before joining

**File:** `frontend/src/composables/useMultisigJoin.ts`

**Change:** Before calling `joinGroup`, the watcher needs to (a) make sure
member's view of admin's KEL is up-to-date and (b) rotate member's own
personal hab between the round-1 and round-2 notifications.

Two designs are possible:

**Option A (simpler):** Treat *every* `/multisig/rot` notification the same
— re-resolve admin's OOBI, rotate own personal hab if not already rotated
since the last seen round, try `joinGroup`. If we get a round-1
notification (where member is in rmids but not smids), the join attempt
will succeed but won't make member a signer yet; the round-2 notification
arrives later and the second join completes the upgrade.

**Option B (explicit two-round handling):** Read the EXN's `smids` and
compare to member's own prefix. If member is in `rmids` but not `smids`,
this is round 1 — just mark as read, re-resolve admin's OOBI, rotate own
personal hab, and don't call `joinGroup`. If member is in `smids`, this
is round 2 — call `joinGroup`.

Option B is closer to the POC and easier to reason about; Option A is
fewer code paths. **Recommend Option B.**

```ts
// In checkAndJoinMultisig
const exn = await client.exchanges().get(notification.a.d);
const smids = exn?.exn?.a?.smids as string[] | undefined;
const rmids = exn?.exn?.a?.rmids as string[] | undefined;
const me = (await client.identifiers().list()).aids[0]?.prefix;

const isRound1 = rmids?.includes(me) && !smids?.includes(me);
const isRound2 = smids?.includes(me);

if (isRound1) {
  // Re-sync admin's KEL, then rotate own personal hab.
  const adminPrefix = smids[0];  // by convention, admin is at index 0
  const adminCesrUrl = `${keriClient.getCesrUrl()}/oobi/${adminPrefix}`;
  await keriClient.resolveOOBI(adminCesrUrl);
  await keriClient.rotatePersonalAid(me);
  await keriClient.markNotificationRead(notification.i);
  return false;  // wait for round 2
}

if (isRound2) {
  // Sync admin's NEWER state (admin pre-rotated again).
  const adminPrefix = smids[0];
  await keriClient.resolveOOBI(`${keriClient.getCesrUrl()}/oobi/${adminPrefix}`);
  const gid = await keriClient.joinGroup(orgName, notification.a.d);
  // … existing post-join setup
}
```

### 5. Admin-side: wait for member to rotate before sending round 2

**File:** `frontend/src/composables/useAdminActions.ts:368` (in
`upgradeMemberToSteward`)

**Change:** The current code calls `addMemberToGroup` and immediately
proceeds to credential revoke/re-issue, assuming the multisig was
extended. With the two-round protocol, admin must:

1. Send the round-1 EXN.
2. Wait for member's personal AID to reach sn=1 (poll
   `keyStates().query(memberPrefix, '1')` with a generous timeout).
3. Send the round-2 EXN.

This means `addMemberToGroup` needs to be split into `addMemberRound1`
and `addMemberRound2`, with a poll step in between — OR the wait happens
inside `addMemberToGroup` and we accept a long-running call (~30s–
several minutes depending on member responsiveness).

```ts
// useAdminActions.ts
processingStep.value = 'Inviting steward (round 1)...';
await keriClient.addMemberRound1(orgName, stewardAid, personalAid.name);

processingStep.value = 'Waiting for steward to accept...';
await keriClient.waitForMemberRotation(stewardAid, '1', { timeoutMs: 300_000 });

processingStep.value = 'Promoting steward to signer (round 2)...';
await keriClient.addMemberRound2(orgName, stewardAid, personalAid.name);

processingStep.value = 'Waiting for steward to join...';
// member's join is async; we know it's done when group's KEL advances
// to s = (s before round 2) + 1 with both signers in k.
```

**UX corollary:** the upgrade dialog needs to surface a "waiting for
member" intermediate state, and the member's UI needs to clearly prompt
them to "accept" the upgrade (which under the hood is a personal-hab
rotation triggered by a button click in the round-1 notification handler).

### 6. Membership credential issuance — already works

Once member has joined the group AID via round 2, issuing credentials is
exactly the same code path admin uses today: `keriClient.issueCredential(
orgName, registryId, schemaSAID, recipient, data, message)`. No change
needed. The POC validates this in phase 10 by having member create their
own registry on the shared org and issue a credential from it.

The *registry* may need to be re-shared to the upgraded member (member's
agent doesn't auto-sync admin's existing registry/TEL). Two approaches:

- **Admin shares the regk** (it's already in the org-config that member
  fetches at upgrade time — `getOrFetchOrgConfig()`). Member's
  `issueCredential` call passes that regk; KERIA pulls the registry's
  TEL from the org's KEL anchors automatically when it sees the regk.
- **Member creates a fresh registry** on the org AID. Cleaner separation
  ("admin-issued" vs "member-issued") but two registries per org is
  unusual.

Recommend the first approach: re-use the existing registry, ensure
`org-config.yaml` has `registry.id`, and have member's
`issueCredential` use it.

## Phased rollout

Each phase is independently shippable; later phases require earlier ones.

### Phase A: Make new orgs upgradeable (small, low-risk)

- Land the `createGroupAID` witness fix (#1).
- Add a one-time "regenerate org keys" admin flow for existing orgs that
  rotates the org AID to add witnesses (skip if the org was already
  created with witnesses).
- Ship; no user-visible feature change.

### Phase B: Fix the protocol (medium, contained to KERI client)

- Land `addMemberToGroup` rewrite (#2): split into round 1 / round 2,
  pre-rotate master, fresh hab for EXN.
- Land `joinGroup` two-line fix (#3): await + indexed sign.
- Land `useMultisigJoin` two-round handling (#4).
- Add `keriClient.rotatePersonalAid()` and
  `keriClient.waitForMemberRotation()` helpers used by both sides.
- Cover with a Vitest unit test that imports `client.ts` and verifies
  the dispatched HTTP call shapes against fixtures from
  `keri/test-multisig.ts`.
- Cover with the existing Playwright E2E or a new one that exercises
  the full admin-promotes-member upgrade across two browser contexts.

### Phase C: Wire the UX (small, UI work)

- Update `upgradeMemberToSteward` to use the split round-1/round-2 calls
  with an intermediate wait (#5).
- Show admin a "waiting for member" state during that wait.
- Add a "Steward upgrade pending — accept to continue" prompt in the
  member's frontend that fires the personal-hab rotation. (This may
  already be implicit in `useMultisigJoin` if Option B from §4 is
  taken; if so just verify the UX makes sense.)
- Issue/re-issue the membership credential with the new role at the
  end (already wired in `useAdminActions.upgradeMemberToSteward`).

### Phase D: Polish

- Idempotency: if the upgrade is interrupted (browser refresh, network
  blip) between rounds, the next render should pick up where it left off
  from `notifications().list()` + the group AID's current sequence.
- Timeouts and user-friendly errors for "member never accepted" and
  "round 2 timed out waiting for KEL to advance."
- Documentation: a short "How an admin upgrade works" walkthrough for
  matou-docs.

## Open questions

1. **How does member discover admin's pre-rotation?** Today there's no
   push; we'd add polling in `useMultisigJoin` to re-query admin's
   key state on every tick (cheap), or trigger it on receipt of the
   round-1 EXN (more efficient, but couples to EXN handling).
2. **What happens if admin's personal AID has already been rotated for
   another reason?** Each upgrade adds two more rotations to admin's
   personal AID. This is fine — KELs are append-only and can grow
   indefinitely — but is worth surfacing in admin UX so they're not
   surprised.
3. **Does the matou-app KERIA patch break anything?** The POC ran
   against the matou-patched KERIA image with no patch-related issues.
   The `exchanger_patch.py` doesn't touch `/multisig/*` routes (those
   are vanilla keripy `MultisigNotificationHandler`s); it only adds
   custom matou registration routes.
4. **Migration story for existing orgs without witnesses.** If we have
   any production orgs created with `toad: 0`, they can't be upgraded
   without first being rotated to adopt witnesses. Worth a one-line
   audit before this lands.

## Validation checklist

When the implementation is done, the matou-app should be able to:

- [ ] Founding admin creates an org. (Already works.)
- [ ] Founding admin issues a credential from the org. (Already works.)
- [ ] Founding admin promotes a regular member to "admin" through the
      UI; UI shows progress through "round 1," "waiting for member,"
      "round 2."
- [ ] Promoted member's UI shows a prompt to accept the upgrade,
      completes it without manual intervention beyond a button click.
- [ ] After upgrade, promoted member can approve a new pending
      registration (which issues a membership credential from the org).
- [ ] Original admin and promoted member are interchangeable for
      credential issuance — the recipient sees a credential issued by
      the org AID with no way to tell which member signed it.

## Reference

- `matou-infrastructure/keri/test-multisig.ts` — the validated 13-phase POC
- `matou-infrastructure/keri/MULTISIG-POC-FINDINGS.md` — protocol-level
  explanation in plain language
- [signify-ts multisig-join.test.ts](https://github.com/WebOfTrust/signify-ts/blob/main/test-integration/multisig-join.test.ts)
  — the canonical reference flow
