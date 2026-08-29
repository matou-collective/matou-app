# KERI-Signed Request Authentication

Enforcement 3/5 of the RBAC plan (issue #18). Makes the `X-User-AID` identity
trustworthy by requiring a cryptographic proof of control over the AID's current
signing key before the backend resolves any roles.

## Model: signed-challenge login → session token

Chosen by maintainer decision (2026-08-10) over per-request signing:

1. **Challenge** — the client POSTs its AID to `/api/v1/auth/challenge`; the
   backend returns a random, single-use, time-bounded nonce
   (`ChallengeStore`, default TTL 2 min). The AID must be a well-formed qb64
   prefix (`auth.ValidAID`) or the request is a 400.
2. **Sign** — the client signs the **domain-separated login message**
   `matou-auth:<aid>:<nonce>` (`auth.SignedMessage` / `loginMessage` in
   `src/lib/api/client.ts`) with the AID's signing key. In the app this is
   `KERIClient.signChallenge()` (signify-ts `keeper.sign(b(message), false)` →
   a non-indexed Ed25519 `Cigar`, CESR code `0B`). The prefix stops a signature
   obtained for any other purpose (or for another AID) from doubling as a login
   proof, and vice versa.
3. **Verify + mint** — the client POSTs `{aid, challenge, signature}` to
   `/api/v1/auth/login`. The backend:
   - checks the challenge is outstanding for that AID (without consuming it),
   - resolves the AID's **current** signing key read-only from KERIA
     (`KeyStateResolver`; never trusts a client-supplied key),
   - refuses anything but a single-key, threshold-1 AID (`403`; see
     *Multisig* below),
   - consumes the challenge and verifies the signature against that key
     (`internal/auth` CESR decode + `ed25519.Verify`),
   - mints a short-lived session token (`SessionStore`, default TTL 30 min,
     `MATOU_AUTH_SESSION_TTL` to override), recording a hash of the key it was
     minted against.
4. **Per request** — the client sends `Authorization: Bearer <token>`.
   `SignedAuthMiddleware` inspects the bearer and, under enforcement, resolves
   it into one of three cases:
   - **A valid session token** — the verified AID is recorded on the request
     context (`api.VerifiedAID`) and `X-User-AID` is rewritten to it before RBAC
     runs.
   - **The per-launch API token** — treated exactly like "no token": any
     client-supplied `X-User-AID` is **stripped** and the request passes through
     as anonymous (protected routes then 401, public reads serve). The API token
     is a legitimate bearer the app sends before it has a session (boot,
     first-run, `identity/set`), and `TokenGuardWithSessions` has already
     accepted it one layer out; it must not be mistaken for an invalid session.
     It cannot assert a trusted identity, so this is strictly least-privilege.
   - **Anything else** (an unknown/expired token) — rejected with 401
     `{"error":"invalid or expired session"}`.

   A request with **no token** likewise has any client-supplied `X-User-AID`
   stripped and reaches RBAC anonymously.

**Sharing the Authorization header with the API token.** The per-launch API
token (issue #16, `TokenGuard`) travels in the same header. `TokenGuardWithSessions`
accepts *either* the API token *or* a live session on mutating requests. This
does not weaken TokenGuard: the login endpoints that mint sessions are
themselves mutations guarded by the API token, so every session holder already
proved possession of it. The frontend fetch wrapper (`backend-auth.ts`) sends
the session when one is live and the API token otherwise — and always the API
token to `/api/v1/auth/*`, so an expired session can never block re-login.

**Session lifecycle in the app.** `identityStore.signInToBackend()` runs on
`connect()`, after `createIdentity()`, and from `setCurrentAID()` (org setup,
invite claim), so a first-run user is never tokenless. The wrapper treats a
token as gone 30 s before its `expiresAt`, and on any 401 answered to a session
it re-runs the login once (concurrent 401s share one refresh) and retries the
request, so expiry and revoke-on-rotation are transparent.

**Revoke-on-rotation.** When an AID's key state rotates, its sessions are
invalidated. The backend observes rotation via the KEL sync path
(`/api/v1/sync/kel` → `SyncHandler.SetRotationHook` → `Verifier.OnRotation`),
which fires **only** when the request carries a valid session for the very AID
whose KEL is being synced (`api.VerifiedAID(r) == userAid`). The hook receives
the AID alone: it drops the resolver cache and re-fetches the key state from
the authoritative source, revoking sessions only if the keys really differ from
those they were minted against. Key material in the request body is never
used, so this unauthenticated endpoint cannot log arbitrary AIDs out. Short
session TTL bounds the window regardless.

## Abuse resistance

- **Challenges are keyed by nonce**, not by AID: several may be outstanding for
  one AID (two clients, a retry), and a wrong guess never evicts a legitimate
  one — an attacker looping the public endpoints cannot lock a user out. A
  nonce is deleted only on success or expiry.
- **Rate limits** on `/auth/challenge` and `/auth/login`: per client IP and per
  AID, burst 20, refill 1/s → `429` with `Retry-After`.
- **Bounded memory**: challenges (10k), sessions (10k total, 32 per AID —
  oldest evicted), resolver cache (10k) and rate-limit buckets (10k) are all
  capped; expired entries are swept when a cap is hit.
- **Multisig**: a group AID resolves to several keys; a single member must not
  be able to mint a *group* session, so login is refused (`403`) for any AID
  whose latest establishment event has more than one key or a threshold other
  than `1`. Threshold-aware verification is a follow-up.
- **`X-User-Name` stays client-supplied.** It is display-only attribution in
  the proposals handler and is not covered by signed auth; authorization must
  never key off it.

## Enforcement flag

`MATOU_REQUIRE_SIGNED_AUTH` gates hard enforcement. **Default OFF** — the backend
keeps accepting a bare `X-User-AID` header so a first-iteration mismatch cannot
brick normal dev workflows. Sessions are still minted and verified with the flag
off (`api.VerifiedAID` is populated), only the stripping/401 behaviour is gated.
The Playwright `BackendManager` (`frontend/tests/e2e/utils/backend-manager.ts`)
sets it **ON** for every backend it spawns; specs that call the API directly
obtain a session with `loginAs(page)` from `tests/e2e/utils/signed-auth.ts`
(it reads the token the app minted out of the page's identity store) and send
it via `sessionHeaders(aid)`. The shared 9080 admin backend is started outside
the harness — set the flag there too for an enforced run. A green e2e run is
the live verification of the signify↔Go CESR/key-state path. Follow-up: once
e2e is green, flip the default ON in dev/test, then bundled/prod (file as its
own issue).

## Key-state resolution (NEEDS LIVE VERIFICATION)

The backend gains a **read-only** KERIA key-state path (the "no direct KERIA
connection" principle was relaxed read-only, per the 2026-08-10 decision).
`KERIAResolver` fetches the AID's KEL as a CESR stream and extracts the latest
establishment event **whose `i` equals the requested AID** (`ExtractKeyState`) —
OOBI responses routinely carry witness/agent KELs alongside the controller's,
and those must never be mistaken for the user's key state. The URL is
configurable:

- `MATOU_KERIA_KEYSTATE_URL` — a template containing `{aid}` (e.g.
  `http://localhost:4902/oobi/{aid}`). The AID is validated and path-escaped
  before interpolation.
- Default: derived from `KERIConfig.CESRURL` as `{cesrUrl}/oobi/{aid}`.

**Trust boundary.** The resolver trusts the KEL that endpoint serves
wholesale — it does not verify event signatures, digests or witness receipts.
Whoever controls the endpoint (or the path to it) controls which key the
backend accepts. That is acceptable only because it is the deployment's own
KERIA/witness reached over loopback (dev/test/Electron) or TLS; the resolver
therefore **refuses plain `http` to a non-loopback host** at startup
(`MATOU_KERIA_KEYSTATE_ALLOW_HTTP=1` re-opens it for trusted remote-dev
networks). Full KEL verification is a follow-up.

**Witness-less AIDs.** An AID with no agent end-role / witness OOBI may have
nothing served at the OOBI route; login then fails with `503` ("could not
resolve key state") and the app logs a pointed warning and continues
unauthenticated (fine while the flag is off). Serving/verifying such KELs by
another route is a follow-up.

The exact unauthenticated route that serves an AID's KEL is deployment-specific
(KERIA OOBI endpoint vs a witness); it cannot be verified from the CI sandbox and
is validated by the e2e run. Adjust the template if the OOBI route differs.

## Machine clients (matou-mcp, scripts)

Machine clients authenticate the **same way** — there is no API-key side channel:

1. Hold a signing key for a provisioned single-key AID (a signify-ts
   keystore/passcode, or any KERI keystore that can produce a non-indexed
   Ed25519 `Cigar` over arbitrary bytes).
2. `POST /api/v1/auth/challenge {aid}` → nonce (send the per-launch API token
   as the Bearer — it is a mutating request).
3. Sign `matou-auth:<aid>:<nonce>` with the AID's current key; CESR-qualify the
   signature (`0B` non-indexed Ed25519).
4. `POST /api/v1/auth/login {aid, challenge, signature}` → `{token, expiresAt}`.
5. Send `Authorization: Bearer <token>` on every request; re-run the flow when
   the token nears `expiresAt` or after a key rotation (a 401 signals re-login).

The AID's roles are then resolved exactly as for an app user (org-config admin,
CommunityProfile role, etc.). A machine client with no membership resolves to
`member`, the same as any other AID.
