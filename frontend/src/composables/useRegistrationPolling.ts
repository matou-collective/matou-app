/**
 * Composable for polling registration requests (admin side)
 * Polls for pending registration EXN messages and parses applicant data
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
}

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
   */
  async function pollForRegistrations(): Promise<void> {
    const client = keriClient.getSignifyClient();
    if (!client) {
      console.warn('[RegistrationPolling] SignifyClient not available');
      return;
    }

    try {
      // Get unread notifications for registration route
      const notifications = await keriClient.listNotifications({
        route: '/matou/registration/apply',
        read: false,
      });

      console.log(`[RegistrationPolling] Found ${notifications.length} pending registrations`);

      const registrations: PendingRegistration[] = [];

      for (const notification of notifications) {
        try {
          // Fetch the full EXN message
          const exchange = await keriClient.getExchange(notification.a.d);
          const exn = exchange.exn;

          // Extract payload - could be in 'a' (attributes) or root level
          const payload = exn.a || {};

          // Skip if not a registration type
          if (payload.type !== 'registration') {
            console.log('[RegistrationPolling] Skipping non-registration EXN:', notification.a.d);
            continue;
          }

          registrations.push({
            notificationId: notification.i,
            exnSaid: notification.a.d,
            applicantAid: exn.i,  // Sender AID
            applicantOOBI: payload.senderOOBI as string | undefined,
            profile: {
              name: (payload.name as string) || 'Unknown',
              bio: (payload.bio as string) || '',
              interests: (payload.interests as string[]) || [],
              customInterests: payload.customInterests as string | undefined,
              submittedAt: (payload.submittedAt as string) || new Date().toISOString(),
            },
          });
        } catch (exnErr) {
          console.warn('[RegistrationPolling] Failed to fetch EXN:', notification.a.d, exnErr);
        }
      }

      // Sort by submission time (newest first)
      registrations.sort((a, b) =>
        new Date(b.profile.submittedAt).getTime() - new Date(a.profile.submittedAt).getTime()
      );

      pendingRegistrations.value = registrations;
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
