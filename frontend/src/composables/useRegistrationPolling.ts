/**
 * Composable for polling registration requests (admin side)
 * Polls for pending registration notifications and parses applicant data
 *
 * Supports two notification types:
 * 1. Pending (escrowed) - from KERIA patch, sender OOBI not yet resolved
 *    Route: /exn/matou/registration/apply/pending
 *    Data is embedded directly in notification.a.a
 *
 * 2. Verified - normal flow after OOBI resolution
 *    Route: /exn/ipex/apply or /exn/matou/registration/apply
 *    Data must be fetched via getExchange()
 */
import { ref, watch, onUnmounted } from 'vue';
import { useKERIClient } from 'src/lib/keri/client';
import { useKERINotificationService } from './useKERINotificationService';
import { createOrUpdateProfile, getProfiles, uploadFile } from 'src/lib/api/client';
import { useProfilesStore } from 'stores/profiles';
import {
  buildOobiCandidates,
  shouldAttemptResolve,
  isApplicantUnreachable,
  parseFailedRegistrationNotification,
  FAILED_REGISTRATION_ROUTES,
  type ResolveAttemptState,
  type ExpiredRegistration,
} from 'src/lib/registrationResolve';
import type { CustomAnswer } from 'src/kit/profile';
import { isOpen } from 'src/kit/approval';
import { KIT } from 'src/generated/kit';
import { useAdminActions } from './useAdminActions';

export interface PendingRegistration {
  notificationId: string;
  exnSaid: string;
  applicantAid: string;
  applicantOOBI?: string;
  profile: {
    name: string;
    email?: string;
    bio: string;
    location?: string;
    joinReason?: string;
    indigenousCommunity?: string;
    facebookUrl?: string;
    linkedinUrl?: string;
    twitterUrl?: string;
    instagramUrl?: string;
    githubUrl?: string;
    gitlabUrl?: string;
    interests: string[];
    customInterests?: string;
    /** Answers to the kit's custom questions, carried by label. */
    customAnswers?: CustomAnswer[];
    avatarFileRef?: string;
    /** Base64-encoded avatar image data */
    avatarData?: string;
    /** MIME type of avatar image */
    avatarMimeType?: string;
    submittedAt: string;
  };
  /** True if from escrowed message (OOBI not resolved), false if verified */
  isPending: boolean;
  /**
   * True when repeated automatic OOBI resolution has failed for days —
   * the applicant's key state can't be fetched, so approve/decline/message
   * will not be deliverable until they come back online or re-register.
   */
  unreachable?: boolean;
}

export interface ApplicantMessage {
  id: string;
  applicantAid: string;
  content: string;
  sentAt: string;
}

// Routes to poll for registration notifications
// IPEX apply is the primary registration mechanism (has native KERIA notification support)
// Custom EXN routes are used for admin responses (decline, message)
const REGISTRATION_ROUTES = {
  // IPEX apply - primary registration route (native KERIA support)
  IPEX_APPLY: '/exn/ipex/apply',
  // Pending IPEX apply notifications from KERIA patch (escrowed, unverified)
  IPEX_APPLY_PENDING: '/exn/ipex/apply/pending',
  // Pending notifications from KERIA patch for custom EXN (escrowed, unverified)
  PENDING: '/exn/matou/registration/apply/pending',
  // Verified custom EXN notifications (fallback)
  VERIFIED: '/exn/matou/registration/apply',
  // Message replies from applicants
  MESSAGE_REPLY: '/exn/matou/registration/message_reply',
  // Dead-lettered (expired) registrations from KERIA patch — the escrowed exn
  // was removed after the dead-letter bound; the applicant must re-apply.
  // Routes: FAILED_REGISTRATION_ROUTES (custom EXN + IPEX apply forms).
};

export interface RegistrationPollingOptions {
  maxConsecutiveErrors?: number;  // Default: 5
}

export function useRegistrationPolling(options: RegistrationPollingOptions = {}) {
  const { maxConsecutiveErrors = 5 } = options;

  const keriClient = useKERIClient();
  const notificationService = useKERINotificationService();
  const profilesStore = useProfilesStore();
  const adminActions = useAdminActions();

  // State
  const pendingRegistrations = ref<PendingRegistration[]>([]);
  const expiredRegistrations = ref<ExpiredRegistration[]>([]);
  const applicantMessages = ref<ApplicantMessage[]>([]);
  const isPolling = ref(false);
  const error = ref<string | null>(null);
  const lastPollTime = ref<Date | null>(null);
  const consecutiveErrors = ref(0);

  // Track processed applicants to prevent re-adding after removal
  // This is needed because multiple notifications can exist for the same user
  const processedApplicantAids = new Set<string>();

  // Track applicants for whom we've already created a pending SharedProfile
  const createdPendingProfiles = new Set<string>();

  // Registrations auto-approved under an `open` kit — one approval per exnSaid.
  const autoApprovedExnSaids = new Set<string>();

  // Per-applicant OOBI resolution state (backoff bookkeeping for pending rows)
  const resolveStates = new Map<string, ResolveAttemptState>();
  let isResolvingApplicants = false;

  // Internal state
  let stopWatcher: (() => void) | null = null;

  /**
   * Resolve the key state (OOBI) of pending applicants so KERIA's escrow
   * processor can verify their registration exn and emit the real
   * notification. This is the de-escrow step that closes the loop the
   * KERIA exchanger patch assumes exists (same pattern as
   * useMultisigJoin.resolvePendingMultisigSenders). Without it, a pending
   * registration stays escrowed forever (Andrew Weaver incident: 4 months).
   *
   * Tries the candidate chain per applicant (bare OOBI first — stable across
   * agent re-boots — then the recorded senderOOBI) with exponential backoff
   * capped at hourly. Never gives up silently: long-failing applicants get
   * flagged `unreachable` for the UI while retries continue.
   */
  async function resolvePendingApplicants(registrations: PendingRegistration[]): Promise<void> {
    if (isResolvingApplicants) return;
    isResolvingApplicants = true;
    try {
      const cesrUrl = keriClient.getCesrUrl();
      for (const reg of registrations) {
        if (!reg.isPending || !reg.applicantAid) continue;

        const now = Date.now();
        let state = resolveStates.get(reg.applicantAid);
        if (!state) {
          const submitted = Date.parse(reg.profile.submittedAt);
          state = {
            attempts: 0,
            lastAttemptAt: 0,
            firstSeenAt: Number.isFinite(submitted) ? submitted : now,
            resolved: false,
          };
          resolveStates.set(reg.applicantAid, state);
        }
        if (!shouldAttemptResolve(state, now)) continue;

        state.attempts += 1;
        state.lastAttemptAt = now;

        const candidates = buildOobiCandidates({
          applicantAid: reg.applicantAid,
          recordedOobi: reg.applicantOOBI,
          cesrUrl,
        });
        const failures: string[] = [];
        for (const oobi of candidates) {
          const result = await keriClient.resolveOOBIWithReason(oobi, undefined, 30000);
          if (result.ok) {
            state.resolved = true;
            console.log(`[RegistrationPolling] Resolved pending applicant ${reg.applicantAid.slice(0, 12)}... via ${oobi} — escrow will verify shortly`);
            break;
          }
          failures.push(`${oobi}: ${result.reason || 'unknown'}`);
        }
        if (!state.resolved) {
          console.warn(`[RegistrationPolling] Applicant ${reg.applicantAid.slice(0, 12)}... unresolvable (attempt ${state.attempts}): ${failures.join('; ')}`);
        }
      }
    } finally {
      isResolvingApplicants = false;
    }
  }

  /**
   * Poll for registration notifications
   */
  async function pollForRegistrations(): Promise<void> {
    const client = keriClient.getSignifyClient();
    if (!client) {
      console.warn('[RegistrationPolling] SignifyClient not available');
      return;
    }

    try {
      const allNotes = notificationService.notifications.value;
      const registrations: PendingRegistration[] = [];

      // === 1. Check for PENDING notifications (from KERIA patch) ===
      const pendingNotifications = allNotes.filter(
        n => n.a?.r === REGISTRATION_ROUTES.PENDING && !n.r
      );

      for (const notification of pendingNotifications) {
        try {
          // Pending notifications from patch have data directly in a.a
          const attrs = notification.a;
          const embeddedData = attrs?.a || {};

          const applicantAid = attrs?.i || '';
          const name = (embeddedData.name as string) || 'Unknown';

          registrations.push({
            notificationId: notification.i,
            exnSaid: attrs?.d || notification.i,
            applicantAid,
            applicantOOBI: (embeddedData.senderOOBI as string) || undefined,
            profile: {
              name,
              email: (embeddedData.email as string) || undefined,
              bio: (embeddedData.bio as string) || '',
              location: (embeddedData.location as string) || undefined,
              joinReason: (embeddedData.joinReason as string) || undefined,
              indigenousCommunity: (embeddedData.indigenousCommunity as string) || undefined,
              facebookUrl: (embeddedData.facebookUrl as string) || undefined,
              linkedinUrl: (embeddedData.linkedinUrl as string) || undefined,
              twitterUrl: (embeddedData.twitterUrl as string) || undefined,
              instagramUrl: (embeddedData.instagramUrl as string) || undefined,
              githubUrl: (embeddedData.githubUrl as string) || undefined,
              gitlabUrl: (embeddedData.gitlabUrl as string) || undefined,
              interests: (embeddedData.interests as string[]) || [],
              customInterests: (embeddedData.customInterests as string) || undefined,
              customAnswers: (embeddedData.customAnswers as CustomAnswer[]) || [],
              avatarFileRef: (embeddedData.avatarFileRef as string) || undefined,
              avatarData: (embeddedData.avatarData as string) || undefined,
              avatarMimeType: (embeddedData.avatarMimeType as string) || undefined,
              submittedAt: (attrs?.dt as string) || new Date().toISOString(),
            },
            isPending: true,
          });
        } catch (parseErr) {
          console.warn('[RegistrationPolling] Failed to parse pending notification:', notification.i, parseErr);
        }
      }

      // === 2. Check for IPEX APPLY PENDING notifications (from KERIA patch) ===
      const ipexApplyPendingNotifications = allNotes.filter(
        n => n.a?.r === REGISTRATION_ROUTES.IPEX_APPLY_PENDING && !n.r
      );

      for (const notification of ipexApplyPendingNotifications) {
        try {
          // Pending notifications from patch have data directly in a.a
          const attrs = notification.a;
          const embeddedData = attrs?.a || {};

          const applicantAid = attrs?.i || '';
          const name = (embeddedData.name as string) || 'Unknown';

          registrations.push({
            notificationId: notification.i,
            exnSaid: attrs?.d || notification.i,
            applicantAid,
            applicantOOBI: (embeddedData.senderOOBI as string) || undefined,
            profile: {
              name,
              email: (embeddedData.email as string) || undefined,
              bio: (embeddedData.bio as string) || '',
              location: (embeddedData.location as string) || undefined,
              joinReason: (embeddedData.joinReason as string) || undefined,
              indigenousCommunity: (embeddedData.indigenousCommunity as string) || undefined,
              facebookUrl: (embeddedData.facebookUrl as string) || undefined,
              linkedinUrl: (embeddedData.linkedinUrl as string) || undefined,
              twitterUrl: (embeddedData.twitterUrl as string) || undefined,
              instagramUrl: (embeddedData.instagramUrl as string) || undefined,
              githubUrl: (embeddedData.githubUrl as string) || undefined,
              gitlabUrl: (embeddedData.gitlabUrl as string) || undefined,
              interests: (embeddedData.interests as string[]) || [],
              customInterests: (embeddedData.customInterests as string) || undefined,
              customAnswers: (embeddedData.customAnswers as CustomAnswer[]) || [],
              avatarFileRef: (embeddedData.avatarFileRef as string) || undefined,
              avatarData: (embeddedData.avatarData as string) || undefined,
              avatarMimeType: (embeddedData.avatarMimeType as string) || undefined,
              submittedAt: (attrs?.dt as string) || new Date().toISOString(),
            },
            isPending: true,
          });
        } catch (parseErr) {
          console.warn('[RegistrationPolling] Failed to parse IPEX apply pending notification:', notification.i, parseErr);
        }
      }

      // === 3. Check for IPEX APPLY notifications (primary registration route) ===
      const ipexApplyNotifications = allNotes.filter(
        n => n.a?.r === REGISTRATION_ROUTES.IPEX_APPLY && !n.r
      );

      for (const notification of ipexApplyNotifications) {
        try {
          const exchange = await keriClient.getExchange(notification.a.d);
          const exn = exchange.exn;

          // IPEX apply has registration data in exn.a (attributes)
          const attributes = exn.a || {};

          // Skip if no name - not a valid registration
          if (!attributes.name) {
            continue;
          }

          registrations.push({
            notificationId: notification.i,
            exnSaid: notification.a.d,
            applicantAid: exn.i,
            applicantOOBI: (attributes.senderOOBI as string) || undefined,
            profile: {
              name: (attributes.name as string) || 'Unknown',
              email: (attributes.email as string) || undefined,
              bio: (attributes.bio as string) || '',
              location: (attributes.location as string) || undefined,
              joinReason: (attributes.joinReason as string) || undefined,
              indigenousCommunity: (attributes.indigenousCommunity as string) || undefined,
              facebookUrl: (attributes.facebookUrl as string) || undefined,
              linkedinUrl: (attributes.linkedinUrl as string) || undefined,
              twitterUrl: (attributes.twitterUrl as string) || undefined,
              instagramUrl: (attributes.instagramUrl as string) || undefined,
              githubUrl: (attributes.githubUrl as string) || undefined,
              gitlabUrl: (attributes.gitlabUrl as string) || undefined,
              interests: (attributes.interests as string[]) || [],
              customInterests: (attributes.customInterests as string) || undefined,
              customAnswers: (attributes.customAnswers as CustomAnswer[]) || [],
              avatarFileRef: (attributes.avatarFileRef as string) || undefined,
              avatarData: (attributes.avatarData as string) || undefined,
              avatarMimeType: (attributes.avatarMimeType as string) || undefined,
              submittedAt: (attributes.submittedAt as string) || new Date().toISOString(),
            },
            isPending: false,
          });
        } catch (exnErr) {
          console.warn('[RegistrationPolling] Failed to fetch IPEX apply:', notification.a.d, exnErr);
        }
      }

      // === 4. Check for VERIFIED custom EXN notifications (fallback) ===
      const verifiedNotifications = allNotes.filter(
        n => n.a?.r === REGISTRATION_ROUTES.VERIFIED && !n.r
      );

      for (const notification of verifiedNotifications) {
        try {
          const exchange = await keriClient.getExchange(notification.a.d);
          const exn = exchange.exn;

          const attributes = exn.a || {};

          // Check if this looks like a registration
          const isRegistration =
            attributes.type === 'registration' ||
            attributes.name;

          if (!isRegistration) continue;

          registrations.push({
            notificationId: notification.i,
            exnSaid: notification.a.d,
            applicantAid: exn.i,
            applicantOOBI: (attributes.senderOOBI as string) || undefined,
            profile: {
              name: (attributes.name as string) || 'Unknown',
              email: (attributes.email as string) || undefined,
              bio: (attributes.bio as string) || '',
              location: (attributes.location as string) || undefined,
              joinReason: (attributes.joinReason as string) || undefined,
              indigenousCommunity: (attributes.indigenousCommunity as string) || undefined,
              facebookUrl: (attributes.facebookUrl as string) || undefined,
              linkedinUrl: (attributes.linkedinUrl as string) || undefined,
              twitterUrl: (attributes.twitterUrl as string) || undefined,
              instagramUrl: (attributes.instagramUrl as string) || undefined,
              githubUrl: (attributes.githubUrl as string) || undefined,
              gitlabUrl: (attributes.gitlabUrl as string) || undefined,
              interests: (attributes.interests as string[]) || [],
              customInterests: (attributes.customInterests as string) || undefined,
              customAnswers: (attributes.customAnswers as CustomAnswer[]) || [],
              avatarFileRef: (attributes.avatarFileRef as string) || undefined,
              avatarData: (attributes.avatarData as string) || undefined,
              avatarMimeType: (attributes.avatarMimeType as string) || undefined,
              submittedAt: (attributes.submittedAt as string) || new Date().toISOString(),
            },
            isPending: false,
          });
        } catch (exnErr) {
          console.warn('[RegistrationPolling] Failed to fetch custom EXN:', notification.a.d, exnErr);
        }
      }

      // === 5. Fallback: load pending registrations from backend SharedProfiles ===
      // A steward who joined the org group AFTER a registration was submitted won't have
      // the KERIA notification (it was delivered before they joined). Load pending
      // SharedProfiles from the backend API to fill the gap.
      if (registrations.length === 0) {
        try {
          const sharedProfiles = await getProfiles('SharedProfile') as Array<{ id: string; data: Record<string, unknown> }>;
          const pendingProfiles = sharedProfiles.filter(
            p => (p.data?.status as string) === 'pending'
          );

          for (const sp of pendingProfiles) {
            const aid = (sp.data?.aid as string) || '';
            if (!aid || processedApplicantAids.has(aid)) continue;

            registrations.push({
              notificationId: sp.id,
              exnSaid: sp.id,
              applicantAid: aid,
              profile: {
                name: (sp.data?.displayName as string) || 'Unknown',
                email: (sp.data?.email as string) || undefined,
                bio: (sp.data?.bio as string) || '',
                location: (sp.data?.location as string) || undefined,
                joinReason: (sp.data?.joinReason as string) || undefined,
                indigenousCommunity: (sp.data?.indigenousCommunity as string) || undefined,
                interests: (sp.data?.interests as string[]) || [],
                customAnswers: (sp.data?.customAnswers as CustomAnswer[]) || [],
                submittedAt: (sp.data?.createdAt as string) || new Date().toISOString(),
              },
              isPending: false,
            });
          }

          if (pendingProfiles.length > 0) {
            console.log(`[RegistrationPolling] Loaded ${pendingProfiles.length} pending registrations from backend API`);
          }
        } catch (apiErr) {
          console.warn('[RegistrationPolling] Failed to load pending profiles from backend:', apiErr);
        }
      }

      // === 6. Deduplicate by applicantAid (prefer verified over pending, newest first) ===
      // A user might send multiple registration messages (retries), show only the most recent.
      // When merging, keep the best profile data: a custom EXN pending has full profile
      // data (name, email, etc.) while an IPEX apply pending may only have "Unknown" name.
      const applicantMap = new Map<string, PendingRegistration>();

      // Sort: verified first, then entries with real name first, then newest first
      registrations.sort((a, b) => {
        if (a.isPending !== b.isPending) return a.isPending ? 1 : -1;
        const aHasName = a.profile.name && a.profile.name !== 'Unknown' ? 0 : 1;
        const bHasName = b.profile.name && b.profile.name !== 'Unknown' ? 0 : 1;
        if (aHasName !== bHasName) return aHasName - bHasName;
        return new Date(b.profile.submittedAt).getTime() - new Date(a.profile.submittedAt).getTime();
      });

      for (const reg of registrations) {
        // Skip if no applicant AID (invalid registration)
        if (!reg.applicantAid) continue;

        if (!applicantMap.has(reg.applicantAid)) {
          applicantMap.set(reg.applicantAid, reg);
        }
      }

      const deduped = Array.from(applicantMap.values());

      // Re-sort by submission time (newest first)
      deduped.sort((a, b) =>
        new Date(b.profile.submittedAt).getTime() - new Date(a.profile.submittedAt).getTime()
      );

      // Filter out already-processed registrations (approved/declined)
      const filtered = deduped.filter(r => !processedApplicantAids.has(r.applicantAid));

      // === 6b. Dead-lettered (expired) registrations from the KERIA patch ===
      // The escrowed exn passed the dead-letter bound and was removed — it can
      // never verify now, so the applicant has to re-apply. One entry per
      // applicant (newest first, mirroring the dedup above).
      const failedNotes = allNotes.filter(
        n => FAILED_REGISTRATION_ROUTES.includes(n.a?.r ?? '') && !n.r
      );
      const expiredByAid = new Map<string, ExpiredRegistration>();
      for (const note of failedNotes) {
        const expired = parseFailedRegistrationNotification(note);
        if (expired && !expiredByAid.has(expired.applicantAid)) {
          expiredByAid.set(expired.applicantAid, expired);
        }
      }
      expiredRegistrations.value = Array.from(expiredByAid.values());

      // Flag applicants whose key state has been unresolvable for days.
      // Skip expired ones — the dead-letter banner already covers them and
      // retrying resolution can no longer rescue the removed exn.
      const flagNow = Date.now();
      for (const reg of filtered) {
        if (reg.isPending && !expiredByAid.has(reg.applicantAid)) {
          reg.unreachable = isApplicantUnreachable(resolveStates.get(reg.applicantAid), flagNow);
        }
      }

      // De-escrow: resolve pending applicants' OOBIs in the background so the
      // escrowed exn verifies and the real notification appears on a later poll.
      const pendingToResolve = filtered.filter(r => r.isPending);
      if (pendingToResolve.length > 0) {
        void resolvePendingApplicants(pendingToResolve);
      }

      if (filtered.length > 0) {
        const pendingCount = filtered.filter(r => r.isPending).length;
        const verifiedCount = filtered.filter(r => !r.isPending).length;
        console.log(`[RegistrationPolling] ${filtered.length} registrations (${pendingCount} pending, ${verifiedCount} verified)`);
      }

      pendingRegistrations.value = filtered;

      // === 6c. Open-approval auto-approve ===
      // When the kit's approval mode is `open`, no endorsement/session/admin
      // gate applies — a steward's client approves each verified registration
      // the moment it lands, once per exnSaid. Pending (escrowed) rows wait
      // until they verify; a failed approval (e.g. another action in flight)
      // clears its guard so the next poll retries.
      if (isOpen(KIT.onboarding.approval)) {
        for (const reg of filtered) {
          if (reg.isPending || autoApprovedExnSaids.has(reg.exnSaid)) continue;
          autoApprovedExnSaids.add(reg.exnSaid);
          void adminActions
            .approveRegistration(reg)
            .then((ok) => {
              if (ok) {
                console.log(`[RegistrationPolling] open approval → auto-approved ${reg.profile.name}`);
              } else {
                autoApprovedExnSaids.delete(reg.exnSaid);
              }
            })
            .catch((err) => {
              autoApprovedExnSaids.delete(reg.exnSaid);
              console.warn('[RegistrationPolling] open auto-approve failed:', err);
            });
        }
      }

      // === 7. Check for MESSAGE REPLY notifications from applicants ===
      const messageReplyNotifications = allNotes.filter(
        n => n.a?.r === REGISTRATION_ROUTES.MESSAGE_REPLY && !n.r
      );

      for (const notification of messageReplyNotifications) {
        try {
          const exchange = await keriClient.getExchange(notification.a.d);
          const exn = exchange.exn;
          const payload = exn.a || {};

          // Check if we already have this message
          const existingIds = applicantMessages.value.map(m => m.id);
          if (!existingIds.includes(notification.a.d)) {
            applicantMessages.value.push({
              id: notification.a.d,
              applicantAid: exn.i,
              content: (payload.content as string) || '',
              sentAt: (payload.sentAt as string) || new Date().toISOString(),
            });
            console.log('[RegistrationPolling] New applicant message received from:', exn.i);
          }

          // Mark as read
          await keriClient.markNotificationRead(notification.i);
        } catch (msgErr) {
          console.warn('[RegistrationPolling] Failed to fetch message reply:', notification.a.d, msgErr);
        }
      }

      // Create pending SharedProfiles for new registrations (from KERIA notifications)
      await createPendingProfiles(filtered);

      lastPollTime.value = new Date();
      consecutiveErrors.value = 0;
      error.value = null;
    } catch (err) {
      consecutiveErrors.value++;
      console.error('[RegistrationPolling] Poll error:', err);

      if (consecutiveErrors.value >= maxConsecutiveErrors) {
        error.value = `Failed to poll for registrations after ${maxConsecutiveErrors} attempts`;
        stopPolling();
      }
    }
  }

  /**
   * Start polling for registrations
   */
  function startPolling(): void {
    if (isPolling.value) return;

    const client = keriClient.getSignifyClient();
    if (!client) {
      console.warn('[RegistrationPolling] No SignifyClient available');
      error.value = 'Not connected to KERIA';
      return;
    }

    console.log('[RegistrationPolling] Starting...');
    isPolling.value = true;
    error.value = null;
    consecutiveErrors.value = 0;

    // Process immediately
    pollForRegistrations();

    // React to service fetches
    stopWatcher = watch(
      () => notificationService.lastFetchTime.value,
      () => { pollForRegistrations(); },
    );
  }

  /**
   * Stop polling
   */
  function stopPolling(): void {
    if (stopWatcher) {
      stopWatcher();
      stopWatcher = null;
    }
    isPolling.value = false;
    console.log('[RegistrationPolling] Polling stopped');
  }

  /**
   * Manually trigger a poll (e.g., after taking an action)
   */
  async function refresh(): Promise<void> {
    await pollForRegistrations();
  }

  /**
   * Remove a registration from the list (after processing)
   * Also tracks the applicantAid to prevent re-adding on next poll
   * (multiple notifications can exist for the same user)
   */
  function removeRegistration(notificationId: string): void {
    const registration = pendingRegistrations.value.find(r => r.notificationId === notificationId);
    if (registration) {
      processedApplicantAids.add(registration.applicantAid);
    }
    pendingRegistrations.value = pendingRegistrations.value.filter(
      r => r.notificationId !== notificationId
    );
  }

  /**
   * Dismiss an expired-registration alert: marks the dead-letter notification
   * read so it stops surfacing on every poll.
   */
  async function dismissExpired(notificationId: string): Promise<void> {
    try {
      await keriClient.markNotificationRead(notificationId);
    } catch (err) {
      console.warn('[RegistrationPolling] Failed to mark expired notification read:', err);
    }
    expiredRegistrations.value = expiredRegistrations.value.filter(
      e => e.notificationId !== notificationId
    );
  }

  /**
   * Create pending SharedProfiles for new registrations.
   * Called after polling detects new registrations.
   * Idempotent: checks existing profiles and local tracking set.
   */
  async function createPendingProfiles(registrations: PendingRegistration[]): Promise<void> {
    if (registrations.length === 0) return;

    // Load existing SharedProfiles to check which applicants already have one
    let existingAids: Set<string>;
    try {
      const existing = await getProfiles('SharedProfile');
      existingAids = new Set(
        existing
          .map(p => p.data.aid as string)
          .filter(Boolean)
      );
    } catch {
      console.warn('[RegistrationPolling] Failed to load existing SharedProfiles, skipping pending profile creation');
      return;
    }

    // Track whether any known profiles exist but may not be in the store yet
    let needsStoreRefresh = false;
    let createdCount = 0;
    for (const reg of registrations) {
      if (!reg.applicantAid) continue;
      if (existingAids.has(reg.applicantAid)) {
        // Profile already in any-sync — ensure it's in the store
        if (!profilesStore.communityProfiles.some(p => (p.data?.aid as string) === reg.applicantAid)) {
          needsStoreRefresh = true;
        }
        continue;
      }
      if (createdPendingProfiles.has(reg.applicantAid)) continue;

      const profileId = `SharedProfile-${reg.applicantAid}`;
      const now = new Date().toISOString();

      // Upload avatar from base64 registration data to get a local fileRef
      let avatarRef = '';
      if (reg.profile.avatarData && reg.profile.avatarMimeType) {
        try {
          const byteChars = atob(reg.profile.avatarData);
          const byteArray = new Uint8Array(byteChars.length);
          for (let i = 0; i < byteChars.length; i++) {
            byteArray[i] = byteChars.charCodeAt(i);
          }
          const blob = new Blob([byteArray], { type: reg.profile.avatarMimeType });
          const avatarFile = new File([blob], 'avatar', { type: reg.profile.avatarMimeType });
          const uploadResult = await uploadFile(avatarFile);
          if (uploadResult.fileRef) {
            avatarRef = uploadResult.fileRef;
          }
        } catch (avatarErr) {
          console.warn(`[RegistrationPolling] Avatar upload failed for ${reg.applicantAid.slice(0, 12)}...:`, avatarErr);
        }
      }

      const profileData: Record<string, unknown> = {
        aid: reg.applicantAid,
        status: 'pending',
        displayName: reg.profile.name || 'Unknown',
        bio: reg.profile.bio || '',
        avatar: avatarRef || reg.profile.avatarFileRef || '',
        location: reg.profile.location || '',
        joinReason: reg.profile.joinReason || '',
        indigenousCommunity: reg.profile.indigenousCommunity || '',
        participationInterests: reg.profile.interests || [],
        customInterests: reg.profile.customInterests || '',
        customAnswers: reg.profile.customAnswers || [],
        facebookUrl: reg.profile.facebookUrl || '',
        linkedinUrl: reg.profile.linkedinUrl || '',
        twitterUrl: reg.profile.twitterUrl || '',
        instagramUrl: reg.profile.instagramUrl || '',
        githubUrl: reg.profile.githubUrl || '',
        gitlabUrl: reg.profile.gitlabUrl || '',
        publicEmail: reg.profile.email || '',
        createdAt: now,
        updatedAt: now,
        typeVersion: 1,
      };

      try {
        const result = await createOrUpdateProfile('SharedProfile', profileData, { id: profileId });
        if (result.success) {
          createdPendingProfiles.add(reg.applicantAid);
          createdCount++;
          console.log(`[RegistrationPolling] Created pending SharedProfile for ${reg.applicantAid.slice(0, 12)}...`);
        } else {
          console.warn(`[RegistrationPolling] Failed to create pending SharedProfile: ${result.error}`);
        }
      } catch (err) {
        console.warn(`[RegistrationPolling] Error creating pending SharedProfile:`, err);
      }
    }

    // Refresh the profiles store so the dashboard shows the new pending members
    if (createdCount > 0 || needsStoreRefresh) {
      await profilesStore.loadCommunityProfiles();
    }
  }

  /**
   * Retry after error
   */
  function retry(): void {
    error.value = null;
    consecutiveErrors.value = 0;
    startPolling();
  }

  // Cleanup on unmount
  onUnmounted(() => {
    stopPolling();
  });

  return {
    // State
    pendingRegistrations,
    expiredRegistrations,
    applicantMessages,
    isPolling,
    error,
    lastPollTime,

    // Actions
    startPolling,
    stopPolling,
    refresh,
    removeRegistration,
    dismissExpired,
    retry,
  };
}
