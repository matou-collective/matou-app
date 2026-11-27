#!/usr/bin/env node
// Apple App Store Connect preflight (issue #813).
//
// When Apple publishes new terms, the account holder must accept them at
// developer.apple.com (and App Store Connect) before notarisation or TestFlight
// upload will work. Until then the mac notarisation and iOS TestFlight steps
// fail, but only at the *end* of a long build — minutes wasted, real cause
// buried in the log.
//
// This runs on ubuntu-latest (no macOS minutes) at the start of the build.
// It mints a short-lived App Store Connect API JWT (ES256) and makes one cheap
// authenticated call (GET /v1/apps?limit=1):
//   - 2xx                        -> agreements OK, build proceeds.
//   - 403 + an *_AGREEMENTS_*    -> agreements pending: clear message, exit 1.
//     error code                    (so the account holder is notified at once)
//   - 401                        -> bad/expired/mismatched key: distinct message.
//   - anything else / network    -> distinct message, not mistaken for the above.
//
// Never prints the key or the JWT. Reads the key only from the environment.

import crypto from 'node:crypto';

const keyId = process.env.APPLE_API_KEY_ID;
const issuer = process.env.APPLE_API_ISSUER;
const keyContent = process.env.APPLE_API_KEY_CONTENT;

// Secrets unset (e.g. a fork, or a repo without Apple signing): nothing to
// check. Pass so the build behaves exactly as it did before this preflight.
if (!keyId || !issuer || !keyContent) {
  console.log('::notice::Apple API secrets not set — skipping agreement preflight.');
  process.exit(0);
}

function b64url(input) {
  return Buffer.from(input)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function buildJwt() {
  let privateKey;
  try {
    privateKey = crypto.createPrivateKey(keyContent);
  } catch {
    // Do not echo the content — just say what was expected.
    console.error(
      '::error::Could not parse APPLE_API_KEY_CONTENT as a private key — expected the contents of the App Store Connect .p8 (PEM). Check the secret (docs/SECRETS_CHECKLIST.md).',
    );
    process.exit(1);
  }

  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'ES256', kid: keyId, typ: 'JWT' };
  const payload = {
    iss: issuer,
    iat: now,
    exp: now + 600, // App Store Connect requires <= 20 min; 10 is plenty.
    aud: 'appstoreconnect-v1',
  };
  const signingInput = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;
  // ieee-p1363 => raw r||s, the signature encoding JWS/ASC expects (the Node
  // default is ASN.1/DER, which App Store Connect rejects).
  const signature = crypto.sign('sha256', Buffer.from(signingInput), {
    key: privateKey,
    dsaEncoding: 'ieee-p1363',
  });
  return `${signingInput}.${b64url(signature)}`;
}

async function main() {
  const jwt = buildJwt();

  const url = 'https://api.appstoreconnect.apple.com/v1/apps?limit=1';
  let res;
  try {
    res = await fetch(url, {
      headers: { Authorization: `Bearer ${jwt}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(30000),
    });
  } catch (err) {
    // Network / DNS / timeout — transient, and NOT the agreements case.
    console.error(
      `::error::Could not reach App Store Connect (${err.message || err}). This is a network/transient error, not an agreements problem — re-run the workflow.`,
    );
    process.exit(1);
  }

  if (res.ok) {
    console.log(
      `::notice::Apple App Store Connect preflight OK (HTTP ${res.status}) — agreements accepted, build proceeds.`,
    );
    process.exit(0);
  }

  // Parse Apple's structured error body for its error codes. The codes/titles
  // are safe to print (they carry no credentials); the JWT and key never are.
  let body = {};
  const raw = await res.text().catch(() => '');
  try {
    body = JSON.parse(raw);
  } catch {
    /* non-JSON body — leave body empty, fall through to the status-only path */
  }
  const errors = Array.isArray(body.errors) ? body.errors : [];
  const codes = errors.map((e) => e.code || '').filter(Boolean);
  const agreementsPending =
    codes.some((c) => /AGREEMENT/i.test(c)) ||
    errors.some((e) => /agreement|terms|contract/i.test(`${e.title || ''} ${e.detail || ''}`));

  if (agreementsPending) {
    console.error(
      '::error::Apple has new terms to accept: sign in at developer.apple.com (account holder) and App Store Connect, accept, then re-run.',
    );
    console.error(
      `(App Store Connect returned HTTP ${res.status}; error codes: ${codes.join(', ') || 'n/a'})`,
    );
    process.exit(1);
  }

  if (res.status === 401) {
    console.error(
      '::error::App Store Connect rejected the API key (HTTP 401) — it is wrong, expired, revoked, or the key id / issuer do not match. This is NOT an agreements problem; check the APPLE_API_* secrets (docs/SECRETS_CHECKLIST.md).',
    );
    process.exit(1);
  }

  console.error(
    `::error::App Store Connect preflight failed with HTTP ${res.status}${
      codes.length ? ` (error codes: ${codes.join(', ')})` : ''
    }. This is not the known "agreements pending" case — check the response and the APPLE_API_* secrets.`,
  );
  process.exit(1);
}

main().catch((err) => {
  console.error(`::error::Apple preflight crashed unexpectedly: ${err && err.message ? err.message : err}`);
  process.exit(1);
});
