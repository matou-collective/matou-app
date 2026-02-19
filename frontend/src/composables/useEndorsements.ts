/**
 * Composable for endorsing pending member applications.
 * Approved members can issue endorsement credentials to pending applicants.
 */
import { ref } from 'vue';
import { useKERIClient } from 'src/lib/keri/client';
import { useIdentityStore } from 'stores/identity';
import { useProfilesStore } from 'stores/profiles';
import { createOrUpdateProfile } from 'src/lib/api/client';
import { ENDORSEMENT_SCHEMA_SAID } from './useAdminActions';

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
   * Get the current member's personal registry ID from their CommunityProfile.
   */
  function getPersonalRegistryId(): string | null {
    const myAid = identityStore.currentAID?.prefix;
    if (!myAid) return null;

    const myProfile = profilesStore.communityReadOnlyProfiles.find(p => {
      const data = (p.data as Record<string, unknown>) || {};
      return data.userAID === myAid || (p.id as string)?.includes(myAid);
    });

    if (!myProfile) return null;
    const data = (myProfile.data as Record<string, unknown>) || {};
    return (data.personalRegistryId as string) || null;
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
      const client = keriClient.getSignifyClient();
      if (!client) throw new Error('Not connected to KERIA');

      const myAid = identityStore.currentAID;
      if (!myAid) throw new Error('No identity found');

      // 1. Get endorser's personal registry
      const registryId = getPersonalRegistryId();
      if (!registryId) {
        throw new Error(
          'No personal registry found. You may need to be re-admitted to get a registry.',
        );
      }

      // 2. Resolve applicant OOBI
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

      // 3. Issue endorsement credential
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

      // 4. Update SharedProfile with endorsement record
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
          endorsements: [...existingEndorsements, endorsement],
        },
        { id: profileId },
      );

      // 5. Refresh profiles
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
