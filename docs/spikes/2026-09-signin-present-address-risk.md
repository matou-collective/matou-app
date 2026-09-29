# Risk of a sign-in code whose `present` address is not its `door`'s

**Spike for #694, assessing finding #693. Security research — no sign-in code is changed.**
Filed 2026-09-29 on Ben's word (idss ADR 0255: what the wallet trusts is Ben's to rule).

## The finding in one line

A `matou://signin` code carries `door` (the sign-in site the signature binds to
and whose card is drawn) and, apart from it, `present` (where the wallet POSTs).
The wallet posts to `present` verbatim and **no code compares the two origins**,
so a code with `door=<a trusted site>` and `present=<any address>` draws the
trusted site's card, skips first-contact, and hands the signed presentation —
and, on an armed sign-in, the steward's passcode — to the other address.

**Severity: HIGH overall, CRITICAL on the armed control-panel / unlock path.**
The worst realistic outcome (armed path) is theft of a steward's wallet passcode
(the KERI bran — root control of the identity). The ordinary-sign-in path adds
much less over what a genuine code already allows (see Q3).

**How to read the marks:** *Proven* = a script test in this repo demonstrates it
against fakes (`frontend/tests/scripts/signin-present-address-risk.test.ts`, and
the pre-existing `signin-handover.test.ts`). *Reasoned* = read from the code, no
live door driven.

---

## Q1 — What does the receiver of a mis-posted presentation hold?

The wallet POSTs the body built in `runApprove`
(`frontend/src/lib/signin/approve.ts:63-70`) to `present`
(`frontend/src/lib/signin/present.ts:80-96`). The body is `PresentBody`
(`present.ts:30-50`). Each field and what it discloses:

| Field | Value | What it discloses |
|-------|-------|-------------------|
| `aid` | the member's holder AID prefix (`approve.ts:63`) | the member's public KERI identifier — a stable, linkable identity |
| `challenge_id` | the code's `c` nonce (`approve.ts:63`) | the challenge (see Q2 — the replay hinge) |
| `response` | qb64 signature over `idss-idp:<door>:<aid>:<challenge>` (`approve.ts:61`, `present.ts:25-27`) | a valid signature **bound to the real `door`** — worthless at a lookalike, but see Q2 |
| `presentation` | the bare ACDC + its issuance event, as a CESR stream (`approve.ts:56-57`, `credential.ts` `trimPresentation`) | **the whole credential**: schema SAID, issuer AID, holder AID, and every attribute in `a.*` — e.g. `a.committee`, `a.role`, and any name/role/membership attributes the schema carries |
| `armed` | `true` only on an armed steward sign-in (`approve.ts:68`) | that this is a control-panel unlock (see Q4) |

**Proven** (fields and their sourcing): `signin-present-address-risk.test.ts`
asserts `runApprove` posts `response = SIG(idss-idp:<door>:<aid>:<challenge>)`,
`presentation = <the exported stream>`, `aid`, and `challenge_id` to the foreign
`present` verbatim. **Reasoned** (that the ACDC's attributes are the credential's
real attributes): read from `credential.ts` / the golden `presentation` note.

So the receiver holds a full, self-verifying disclosure of the member's identity
and the contents of whichever credential the door asked for — at the control
panel, the Administrator credential; at a service, the member's Membership.

---

## Q2 — Can it be replayed at the real door to sign the receiver in as the member?

**Yes — and this is the ordinary-sign-in path's real teeth. Reasoned.**

The signature binds `door` and `challenge` (`present.ts:25`), not `present`. So a
presentation posted to the attacker is a valid answer to the real door **for
whatever challenge the code carried**. Work the attacker's build order:

1. The attacker opens the real door's auth flow **in their own browser** and
   obtains a genuine challenge: `GET /login/app/challenge?authRequestID=<the
   attacker's browser's request>` (golden `ask.path`). The door mints
   `challenge_id` bound to the attacker's browser session and returns `door` +
   `present_url` (both the real door's).
2. The attacker builds a code `door=<real door>`, `c=<that challenge>`,
   `present=<attacker's collector>`, keeping the real `door` so the wallet draws
   the trusted card and binds the signature to the real door.
3. The member scans/opens it, Approves; the wallet posts the presentation to the
   attacker (**Proven**: the post goes to `present` verbatim).
4. The attacker replays the collected body to the **real** door's present route
   (`POST <real present_url>`). The signature verifies (bound to the real door,
   the real challenge, the member's aid). The challenge was minted for the
   attacker's browser, so **the browser polling `/login/app/status?c=…` — the
   attacker's — is the one signed in** (golden `status_poll.verified`, and the
   `ask` note that a challenge is minted for one browser's auth request).

Caveat (**reasoned**): the challenge is single-use and two-minute-lived (golden;
ticket statement). The attacker must replay within that window and before any
other consumer spends it — trivial, since the attacker controls the collector and
replays immediately. The door answering `Access-Control-Allow-Origin: *` (golden,
ticket) means the collector could even be a browser page.

**Net:** the attacker signs *their own browser* in **as the member**.

---

## Q3 — What does this add over showing the member the real door's own code?

An attacker can already put a **genuine** code for their own browser in front of
a member (nothing stops that — the door answers any origin, and codes are public
by construction). If the member Approves a genuine code, the presentation goes to
the **real** door and the attacker's browser is signed in as the member. **So the
"sign in as the member" outcome in Q2 is NOT new** — the `present` gap does not
add it. Stated precisely, the gap adds exactly three things over a genuine code,
and no more:

1. **Direct disclosure of the raw presentation to an attacker of choice.** With a
   genuine code the ACDC goes to the real door; the attacker gets a session but
   not necessarily the raw CESR stream. With the gap, the attacker receives the
   credential and all its attributes in the clear (Q1), off any door. *Reasoned.*
2. **Custody and timing of the artifact.** The attacker holds the signed body and
   chooses when/whether to replay (within the challenge's life), rather than the
   door consuming it on arrival. Marginal. *Reasoned.*
3. **The armed passcode escalation (Q4).** This is the one large addition: with a
   genuine code the passcode seals to the panel's key via the *real* door's
   handover routes; with the gap it seals to a key the *attacker* chose.
   *Proven.* This is what lifts the finding from "phishing you could already do"
   to CRITICAL.

What the gap does **not** add: it does not defeat the door-binding of the
signature (a lookalike `door` is still worthless), and it does not create the
sign-in-as-member outcome from nothing — that was always reachable with a genuine
code. The gap's true novel damage is disclosure (Q1) and the passcode (Q4).

---

## Q4 — The steward's passcode (highest stakes). Traced in code.

**A code with a foreign `present` leads the wallet to seal the steward's passcode
to a key the attacker chose. Proven.**

Which address the wallet uses for the handover, and where it reads the sealing
key from — traced end to end:

1. On an armed sign-in (`offer=seat-unlock` approved with the line on, or
   `offer=unlock` by a steward), `approve()` arms and, on a `verified` verdict,
   fires the handover **with `a.present`** — not `a.door`:
   `frontend/src/composables/useSignin.ts:601`
   → `void deps.answerHandover(a.present, a.challenge, aid)`.
   `answerHandover` is `runHandover` (`useSignin.ts:226`).
2. `runHandover(presentUrl, …)` builds **both** handover routes from
   `presentUrl`: `handoverKeyUrl(presentUrl, …)` and `handoverSealUrl(presentUrl)`
   (`frontend/src/lib/signin/handover.ts:146, 161, 53-62`), each a `new URL(…,
   presentUrl)` — resolved relative to `present`, **never `door`** (the module
   header and #1669 say so explicitly).
3. It reads the panel's sealing verkey off the key route
   (`handover.ts:94-110`, `readBoundVerkey`) — i.e. off `<present>/handover/key`.
4. It seals the steward's passcode to **that** verkey (`handover.ts:158`
   `deps.seal(challenge, verkey)` → `sealForRequest` → the `PasscodeSealer` that
   reads the live passcode and calls `sealPasscode(bran, verkey)`,
   `useSignin.ts:237-243`, `frontend/src/lib/signin/sealedPasscode.ts:55-64`).
5. It posts the ciphertext to `<present>/handover/seal` (`handover.ts:161-165`).

So the wallet reads the panel's key from **`present`**, not `door` and not the
code (no code carries a sealing key — `ek=` is retired, `link.ts:40-42`). Point
`present` at an attacker and the attacker's server answers step 3 with a verkey
**it** minted; the wallet seals the passcode to it (step 4) and hands the box to
the attacker (step 5). The attacker opens the sealed box (a libsodium sealed box
to their own key — `sealedPasscode.ts:55-64`) and recovers the 21-char bran.

The bran is the wallet's master passcode — the salt from which the identity's
signing keys derive. **Recovering it is full takeover of the steward's KERI
identity**, not merely a session.

One precondition worth stating (**reasoned**): the handover fires only after the
verdict is `verified` (`useSignin.ts:583, 600`). The attacker controls `present`,
so the attacker's collector simply answers `{status:"verified"}`
(`present.ts:113-114`) — no real door is needed for the armed path to complete.

**Proven:** `signin-present-address-risk.test.ts` "an armed handover seals the
passcode to a verkey the ATTACKER chose, and posts it to the attacker" — the
sealer records `[ATTACKER_VERKEY]` and the box is posted to
`https://attacker.example/collect/handover/seal`. Also "derives BOTH handover
routes from the (foreign) present_url".

---

## Q5 — What the member sees. Does #692's revoked memory change it?

**The receiver can make the wallet show "Signed in" / "Unlocking that computer"
falsely. Reasoned (composable), Proven (verdict mapping).**

`presentToDoor` reads the outcome from `body.status`, not the HTTP code beyond the
lifecycle ones (`present.ts:113-120`). The attacker's collector answers
`{status:"verified"}` → `{outcome:'verified'}`. In `approve()` that drives
`phase.value = 'done'` (`useSignin.ts:583-605`); the done face reads "Signed in",
or on an armed/unlock sign-in "keep the app open… Unlocking that computer"
(`keepOpen`, `useSignin.ts:343`). The member believes they signed into the
trusted site. Whether a real session exists depends only on whether the attacker
chose to replay to the real door (Q2) — the member's screen says "Signed in"
either way.

**#692's revoked memory does not blunt this.** It gates only *remembering* a
`revoked` answer, via `answeredByTheDoor(a.door, a.present)`
(`useSignin.ts:587, 632`; `revokedMemory.ts:62-65`). On a foreign `present` that
helper is **false**, so:
- a `revoked` answer from the attacker is **not** remembered (good — the attacker
  cannot poison the wallet's view of a credential), and
- `forgetRevoked` is **not** called on a foreign `verified` (so the attacker
  cannot clear a real revocation either).

But #692 changes **nothing** about the post itself, the false "verified", or the
passcode handover. **Proven:** `answeredByTheDoor(TRUSTED_DOOR, ATTACKER_PRESENT)
=== false`, and `=== true` only when the origins match. The origin comparison
#693 would need **already exists in the codebase** (`answeredByTheDoor`); today it
guards only revoked memory, not the wire.

---

## Q6 — How a code reaches the wallet, and what (if anything) protects it

Three intake paths, all landing on the same approve card built from the code's
params: camera scan and paste (`useSigninScan.ts:24, 77` `signinLinkToLocation`),
and the `matou://signin` deep link (`useDeepLink.ts:68-75` → same
`signinLinkToLocation`; classified by `deepLink.ts:37-39` → `isSigninLink`).

**Can a web page or another app open the deep link with no scan? Yes. Reasoned.**
The Android intent filter registers scheme `matou` with `category BROWSABLE`
(`frontend/src-capacitor/android/app/src/main/AndroidManifest.xml:49-54`).
BROWSABLE means a web page (`window.location='matou://signin?…'` or an `<a>` tap)
or another installed app can fire the intent; `@capacitor/app` surfaces it as
`appUrlOpen` and `handleDeepLink` routes straight to the approve card
(`useDeepLink.ts:157-159`). iOS `CFBundleURLTypes` and the Electron protocol
client are the same shape (`useDeepLink.ts` header). So the attack does **not**
require a QR scan — a malicious page the steward merely visits can launch the
armed unlock card.

**Does first-contact / home-site reading protect when `door` is trusted? No.**
`prepare()` ends at `first-contact` only when `!knownDoors.isKnown(parsed.door)`
(`useSignin.ts:465`); a known/home door skips straight to `card`
(`isKnown`/`isHome`, `useSignin.ts:428, 465`). The whole premise of the finding
is `door=<a trusted site>`, so first-contact is skipped by design and offers
**no** protection here. It would only help against an *unknown* door — and even
then the prompt trusts the `door`, saying nothing about `present`.

---

## Q7 — Does any legitimate deployment post to a different origin from its door?

**No legitimate posture posts to a different *origin*. Reasoned, from the golden.**

The wire golden is the contract (`frontend/tests/scripts/fixtures/app-door/
app-door-golden.json`). In every posture the present URL and the handover routes
are on the door's own origin:

- Ordinary service sign-in: `sign_in_site` = `https://id.whakatohea.idss.nz/login`,
  `present_url` = `https://id.whakatohea.idss.nz/login/app/present`.
- Control-panel and unlock hop: same origin; handover routes
  `/login/app/handover/key` and `/login/app/handover/seal` — same origin.

The contract's phrase "`present.url`: *the ask's present_url, verbatim — never
derived from door*" is about the **path** (the wallet must not build the path
itself — #574/#1669), not the origin. The golden never shows `present` on a
different origin from `door`. So refusing a cross-**origin** `present` (Q8 option
1) would reject **no** posture the descriptor or golden describes. (If a future
deployment split the present host onto a different origin from the login host, it
would need `door` and `present` explicitly declared as an allowed pair — none
exists today.)

---

## Q8 — The options, each with its cost

1. **Refuse a code whose `present` origin is not the `door`'s.**
   *Cost:* smallest. The comparison already exists (`answeredByTheDoor` /
   `originOf`, `revokedMemory.ts:62-65, 129-138`); wire it into `parseSigninLink`
   / `prepare` to refuse mismatches. Breaks no golden posture (Q7). Closes the
   ordinary-path disclosure/replay-collection **and** the CRITICAL armed passcode
   theft. Is a wire-contract/trust change (Ben's to rule per idss ADR 0255). This
   is the recommended option.

2. **Show the post address on the card.**
   *Cost:* low to build; weak protection. It leans on the member noticing a
   foreign host on a card that otherwise looks trusted — exactly the judgement
   phishing defeats. Does not by itself stop the armed passcode path. Useful only
   as an *addition* to (1), not a substitute.

3. **Drop `present` from the code; the wallet derives it from `door`.**
   *Cost:* highest — a real wire-contract change on both sides (contradicts
   #574/#1669, which deliberately made the wallet post to a carried `present`
   rather than guess a path). Strongest binding (there is no separate address to
   diverge), but it removes a degree of freedom the door may want (e.g. a present
   host that differs in path). Larger blast radius; needs idss to move first.

4. **Leave as is.**
   *Cost:* accepts CRITICAL steward-passcode theft on the armed path and a
   member-identity/credential disclosure on the ordinary path, both reachable
   with no scan (Q6). Not advisable.

---

## Recommendation

**Adopt option 1: refuse a code whose `present` is not on the `door`'s origin.**
It is the smallest change, reuses an origin check the codebase already trusts for
#692, rejects no legitimate posture in the golden (Q7), and is the only option
that closes the CRITICAL armed passcode-theft path without waiting on an idss wire
change. Pair it with option 2 (show the post address) for defence in depth if
Ben wants a visible signal, but (1) is the load-bearing fix. The decision is a
sign-in trust change and a wire-contract touch, so it is Ben's to rule (idss ADR
0255); this spike changes no sign-in code.

---

## Evidence — what is proven here

`frontend/tests/scripts/signin-present-address-risk.test.ts` (passes today; it
pins current behaviour, so a future fix will red it):

- `runApprove` posts to a foreign `present` verbatim while the signature binds the
  real `door` (Q1, Q2, Q3).
- `answeredByTheDoor` is false for a foreign `present`, true only on an origin
  match — the check exists but gates only revoked memory (Q5).
- `handoverKeyUrl` / `handoverSealUrl` follow the foreign `present`, and an armed
  `runHandover` seals the passcode to an attacker-chosen verkey and posts it to
  the attacker (Q4 — the CRITICAL path).

Pre-existing `frontend/tests/scripts/signin-handover.test.ts` independently pins
that the handover routes derive from `present_url`, never `door`.

## What could not be answered without idss source

Nothing here required the idss source: the wallet-side behaviour is fully in this
repo, and the door-side facts used (challenge single-use/two-minute life,
`Access-Control-Allow-Origin: *`, the handover capability delivered over OIDC) are
stated in the ticket and pinned by the vendored golden. The one door-side
assumption that is *reasoned, not proven here* is that the real door verifies a
replayed body bound to it regardless of which browser minted the challenge (Q2) —
that is the golden's stated contract, but driving it end to end would need a live
or faked idss door, which this spike does not touch by rule.
