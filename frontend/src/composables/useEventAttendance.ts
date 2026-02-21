/**
 * Composable for issuing event attendance credentials.
 * Admin/steward hosts issue these to applicants who attended a session.
 */
import { ref } from 'vue';
import { useKERIClient } from 'src/lib/keri/client';
import { useIdentityStore } from 'stores/identity';
import { useProfilesStore } from 'stores/profiles';
import { createOrUpdateProfile } from 'src/lib/api/client';
import { EVENT_ATTENDANCE_SCHEMA_SAID, MEMBERSHIP_SCHEMA_SAID } from './useAdminActions';

const SCHEMA_SERVER_URL = 'http://schema-server:7723';
const EVENT_ATTENDANCE_SCHEMA_OOBI = `${SCHEMA_SERVER_URL}/oobi/${EVENT_ATTENDANCE_SCHEMA_SAID}`;

export interface AttendanceRecord {
  hostAid: string;
  hostName: string;
  credentialSaid: string;
  eventType: string;
  eventName: string;
  sessionDate: string;
  issuedAt: string;
}

export function useEventAttendance() {
  const keriClient = useKERIClient();
  const identityStore = useIdentityStore();
  const profilesStore = useProfilesStore();

  const isMarking = ref(false);
  const error = ref<string | null>(null);

  /**
   * Get or create a personal registry for the current member.
   * Reuses the same registry naming pattern as endorsements.
   */
  async function getOrCreatePersonalRegistry(): Promise<string> {
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
      console.log('[EventAttendance] Found existing registry:', existing.regk);
      return existing.regk;
    }

    console.log('[EventAttendance] Creating personal registry...');
    const registryId = await keriClient.createRegistry(myAid.prefix, registryName);
    console.log('[EventAttendance] Created registry:', registryId);
    return registryId;
  }

  /**
   * Issue an event attendance credential to a pending applicant.
   */
  async function markAttended(
    applicantAid: string,
    applicantOOBI?: string,
    sessionDate?: string,
  ): Promise<boolean> {
    if (isMarking.value) return false;
    isMarking.value = true;
    error.value = null;

    try {
      const myAid = identityStore.currentAID;
      if (!myAid) throw new Error('No identity found');

      // 1. Get or create host's personal registry
      const registryId = await getOrCreatePersonalRegistry();

      // 2. Resolve event attendance schema OOBI
      await keriClient.resolveOOBI(EVENT_ATTENDANCE_SCHEMA_OOBI, EVENT_ATTENDANCE_SCHEMA_SAID, 15000);

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

      // 4. Verify host has a membership credential (must be admitted member)
      const client = keriClient.getSignifyClient();
      if (!client) throw new Error('Not connected to KERIA');
      const allCreds = await client.credentials().list();
      const membershipCred = allCreds.find(
        (c: { sad?: { s?: string } }) => c.sad?.s === MEMBERSHIP_SCHEMA_SAID
      );
      if (!membershipCred?.sad?.d) {
        throw new Error('Could not find your membership credential. You must be an admitted member to mark attendance.');
      }
      console.log('[EventAttendance] Found host membership credential:', membershipCred.sad.d);

      // 5. Issue event attendance credential
      // NOTE: Edge data (hostMembership chain) is omitted because KERIA's
      // per-agent verifier isolation means the personal AID agent's reger.saved
      // doesn't contain the membership credential (issued by the org AID agent).
      // The schema allows "e" to be optional. The membership check above still
      // ensures only admitted members can issue attendance credentials.
      const now = new Date().toISOString();
      const credentialData = {
        dt: now,
        eventType: 'community_onboarding',
        eventName: 'Whakawhanaungatanga Session',
        sessionDate: sessionDate || now,
      };

      const credResult = await keriClient.issueCredential(
        myAid.prefix,
        registryId,
        EVENT_ATTENDANCE_SCHEMA_SAID,
        applicantAid,
        credentialData,
      );

      // 6. Update SharedProfile with attendance record
      const attendance: AttendanceRecord = {
        hostAid: myAid.prefix,
        hostName: myAid.name || 'Unknown',
        credentialSaid: credResult.said,
        eventType: 'community_onboarding',
        eventName: 'Whakawhanaungatanga Session',
        sessionDate: sessionDate || now,
        issuedAt: now,
      };

      const profileId = `SharedProfile-${applicantAid}`;
      const currentProfile = profilesStore.communityProfiles.find(p => {
        const data = (p.data as Record<string, unknown>) || {};
        return data.aid === applicantAid || (p.id as string)?.includes(applicantAid);
      });
      const currentData = (currentProfile?.data as Record<string, unknown>) || {};

      await createOrUpdateProfile(
        'SharedProfile',
        {
          ...currentData,
          attendanceRecord: attendance,
        },
        { id: profileId },
      );

      // 7. Refresh profiles
      await profilesStore.loadCommunityProfiles();

      return true;
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      console.error('[EventAttendance] Mark attended failed:', err);
      error.value = errorMsg;
      return false;
    } finally {
      isMarking.value = false;
    }
  }

  /**
   * Check if the current user has already marked this applicant as attended.
   */
  function hasMarkedAttended(applicantAid: string): boolean {
    const myAid = identityStore.currentAID?.prefix;
    if (!myAid) return false;
    const profile = profilesStore.communityProfiles.find(p => {
      const data = (p.data as Record<string, unknown>) || {};
      return data.aid === applicantAid || (p.id as string)?.includes(applicantAid);
    });
    if (!profile) return false;
    const data = (profile.data as Record<string, unknown>) || {};
    const record = data.attendanceRecord as AttendanceRecord | undefined;
    return !!record && record.hostAid === myAid;
  }

  function clearError() {
    error.value = null;
  }

  return {
    isMarking,
    error,
    markAttended,
    hasMarkedAttended,
    clearError,
  };
}
