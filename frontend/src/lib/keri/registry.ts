/**
 * Shared KERI registry utilities.
 * Provides a common getOrCreatePersonalRegistry() used by multiple composables.
 */
import { useKERIClient } from './client';
import { useIdentityStore } from 'stores/identity';

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
