# 2026-09-30 whakatohea-demo: second steward cannot approve (500), four orphan group ixns

Status: cause found; fix on branch `design/steward-peer-registry` (spec `docs/superpowers/specs/2026-09-30-steward-peer-registry-design.md`). Not yet repaired on the live org.

## Facts (read from the witness `https://witness.whakatohea-demo.idss.nz/oobi/EEPniUBM5MvRp-H_Lp_JVTbR9BEtgOa6Sp3gyypzjQZJ`, 2026-09-30)

- Org group AID: `EEPniUBM5MvRp-H_Lp_JVTbR9BEtgOa6Sp3gyypzjQZJ` (1-of-N).
- Community registry: `EIb--9e6KriodN1yszNhP9l7n0yyqvx3j3Hb1ej_vycT`.
- Founder AID `EI5am6mvYoV0XJUM2jU51VALSTfT0Gvnbtyyzo7ZQ25x`: signing index 0, key `DI2FJ...`.
- Second steward engie `EH-q_03fu9KpxG_ZglcC_P3wm_-R07Bh0g_Tf8_zr8dd`: index 1, key `DFAKv...`. The group has had two signers since sn 12.
- Group sn 17-20 are four ixns, each signed at index 1 (engie), each anchoring an `iss` for a credential that never existed.

## Symptom

engie's Approve on a membership fails: `POST /identifiers/whakatohea-demo/credentials -> 500`.

## Cause

KERIA 0.4.0 `CredentialCollectionEnd.on_post`:

1. Checks `regk in tevers` (404 otherwise). engie holds a Membership from the community registry, so the registry is known to the agent as a verifier and the check passes.
2. `identifierResource.interact` accepts and witnesses the group ixn.
3. `Registrar.issue` does `rgy.regs[regk]`. `regs` holds only registries the agent itself created, so this raises `KeyError` and KERIA returns 500.

Each retry therefore left one more witnessed ixn anchoring an `iss` that never happened (four retries: sn 17-20).

Root gap: ADR 0235 d.4 says "promotion carries the ledger into the new steward's agent". It was never built, so a promoted steward's agent never holds the registry as an issuer.

## The orphans are harmless

The four ixns anchor seals for TEL events that do not exist. They cannot be removed from the KEL. They only advance the group's sn. The one real risk is a fork: an agent that does not know sn 17-20 and issues from its stale view re-anchors sn 17 (the #63 shape). The founder's agent may not know them.

## Repair path (spec section 8, step 3), once the new app is released

1. Founder signs in and acts: the app first syncs the group from the witness (to sn 20), so no fork.
2. engie signs in: the app adopts the registry into engie's agent.
3. The founder's next sign-in pushes the credential history to engie (history push).
4. The waiting applicant is approved by either steward.

Group sn 17-20 remain as anchor-less orphans.

## Two legacy e2e defects found and fixed in the same work

The registration e2e on elitebook-03 (app `8e58475`, infra `79fb999`) went 3 passed / 1 flaky / 1 failed and exposed:

1. False green in test 2: the promoted steward clicked Approve before its app had joined the group, `getOrgAidName` found no group identifier and silently fell back to the steward's personal AID, so the Membership was issued by the personal AID. The spec never checked the issuer. Fixed: the group name no longer falls back, and the e2e asserts the issuer is the org group.
2. Second promotion rotated the joiner three times (test 5, `member2 must now sign for the group`): a forwarded round-1 `/multisig/rot` was treated as a new round 1, twice concurrently (no in-flight guard in `checkAndJoinMultisig`, each run blocking ~30 s in `queryKeyStateToSn`), so member2 rotated 0->1->2->3 while round 2 committed its s=1 key. Likely regression window: #520 (`ef5d122`, 2026-09-16). Fixed: in-flight guard and a rule that a forwarded round 1 does not trigger a rotation.

Verification: KERIA 0.4.0 harness `frontend/tests/infra` (both modes green, see its README) and the registration e2e (second promotion and replicated issuance/revoke green).
