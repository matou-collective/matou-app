/**
 * Singleton service that fetches KERIA notifications and credentials on a
 * single shared timer. Consumers watch the reactive refs instead of making
 * their own KERIA calls.
 *
 * Usage:
 *   const { notifications, credentials, triggerNow } = useKERINotificationService();
 *   // In DashboardLayout.onMounted():
 *   start();
 *   // In composables:
 *   watch(notifications, (notes) => { // process your subset
 *   });
 */
import { ref, readonly, type DeepReadonly, type Ref } from 'vue';
import { useKERIClient } from 'src/lib/keri/client';

export interface KERINotification {
  i: string;
  a: {
    r: string;
    d: string;
    i?: string;
    a?: Record<string, unknown>;
    dt?: string;
    m?: string;
    [key: string]: unknown;
  };
  r: boolean;
}

// Module-level singleton state
const notifications = ref<KERINotification[]>([]);
const credentials = ref<any[]>([]);
const lastFetchTime = ref(0);
const isRunning = ref(false);
const fetchError = ref<string | null>(null);

let pollTimer: ReturnType<typeof setInterval> | null = null;
let keriClientInstance: ReturnType<typeof useKERIClient> | null = null;

const DEFAULT_INTERVAL = 30_000; // 30 seconds

async function fetchAll(): Promise<void> {
  const client = keriClientInstance?.getSignifyClient();
  if (!client) return;

  try {
    // Single call for all notifications (replaces 3+ separate calls)
    const notifResult = await client.notifications().list(0, 1000);
    notifications.value = notifResult.notes ?? [];

    // Single call for all credentials
    try {
      credentials.value = await client.credentials().list();
    } catch (credErr) {
      console.warn('[KERINotificationService] Credential fetch failed:', credErr);
      // Non-fatal: keep previous credentials, only update notifications
    }

    lastFetchTime.value = Date.now();
    fetchError.value = null;
  } catch (err) {
    console.error('[KERINotificationService] Fetch failed:', err);
    fetchError.value = err instanceof Error ? err.message : String(err);
  }
}

function start(interval = DEFAULT_INTERVAL): void {
  if (pollTimer) return;

  const keriClient = useKERIClient();
  keriClientInstance = keriClient;

  const client = keriClient.getSignifyClient();
  if (!client) {
    console.warn('[KERINotificationService] No SignifyClient available');
    return;
  }

  isRunning.value = true;
  console.log(`[KERINotificationService] Starting (interval: ${interval}ms)`);

  // Fetch immediately
  fetchAll();

  // Then on interval
  pollTimer = setInterval(fetchAll, interval);
}

function stop(): void {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
  isRunning.value = false;
  console.log('[KERINotificationService] Stopped');
}

/**
 * Trigger an immediate fetch (e.g. after admitting a grant).
 * Resets the timer so the next interval starts fresh.
 */
async function triggerNow(): Promise<void> {
  const interval = DEFAULT_INTERVAL;
  if (pollTimer) {
    clearInterval(pollTimer);
  }
  await fetchAll();
  if (isRunning.value) {
    pollTimer = setInterval(fetchAll, interval);
  }
}

export function useKERINotificationService() {
  return {
    notifications: readonly(notifications) as DeepReadonly<Ref<KERINotification[]>>,
    credentials: readonly(credentials) as DeepReadonly<Ref<any[]>>,
    lastFetchTime: readonly(lastFetchTime),
    isRunning: readonly(isRunning),
    fetchError: readonly(fetchError),
    start,
    stop,
    triggerNow,
  };
}
