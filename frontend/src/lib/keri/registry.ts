/**
 * Shared KERI registry utilities.
 * Provides a common getOrCreatePersonalRegistry() used by multiple composables.
 */
import { useKERIClient } from './client';
import { useIdentityStore } from 'stores/identity';
import { getCommunityDescriptor } from 'src/lib/clientConfig';
import { BACKEND_KIND_IDSS } from 'src/lib/descriptor';

/**
 * Get or create a personal endorsement registry for the current member.
 * Queries KERIA directly — no need to store registry ID in profiles.
 * Used by useEndorsements, useEventAttendance, and usePreCreatedInvite.
 */
export async function getOrCreatePersonalRegistry(): Promise<string> {
  const keriClient = useKERIClient();
  const identityStore = useIdentityStore();

  const client = keriClient.getSignifyClient();
  if (!client) throw new Error('Not connected to KERIA');

  const myAid = identityStore.currentAID;
  if (!myAid) throw new Error('No identity found');

  const registryName = `${myAid.prefix.slice(0, 12)}-endorsements`;

  const registries = await client.registries().list(myAid.prefix);
  const existing = registries.find(
    (r: { name: string }) => r.name === registryName
  );
  if (existing) {
    return existing.regk;
  }

  const registryId = await keriClient.createRegistry(myAid.prefix, registryName);
  return registryId;
}

/**
 * Get or create a credential registry on the org group AID for the current
 * steward. KERIA does not auto-sync TEL/registry events between group-AID
 * members, so each steward must create their own registry on the group AID
 * (anchored by an `ixn` in the group KEL) to issue Membership credentials.
 *
 * For the admin (org creator), this returns the existing registry the org
 * was bootstrapped with. For upgraded stewards, it returns their existing
 * registry if any, else creates a fresh one named after their AID.
 *
 * All registries are anchored to the same group AID, so credentials issued
 * by any steward verify against the same issuer.
 */
export async function getOrCreateOrgRegistry(orgAidName: string): Promise<string> {
  const keriClient = useKERIClient();
  const identityStore = useIdentityStore();

  const client = keriClient.getSignifyClient();
  if (!client) throw new Error('Not connected to KERIA');

  const myAid = identityStore.currentAID;
  if (!myAid) throw new Error('No identity found');

  const registries = await client.registries().list(orgAidName);
  if (registries.length > 0) {
    return registries[0].regk;
  }

  const registryName = `matou-community-by-${myAid.prefix.slice(0, 12)}`;
  return keriClient.createRegistry(orgAidName, registryName);
}

/**
 * Resolve the registry that issues a membership credential for THIS backend.
 *
 * On an IDSS backend the ONE community registry issues every membership
 * (ADR 0235 decision 4): the descriptor names it as `community.registry`, and
 * per-steward registry creation is off. We must NOT fall back to
 * {@link getOrCreateOrgRegistry} on idss — that would mint a per-steward
 * registry the gateway never anchored, so the credential would fail to verify
 * against the community's published ledger. A descriptor that declares
 * `backend_kind: idss` but names no `community.registry` is a hard error, not a
 * silent fallback.
 *
 * On a legacy (non-IDSS) backend the pre-existing per-steward behaviour holds:
 * each steward uses (or creates) their own registry on the group AID.
 */
export async function resolveIssuingRegistry(orgAidName: string): Promise<string> {
  let backendKind: string | null = null;
  let communityRegistry = '';
  try {
    const descriptor = await getCommunityDescriptor();
    backendKind = descriptor.backend_kind || null;
    communityRegistry = descriptor.community?.registry ?? '';
  } catch {
    // Descriptor unavailable — fall through to legacy per-steward handling.
  }

  if (backendKind === BACKEND_KIND_IDSS) {
    if (!communityRegistry) {
      throw new Error(
        'IDSS backend descriptor names no community.registry — cannot issue ' +
          'membership credential (ADR 0235 decision 4).',
      );
    }
    return communityRegistry;
  }

  return getOrCreateOrgRegistry(orgAidName);
}
