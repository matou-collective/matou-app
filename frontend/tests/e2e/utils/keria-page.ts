/**
 * Read org-registry credential state from the KERIA agent a logged-in page is
 * connected to.
 *
 * Every test user shares one KERIA, but each has its OWN agent, and what the
 * steward-peer-registry work asserts is per-agent: a credential one steward
 * issued (or revoked) from the org group must show up in every OTHER
 * steward's agent once its OrgActInbox has replayed the peer's
 * `/multisig/iss` / `/multisig/rev`. So the read goes through the page's own
 * signify client — the app's KERIClient singleton, reached via Vite's dynamic
 * ESM import (the same module instance the app uses; see
 * e2e-credential-chain.spec.ts) — not through a second connection from Node.
 */
import type { Page } from '@playwright/test';

/**
 * TEL state of `said` in registry `registryId` as this page's agent sees it:
 * 'iss' / 'rev' (or 'bis' / 'brv' for backed registries), or null when the
 * agent holds no TEL for it yet (KERIA 404s) or the client is not connected.
 */
export async function credentialTelState(
  page: Page,
  registryId: string,
  said: string,
): Promise<string | null> {
  return page.evaluate(async ({ ri, d }) => {
    try {
      const keriModule = await import('/src/lib/keri/client.ts');
      const client = keriModule.useKERIClient().getSignifyClient();
      if (!client) return null;
      const st = (await client.credentials().state(ri, d)) as { et?: string };
      return st.et ?? null;
    } catch {
      return null;
    }
  }, { ri: registryId, d: said });
}

/**
 * SAID of the credential the org group issued to `recipientAid` from the org
 * registry, as held by this page's agent — or null if the agent holds none.
 * Filtering on issuer + registry (not schema) keeps this independent of which
 * Membership schema body the community uses, and excludes the endorsement /
 * attendance credentials stewards issue from their personal registries.
 */
export async function orgIssuedCredentialSaid(
  page: Page,
  orgAid: string,
  registryId: string,
  recipientAid: string,
): Promise<string | null> {
  return page.evaluate(async ({ i, ri, a }) => {
    try {
      const keriModule = await import('/src/lib/keri/client.ts');
      const client = keriModule.useKERIClient().getSignifyClient();
      if (!client) return null;
      const creds = (await client.credentials().list({ limit: 200 })) as Array<{
        sad: { d: string; i?: string; ri?: string; a?: { i?: string } };
      }>;
      const hit = creds.find(c => c.sad.i === i && c.sad.ri === ri && c.sad.a?.i === a);
      return hit?.sad.d ?? null;
    } catch {
      return null;
    }
  }, { i: orgAid, ri: registryId, a: recipientAid });
}
