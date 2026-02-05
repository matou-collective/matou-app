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
import { ref, onUnmounted } from 'vue';
import { useKERIClient } from 'src/lib/keri/client';

export interface PendingRegistration {
  notificationId: string;
  exnSaid: string;
  applicantAid: string;
  applicantOOBI?: string;
  profile: {
    name: string;
    email?: string;
    bio: string;
    interests: string[];
    customInterests?: string;
    avatarFileRef?: string;
    /** Base64-encoded avatar image data */
    avatarData?: string;
    /** MIME type of avatar image */
    avatarMimeType?: string;
    submittedAt: string;
  };
  /** True if from escrowed message (OOBI not resolved), false if verified */
  isPending: boolean;
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
};

export interface RegistrationPollingOptions {
  pollingInterval?: number;  // Default: 10000ms (10 seconds)
  maxConsecutiveErrors?: number;  // Default: 5
}

export function useRegistrationPolling(options: RegistrationPollingOptions = {}) {
  const { pollingInterval = 10000, maxConsecutiveErrors = 5 } = options;

  const keriClient = useKERIClient();

  // State
  const pendingRegistrations = ref<PendingRegistration[]>([]);
  const applicantMessages = ref<ApplicantMessage[]>([]);
  const isPolling = ref(false);
  const error = ref<string | null>(null);
  const lastPollTime = ref<Date | null>(null);
  const consecutiveErrors = ref(0);

  // Track processed applicants to prevent re-adding after removal
  // This is needed because multiple notifications can exist for the same user
  const processedApplicantAids = new Set<string>();

  // Internal state
  let pollingTimer: ReturnType<typeof setInterval> | null = null;

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
      const registrations: PendingRegistration[] = [];

      // Debug: List ALL unread notifications to see what routes exist
      const allNotes = await keriClient.listNotifications({ read: false });
      const routeCounts = allNotes.reduce((acc: Record<string, number>, n: { a?: { r?: string } }) => {
        const route = n.a?.r || 'unknown';
        acc[route] = (acc[route] || 0) + 1;
        return acc;
      }, {});
      console.log(`[RegistrationPolling] All unread notifications by route:`, JSON.stringify(routeCounts));

      // === 1. Check for PENDING notifications (from KERIA patch) ===
      const pendingNotifications = await keriClient.listNotifications({
        route: REGISTRATION_ROUTES.PENDING,
        read: false,
      });

      console.log(`[RegistrationPolling] Pending notifications: ${pendingNotifications.length}`);

      // Log first few notifications for debugging - dump full structure
      if (pendingNotifications.length > 0) {
        console.log('[RegistrationPolling] Sample pending notifications (full structure):');
        for (let i = 0; i < Math.min(3, pendingNotifications.length); i++) {
          const n = pendingNotifications[i];
          console.log(`  [${i}] FULL NOTIFICATION:`, JSON.stringify(n, null, 2));
        }
      }

      for (const notification of pendingNotifications) {
        try {
          // Pending notifications from patch have data directly in a.a
          const attrs = notification.a;
          const embeddedData = attrs?.a || {};

          const applicantAid = attrs?.i || '';
          const name = (embeddedData.name as string) || 'Unknown';

          // Log each unique applicant we find
          console.log(`[RegistrationPolling] Parsed: aid=${applicantAid.slice(0, 12)}..., name="${name}"`);

          registrations.push({
            notificationId: notification.i,
            exnSaid: attrs?.d || notification.i,
            applicantAid,
            applicantOOBI: (embeddedData.senderOOBI as string) || undefined,
            profile: {
              name,
              email: (embeddedData.email as string) || undefined,
              bio: (embeddedData.bio as string) || '',
              interests: (embeddedData.interests as string[]) || [],
              customInterests: (embeddedData.customInterests as string) || undefined,
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
      const ipexApplyPendingNotifications = await keriClient.listNotifications({
        route: REGISTRATION_ROUTES.IPEX_APPLY_PENDING,
        read: false,
      });

      console.log(`[RegistrationPolling] IPEX apply pending notifications: ${ipexApplyPendingNotifications.length}`);

      for (const notification of ipexApplyPendingNotifications) {
        try {
          // Pending notifications from patch have data directly in a.a
          const attrs = notification.a;
          const embeddedData = attrs?.a || {};

          const applicantAid = attrs?.i || '';
          const name = (embeddedData.name as string) || 'Unknown';

          console.log(`[RegistrationPolling] IPEX apply pending: aid=${applicantAid.slice(0, 12)}..., name="${name}"`);

          registrations.push({
            notificationId: notification.i,
            exnSaid: attrs?.d || notification.i,
            applicantAid,
            applicantOOBI: (embeddedData.senderOOBI as string) || undefined,
            profile: {
              name,
              email: (embeddedData.email as string) || undefined,
              bio: (embeddedData.bio as string) || '',
              interests: (embeddedData.interests as string[]) || [],
              customInterests: (embeddedData.customInterests as string) || undefined,
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
      const ipexApplyNotifications = await keriClient.listNotifications({
        route: REGISTRATION_ROUTES.IPEX_APPLY,
        read: false,
      });

      console.log(`[RegistrationPolling] IPEX apply notifications: ${ipexApplyNotifications.length}`);

      for (const notification of ipexApplyNotifications) {
        try {
          const exchange = await keriClient.getExchange(notification.a.d);
          const exn = exchange.exn;

          // IPEX apply has registration data in exn.a (attributes)
          const attributes = exn.a || {};

          // Skip if no name - not a valid registration
          if (!attributes.name) {
            console.log(`[RegistrationPolling] Skipping IPEX apply without name:`, notification.a.d);
            continue;
          }

          console.log(`[RegistrationPolling] IPEX apply from ${exn.i?.slice(0, 12)}..., name="${attributes.name}"`);

          registrations.push({
            notificationId: notification.i,
            exnSaid: notification.a.d,
            applicantAid: exn.i,
            applicantOOBI: (attributes.senderOOBI as string) || undefined,
            profile: {
              name: (attributes.name as string) || 'Unknown',
              email: (attributes.email as string) || undefined,
              bio: (attributes.bio as string) || '',
              interests: (attributes.interests as string[]) || [],
              customInterests: (attributes.customInterests as string) || undefined,
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
      const verifiedNotifications = await keriClient.listNotifications({
        route: REGISTRATION_ROUTES.VERIFIED,
        read: false,
      });

      console.log(`[RegistrationPolling] Verified custom EXN notifications: ${verifiedNotifications.length}`);

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
              interests: (attributes.interests as string[]) || [],
              customInterests: (attributes.customInterests as string) || undefined,
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

      // === 5. Deduplicate by applicantAid (prefer verified over pending, newest first) ===
      // A user might send multiple registration messages (retries), show only the most recent
      const seenApplicants = new Set<string>();
      const deduped: PendingRegistration[] = [];

      // Sort: verified first, then by submission time (newest first)
      registrations.sort((a, b) => {
        if (a.isPending !== b.isPending) return a.isPending ? 1 : -1;
        return new Date(b.profile.submittedAt).getTime() - new Date(a.profile.submittedAt).getTime();
      });

      for (const reg of registrations) {
        // Skip if no applicant AID (invalid registration)
        if (!reg.applicantAid) continue;

        if (!seenApplicants.has(reg.applicantAid)) {
          seenApplicants.add(reg.applicantAid);
          deduped.push(reg);
        }
      }

      // Re-sort by submission time (newest first)
      deduped.sort((a, b) =>
        new Date(b.profile.submittedAt).getTime() - new Date(a.profile.submittedAt).getTime()
      );

      // Filter out already-processed registrations (approved/declined)
      const filtered = deduped.filter(r => !processedApplicantAids.has(r.applicantAid));

      const pendingCount = filtered.filter(r => r.isPending).length;
      const verifiedCount = filtered.filter(r => !r.isPending).length;
      console.log(`[RegistrationPolling] After dedup: ${deduped.length} unique applicants, after filter: ${filtered.length}`);
      console.log(`[RegistrationPolling] Found ${filtered.length} registrations (${pendingCount} pending, ${verifiedCount} verified)`);

      // Log the final registrations
      for (const reg of filtered) {
        console.log(`[RegistrationPolling] Registration: aid=${reg.applicantAid.slice(0, 12)}..., name="${reg.profile.name}", pending=${reg.isPending}`);
      }

      pendingRegistrations.value = filtered;

      // === 6. Check for MESSAGE REPLY notifications from applicants ===
      const messageReplyNotifications = await keriClient.listNotifications({
        route: REGISTRATION_ROUTES.MESSAGE_REPLY,
        read: false,
      });

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

    console.log('[RegistrationPolling] Starting polling...');
    isPolling.value = true;
    error.value = null;
    consecutiveErrors.value = 0;

    // Poll immediately
    pollForRegistrations();

    // Then poll at interval
    pollingTimer = setInterval(() => {
      pollForRegistrations();
    }, pollingInterval);
  }

  /**
   * Stop polling
   */
  function stopPolling(): void {
    if (pollingTimer) {
      clearInterval(pollingTimer);
      pollingTimer = null;
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
    applicantMessages,
    isPolling,
    error,
    lastPollTime,

    // Actions
    startPolling,
    stopPolling,
    refresh,
    removeRegistration,
    retry,
  };
}
