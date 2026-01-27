/**
 * Composable for polling registration requests (admin side)
 * Polls for pending registration EXN messages and parses applicant data
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
    bio: string;
    interests: string[];
    customInterests?: string;
    submittedAt: string;
  };
  /** True if from escrowed message (OOBI not resolved), false if verified */
  isPending: boolean;
}

// Routes to poll for registration notifications
const REGISTRATION_ROUTES = {
  // Pending notifications from KERIA patch (escrowed, unverified)
  PENDING: '/exn/matou/registration/apply/pending',
  // Verified notifications (after OOBI resolution)
  VERIFIED_CUSTOM: '/exn/matou/registration/apply',
  VERIFIED_IPEX: '/exn/ipex/apply',
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
  const isPolling = ref(false);
  const error = ref<string | null>(null);
  const lastPollTime = ref<Date | null>(null);
  const consecutiveErrors = ref(0);

  // Internal state
  let pollingTimer: ReturnType<typeof setInterval> | null = null;

  /**
   * Poll for registration notifications
   * Checks both pending (escrowed) and verified notification routes
   */
  async function pollForRegistrations(): Promise<void> {
    const client = keriClient.getSignifyClient();
    if (!client) {
      console.warn('[RegistrationPolling] SignifyClient not available');
      return;
    }

    try {
      const registrations: PendingRegistration[] = [];

      // === 1. Check for PENDING notifications (from KERIA patch) ===
      // These are escrowed messages where sender OOBI has not been resolved yet
      // Data is embedded directly in notification.a.a
      try {
        const pendingNotifications = await keriClient.listNotifications({
          route: REGISTRATION_ROUTES.PENDING,
          read: false,
        });
        console.log(`[RegistrationPolling] Pending (escrowed) notifications: ${pendingNotifications.length}`);

        for (const notification of pendingNotifications) {
          try {
            // Pending notifications from patch have data directly in a.a
            const attrs = notification.a;
            const embeddedData = attrs?.a || {};

            console.log('[RegistrationPolling] Processing PENDING notification:', JSON.stringify(notification, null, 2));

            // Parse embedded registration data
            registrations.push({
              notificationId: notification.i,
              exnSaid: attrs?.d || notification.i,
              applicantAid: attrs?.i || '',
              applicantOOBI: (embeddedData.senderOOBI as string) || undefined,
              profile: {
                name: (embeddedData.name as string) || 'Unknown',
                bio: (embeddedData.bio as string) || '',
                interests: (embeddedData.interests as string[]) || [],
                customInterests: (embeddedData.customInterests as string) || undefined,
                submittedAt: (attrs?.dt as string) || new Date().toISOString(),
              },
              isPending: true,
            });
          } catch (parseErr) {
            console.warn('[RegistrationPolling] Failed to parse pending notification:', notification.i, parseErr);
          }
        }
      } catch (pendingErr) {
        console.log('[RegistrationPolling] Error fetching pending notifications:', pendingErr);
      }

      // === 2. Check for VERIFIED notifications (standard flow) ===
      // These are processed after OOBI resolution, need to fetch full EXN

      // 2a. IPEX apply notifications
      const ipexNotifications = await keriClient.listNotifications({
        route: REGISTRATION_ROUTES.VERIFIED_IPEX,
        read: false,
      });
      console.log(`[RegistrationPolling] IPEX apply notifications: ${ipexNotifications.length}`);

      // 2b. Custom route notifications
      const customNotifications = await keriClient.listNotifications({
        route: REGISTRATION_ROUTES.VERIFIED_CUSTOM,
        read: false,
      });
      console.log(`[RegistrationPolling] Custom route notifications: ${customNotifications.length}`);

      // Process verified notifications
      const verifiedNotifications = [...ipexNotifications, ...customNotifications];

      for (const notification of verifiedNotifications) {
        try {
          // Fetch the full EXN message for verified notifications
          const exchange = await keriClient.getExchange(notification.a.d);
          const exn = exchange.exn;

          console.log('[RegistrationPolling] Processing VERIFIED EXN:', JSON.stringify(exn, null, 2));

          // For IPEX apply, the data is structured differently:
          // - exn.a contains attributes (name, interests)
          // - exn.e?.msg contains the JSON message with bio, senderOOBI, etc.
          const attributes = exn.a || {};
          let messageData: Record<string, unknown> = {};

          // Parse the message field if it exists (we encoded registration data there)
          if (typeof attributes.msg === 'string') {
            try {
              messageData = JSON.parse(attributes.msg);
            } catch {
              console.warn('[RegistrationPolling] Could not parse message JSON');
            }
          }

          // For IPEX apply, check if this looks like a registration
          // (has name in attributes or registration type in message)
          const isRegistration =
            messageData.type === 'registration' ||
            attributes.name ||
            (exn.r && exn.r.includes('/ipex/apply'));

          if (!isRegistration) {
            console.log('[RegistrationPolling] Skipping non-registration IPEX apply:', notification.a.d);
            continue;
          }

          registrations.push({
            notificationId: notification.i,
            exnSaid: notification.a.d,
            applicantAid: exn.i,  // Sender AID
            applicantOOBI: (messageData.senderOOBI as string) || undefined,
            profile: {
              name: (attributes.name as string) || 'Unknown',
              bio: (messageData.bio as string) || '',
              interests: (attributes.interests as string[]) || [],
              customInterests: (messageData.customInterests as string) || undefined,
              submittedAt: (messageData.submittedAt as string) || new Date().toISOString(),
            },
            isPending: false,
          });
        } catch (exnErr) {
          console.warn('[RegistrationPolling] Failed to fetch EXN:', notification.a.d, exnErr);
        }
      }

      // === 3. Log debug info for escrows ===
      try {
        const escrowReplies = await client.escrows().listReply('/exn/ipex/apply');
        if (escrowReplies && Object.keys(escrowReplies).length > 0) {
          console.log('[RegistrationPolling] Escrow replies (ipex/apply):', JSON.stringify(escrowReplies, null, 2));
        }
      } catch {
        // Escrow API may not be available
      }

      // === 4. Deduplicate by exnSaid (prefer verified over pending) ===
      const seenSaids = new Set<string>();
      const deduped: PendingRegistration[] = [];

      // Sort so verified (isPending=false) comes first
      registrations.sort((a, b) => {
        if (a.isPending !== b.isPending) return a.isPending ? 1 : -1;
        return new Date(b.profile.submittedAt).getTime() - new Date(a.profile.submittedAt).getTime();
      });

      for (const reg of registrations) {
        if (!seenSaids.has(reg.exnSaid)) {
          seenSaids.add(reg.exnSaid);
          deduped.push(reg);
        }
      }

      // Re-sort by submission time (newest first)
      deduped.sort((a, b) =>
        new Date(b.profile.submittedAt).getTime() - new Date(a.profile.submittedAt).getTime()
      );

      console.log(`[RegistrationPolling] Total registrations: ${deduped.length} (${deduped.filter(r => r.isPending).length} pending, ${deduped.filter(r => !r.isPending).length} verified)`);

      pendingRegistrations.value = deduped;
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
   * @param notificationId - The notification ID to remove
   */
  function removeRegistration(notificationId: string): void {
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
