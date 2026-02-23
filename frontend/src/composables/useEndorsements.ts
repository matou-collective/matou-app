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

// Track endorsements issued in this session so hasEndorsed() works even if
// the SharedProfile update failed (e.g. profile not yet synced via any-sync).
// Key format: `${endorserAid}:${applicantAid}`
const locallyEndorsedSet = new Set<string>();
// Reactive trigger so Vue computeds that call hasEndorsed() re-evaluate
// when loadIssuedEndorsements() discovers new credentials.
const endorsedVersion = ref(0);

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
      // IMPORTANT: Filter by issuee (sad.a.i) matching the current user's AID.
      // KERIA's credential store contains ALL credentials the agent knows about,
      // including credentials issued TO other users. Without filtering, we could
      // pick up another user's membership credential and create an invalid edge.
      const client = keriClient.getSignifyClient();
      if (!client) throw new Error('Not connected to KERIA');
      const allCreds = await client.credentials().list();
      const membershipCred = allCreds.find(
        (c: { sad?: { s?: string; a?: { i?: string } } }) =>
          c.sad?.s === MEMBERSHIP_SCHEMA_SAID && c.sad?.a?.i === myAid.prefix
      );
      if (!membershipCred?.sad?.d) {
        throw new Error('Could not find your membership credential. You must be an admitted member to endorse.');
      }
      console.log('[Endorsements] Found endorser membership credential:', membershipCred.sad.d);

      // 5. Issue endorsement credential with edge linking to endorser's membership
      const credentialData = {
        dt: new Date().toISOString(),
        endorsementType: 'membership_endorsement',
        category: 'membership',
        claim: message || "I endorse this person's membership application",
        confidence: 'high',
      };

      const edgeData = {
        d: '', // SAID placeholder — signify-ts computes this
        endorserMembership: {
          n: membershipCred.sad.d,
          s: MEMBERSHIP_SCHEMA_SAID,
        },
      };

      const credResult = await keriClient.issueCredential(
        myAid.prefix,
        registryId,
        ENDORSEMENT_SCHEMA_SAID,
        applicantAid,
        credentialData,
        undefined,
        edgeData,
      );

      // Track locally so hasEndorsed() works immediately
      locallyEndorsedSet.add(`${myAid.prefix}:${applicantAid}`);
      endorsedVersion.value++; // Trigger Vue computed re-evaluation

      // 6. Update SharedProfile with endorsement record (best-effort).
      // The KERI credential is the authoritative record — the SharedProfile
      // endorsement is just UI metadata. If the profile update fails (e.g.
      // because the applicant's SharedProfile hasn't synced to this backend
      // via any-sync yet), we still return success since the credential was
      // issued and granted successfully.
      try {
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
      } catch (profileErr) {
        console.warn('[Endorsements] SharedProfile update failed (non-fatal, credential was issued):', profileErr);
      }

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
    // Read reactive trigger so Vue computeds re-evaluate when set changes
    void endorsedVersion.value;
    // Check local session tracking first (handles SharedProfile sync race)
    if (locallyEndorsedSet.has(`${myAid}:${applicantAid}`)) return true;
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

  /**
   * Load endorsement credentials issued by the current user from KERIA.
   * Populates locallyEndorsedSet so hasEndorsed() works for credentials
   * issued outside this composable (e.g. via the pre-created invite flow).
   */
  async function loadIssuedEndorsements(): Promise<void> {
    try {
      const client = keriClient.getSignifyClient();
      if (!client) {
        console.log('[Endorsements] loadIssuedEndorsements: no signify client');
        return;
      }
      const myAid = identityStore.currentAID?.prefix;
      if (!myAid) {
        console.log('[Endorsements] loadIssuedEndorsements: no current AID');
        return;
      }

      const allCreds = await client.credentials().list();
      console.log(`[Endorsements] loadIssuedEndorsements: ${allCreds.length} credentials, myAid=${myAid}`);
      let found = 0;
      for (const cred of allCreds) {
        const sad = (cred as any).sad || cred;
        const schema = sad?.s || '';
        const issuer = sad?.i || '';
        const issuee = sad?.a?.i || '';
        if (schema === ENDORSEMENT_SCHEMA_SAID && issuer === myAid && issuee) {
          const key = `${myAid}:${issuee}`;
          if (!locallyEndorsedSet.has(key)) {
            locallyEndorsedSet.add(key);
            found++;
            console.log(`[Endorsements] Found issued endorsement: ${myAid} → ${issuee}`);
          }
        }
      }
      if (found > 0) {
        endorsedVersion.value++;
      }
    } catch (err) {
      console.warn('[Endorsements] Failed to load issued endorsements from KERIA:', err);
    }
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
    loadIssuedEndorsements,
    clearError,
  };
}
