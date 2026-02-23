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
