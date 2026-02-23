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
import { getOrCreatePersonalRegistry } from 'src/lib/keri/registry';

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

// Track attendance marks issued in this session so hasMarkedAttended() works
// even if the SharedProfile update failed (e.g. profile not yet synced via any-sync).
// Key format: `${hostAid}:${applicantAid}`
const locallyMarkedSet = new Set<string>();

export function useEventAttendance() {
  const keriClient = useKERIClient();
  const identityStore = useIdentityStore();
  const profilesStore = useProfilesStore();

  const isMarking = ref(false);
  const error = ref<string | null>(null);

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
        throw new Error('Could not find your membership credential. You must be an admitted member to mark attendance.');
      }
      console.log('[EventAttendance] Found host membership credential:', membershipCred.sad.d);

      // 5. Issue event attendance credential with edge linking to host's membership
      const now = new Date().toISOString();
      const credentialData = {
        dt: now,
        eventType: 'community_onboarding',
        eventName: 'Whakawhanaungatanga Session',
        sessionDate: sessionDate || now,
      };

      const edgeData = {
        d: '', // SAID placeholder — signify-ts computes this
        hostMembership: {
          n: membershipCred.sad.d,
          s: MEMBERSHIP_SCHEMA_SAID,
        },
      };

      const credResult = await keriClient.issueCredential(
        myAid.prefix,
        registryId,
        EVENT_ATTENDANCE_SCHEMA_SAID,
        applicantAid,
        credentialData,
        undefined,
        edgeData,
      );

      // Track locally so hasMarkedAttended() works immediately
      locallyMarkedSet.add(`${myAid.prefix}:${applicantAid}`);

      // 6. Update SharedProfile with attendance record (best-effort).
      // The KERI credential is the authoritative record — the SharedProfile
      // attendance is just UI metadata. If the profile update fails (e.g.
      // because the applicant's SharedProfile hasn't synced to this backend
      // via any-sync yet), we still return success since the credential was
      // issued and granted successfully.
      try {
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
      } catch (profileErr) {
        console.warn('[EventAttendance] SharedProfile update failed (non-fatal, credential was issued):', profileErr);
      }

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
    // Check local session tracking first (handles SharedProfile sync race)
    if (locallyMarkedSet.has(`${myAid}:${applicantAid}`)) return true;
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
