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
 * The ONE registry every steward issues memberships into (spec §2):
 * `community.registry` on IDSS, the org config's `registry.id` on legacy.
 * Per-steward registries are gone — each steward's agent ADOPTS this one
 * (KERIClient.ensureOrgRegistryAdopted).
 */
export async function resolveOrgRegistryId(): Promise<string> {
  try {
    const descriptor = await getCommunityDescriptor();
    if (descriptor.backend_kind === BACKEND_KIND_IDSS) {
      const reg = descriptor.community?.registry ?? '';
      if (!reg) throw new Error('IDSS backend descriptor names no community.registry (ADR 0235 decision 4).');
      return reg;
    }
  } catch (err) {
    if (err instanceof Error && err.message.includes('community.registry')) throw err;
  }
  const { fetchOrgConfig } = await import('src/api/config');
  const r = await fetchOrgConfig();
  const config = r.status === 'configured' ? r.config : r.status === 'server_unreachable' ? r.cached : null;
  const id = config?.registry?.id;
  if (!id) throw new Error('Org config names no registry — cannot issue membership credentials.');
  return id;
}

/** Kept for call sites: the org registry, regardless of which steward asks. */
export async function resolveIssuingRegistry(_orgAidName: string): Promise<string> {
  return resolveOrgRegistryId();
}
