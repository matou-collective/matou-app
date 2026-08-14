# KERI-Signed Request Authentication

Enforcement 3/5 of the RBAC plan (issue #18). Makes the `X-User-AID` identity
trustworthy by requiring a cryptographic proof of control over the AID's current
signing key before the backend resolves any roles.

## Model: signed-challenge login → session token

Chosen by maintainer decision (2026-08-10) over per-request signing:

1. **Challenge** — the client POSTs its AID to `/api/v1/auth/challenge`; the
   backend returns a random, single-use, time-bounded nonce
   (`ChallengeStore`, default TTL 2 min).
2. **Sign** — the client signs the nonce bytes with the AID's signing key. In
   the app this is `KERIClient.signChallenge()` (signify-ts
   `keeper.sign(b(nonce), false)` → a non-indexed Ed25519 `Cigar`, CESR code
   `0B`).
3. **Verify + mint** — the client POSTs `{aid, challenge, signature}` to
   `/api/v1/auth/login`. The backend:
   - resolves the AID's **current** signing keys read-only from KERIA
     (`KeyStateResolver`; never trusts a client-supplied key),
   - verifies the signature against those keys (`internal/auth` CESR decode +
     `ed25519.Verify`),
   - mints a short-lived session token (`SessionStore`, default TTL 30 min),
     recording a hash of the keys it was minted against.
4. **Per request** — the client sends `Authorization: Bearer <token>`.
   `SignedAuthMiddleware` validates the token and rewrites `X-User-AID` to the
   verified AID before RBAC runs. A request with no token has any client-supplied
   `X-User-AID` **stripped** (so it reaches RBAC anonymously); an invalid/expired
   token is rejected with 401.

**Revoke-on-rotation:** when an AID's key state rotates, all its sessions are
invalidated. The backend observes rotation via the KEL sync path
(`/api/v1/sync/kel` → `SyncHandler.SetRotationHook` →
`Verifier.OnRotation`): if the synced KEL's current keys differ from a session's
recorded keys hash, that AID's sessions are revoked and the resolver cache is
dropped. Short session TTL bounds the window regardless.

## Enforcement flag

`MATOU_REQUIRE_SIGNED_AUTH` gates hard enforcement. **Default OFF** — the backend
keeps accepting a bare `X-User-AID` header so a first-iteration mismatch cannot
brick normal dev workflows. The Playwright e2e config
(`frontend/tests/e2e/utils/backend-manager.ts`) sets it **ON** against real
KERIA infrastructure; a green e2e run is the live verification of the
signify↔Go CESR/key-state path. Follow-up: once e2e is green, flip the default
ON in dev/test, then bundled/prod (file as its own issue).

## Key-state resolution (NEEDS LIVE VERIFICATION)

The backend gains a **read-only** KERIA key-state path (the "no direct KERIA
connection" principle was relaxed read-only, per the 2026-08-10 decision).
`KERIAResolver` fetches the AID's KEL as a CESR stream and extracts the latest
establishment event's keys (`ExtractCurrentKeys`). The URL is configurable:

- `MATOU_KERIA_KEYSTATE_URL` — a template containing `{aid}` (e.g.
  `http://localhost:4902/oobi/{aid}`).
- Default: derived from `KERIConfig.CESRURL` as `{cesrUrl}/oobi/{aid}`.

The exact unauthenticated route that serves an AID's KEL is deployment-specific
(KERIA OOBI endpoint vs a witness); it cannot be verified from the CI sandbox and
is validated by the e2e run. Adjust the template if the OOBI route differs.

## Machine clients (matou-mcp, scripts)

Machine clients authenticate the **same way** — there is no API-key side channel:

1. Hold a signing key for a provisioned AID (a signify-ts keystore/passcode, or
   any KERI keystore that can produce a non-indexed Ed25519 `Cigar` over
   arbitrary bytes).
2. `POST /api/v1/auth/challenge {aid}` → nonce.
3. Sign the nonce bytes with the AID's current key; CESR-qualify the signature
   (`0B` non-indexed Ed25519).
4. `POST /api/v1/auth/login {aid, challenge, signature}` → `{token, expiresAt}`.
5. Send `Authorization: Bearer <token>` on every request; re-run the flow when
   the token nears `expiresAt` or after a key rotation (a 401 signals re-login).

The AID's roles are then resolved exactly as for an app user (org-config admin,
CommunityProfile role, etc.). A machine client with no membership resolves to
`member`, the same as any other AID.
