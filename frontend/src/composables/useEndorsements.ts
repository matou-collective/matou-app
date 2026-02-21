/**
 * Composable for endorsing pending member applications.
 * Approved members can issue endorsement credentials to pending applicants.
 */
import { ref } from 'vue';
import { useKERIClient } from 'src/lib/keri/client';
import { useIdentityStore } from 'stores/identity';
import { useProfilesStore } from 'stores/profiles';
import { createOrUpdateProfile } from 'src/lib/api/client';
import { ENDORSEMENT_SCHEMA_SAID, MEMBERSHIP_SCHEMA_SAID } from './useAdminActions';

// Schema server URL as seen by KERIA inside Docker (fixed internal hostname)
const SCHEMA_SERVER_URL = 'http://schema-server:7723';
const ENDORSEMENT_SCHEMA_OOBI = `${SCHEMA_SERVER_URL}/oobi/${ENDORSEMENT_SCHEMA_SAID}`;

export interface EndorsementRecord {
  endorserAid: string;
  endorserName: string;
  credentialSaid: string;
  endorsedAt: string;
  message?: string;
}

export function useEndorsements() {
  const keriClient = useKERIClient();
  const identityStore = useIdentityStore();
  const profilesStore = useProfilesStore();

  const isEndorsing = ref(false);
  const error = ref<string | null>(null);

  /**
   * Get or create a personal endorsement registry for the current member.
   * Queries KERIA directly — no need to store registry ID in profiles.
   */
  async function getOrCreatePersonalRegistry(): Promise<string> {
    const client = keriClient.getSignifyClient();
    if (!client) throw new Error('Not connected to KERIA');

    const myAid = identityStore.currentAID;
    if (!myAid) throw new Error('No identity found');

    const registryName = `${myAid.prefix.slice(0, 12)}-endorsements`;

    // Check if registry already exists (use prefix for API calls)
    const registries = await client.registries().list(myAid.prefix);
    const existing = registries.find(
      (r: { name: string }) => r.name === registryName
    );
    if (existing) {
      console.log('[Endorsements] Found existing registry:', existing.regk);
      return existing.regk;
    }

    // Create a new personal registry
    console.log('[Endorsements] Creating personal endorsement registry...');
    const registryId = await keriClient.createRegistry(myAid.prefix, registryName);
    console.log('[Endorsements] Created registry:', registryId);
    return registryId;
  }

  /**
   * Endorse a pending applicant by issuing an endorsement credential.
   */
  async function endorseApplicant(
    applicantAid: string,
    applicantOOBI?: string,
    message?: string,
  ): Promise<boolean> {
    if (isEndorsing.value) return false;
    isEndorsing.value = true;
    error.value = null;

    try {
      const myAid = identityStore.currentAID;
      if (!myAid) throw new Error('No identity found');

      // 1. Get or create endorser's personal registry
      const registryId = await getOrCreatePersonalRegistry();

      // 2. Resolve endorsement schema OOBI (KERIA needs it before issuing)
      await keriClient.resolveOOBI(ENDORSEMENT_SCHEMA_OOBI, ENDORSEMENT_SCHEMA_SAID, 15000);

      // 3. Resolve applicant OOBI
      let oobi = applicantOOBI;
      if (!oobi) {
        const cesrUrl = keriClient.getCesrUrl();
        if (cesrUrl) {
          oobi = `${cesrUrl}/oobi/${applicantAid}`;
        } else {
          throw new Error('Cannot resolve applicant identity: no OOBI available');
        }
      }
      const resolved = await keriClient.resolveOOBI(oobi, undefined, 30000);
      if (!resolved) throw new Error('Could not resolve applicant identity');

      // 4. Verify endorser has a membership credential (must be admitted member)
      const client = keriClient.getSignifyClient();
      if (!client) throw new Error('Not connected to KERIA');
      const allCreds = await client.credentials().list();
      const membershipCred = allCreds.find(
        (c: { sad?: { s?: string } }) => c.sad?.s === MEMBERSHIP_SCHEMA_SAID
      );
      if (!membershipCred?.sad?.d) {
        throw new Error('Could not find your membership credential. You must be an admitted member to endorse.');
      }
      console.log('[Endorsements] Found endorser membership credential:', membershipCred.sad.d);

      // 5. Issue endorsement credential
      // NOTE: Edge data (endorserMembership chain) is omitted because KERIA's
      // per-agent verifier isolation means the personal AID agent's reger.saved
      // doesn't contain the membership credential (issued by the org AID agent).
      // The schema allows "e" to be optional. The membership check above still
      // ensures only admitted members can endorse.
      const credentialData = {
        dt: new Date().toISOString(),
        endorsementType: 'membership_endorsement',
        category: 'membership',
        claim: message || "I endorse this person's membership application",
        confidence: 'high',
      };

      const credResult = await keriClient.issueCredential(
        myAid.prefix,
        registryId,
        ENDORSEMENT_SCHEMA_SAID,
        applicantAid,
        credentialData,
      );

      // 6. Update SharedProfile with endorsement record
      const endorsement: EndorsementRecord = {
        endorserAid: myAid.prefix,
        endorserName: myAid.name || 'Unknown',
        credentialSaid: credResult.said,
        endorsedAt: new Date().toISOString(),
        message: message || undefined,
      };

      const profileId = `SharedProfile-${applicantAid}`;
      const currentProfile = profilesStore.communityProfiles.find(p => {
        const data = (p.data as Record<string, unknown>) || {};
        return data.aid === applicantAid || (p.id as string)?.includes(applicantAid);
      });
      const currentData = (currentProfile?.data as Record<string, unknown>) || {};
      const existingEndorsements = (currentData.endorsements as EndorsementRecord[]) || [];

      await createOrUpdateProfile(
        'SharedProfile',
        {
          ...currentData,
          endorsements: [...existingEndorsements, endorsement],
        },
        { id: profileId },
      );

      // 7. Refresh profiles
      await profilesStore.loadCommunityProfiles();

      return true;
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      console.error('[Endorsements] Endorsement failed:', err);
      error.value = errorMsg;
      return false;
    } finally {
      isEndorsing.value = false;
    }
  }

  function hasEndorsed(applicantAid: string): boolean {
    const myAid = identityStore.currentAID?.prefix;
    if (!myAid) return false;
    const profile = profilesStore.communityProfiles.find(p => {
      const data = (p.data as Record<string, unknown>) || {};
      return data.aid === applicantAid || (p.id as string)?.includes(applicantAid);
    });
    if (!profile) return false;
    const data = (profile.data as Record<string, unknown>) || {};
    const endorsements = (data.endorsements as EndorsementRecord[]) || [];
    return endorsements.some(e => e.endorserAid === myAid);
  }

  function getEndorsements(applicantAid: string): EndorsementRecord[] {
    const profile = profilesStore.communityProfiles.find(p => {
      const data = (p.data as Record<string, unknown>) || {};
      return data.aid === applicantAid || (p.id as string)?.includes(applicantAid);
    });
    if (!profile) return [];
    const data = (profile.data as Record<string, unknown>) || {};
    return (data.endorsements as EndorsementRecord[]) || [];
  }

  function clearError() {
    error.value = null;
  }

  return {
    isEndorsing,
    error,
    endorseApplicant,
    hasEndorsed,
    getEndorsements,
    clearError,
  };
}
