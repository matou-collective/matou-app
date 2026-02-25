/**
 * Composable for auto-joining the org multisig group.
 * Polls for /multisig/rot notifications and completes the join.
 * Used by stewards after being promoted to Founding Member or Community Steward.
 */
import { ref, onUnmounted } from 'vue';
import { useKERIClient } from 'src/lib/keri/client';
import { fetchOrgConfig } from 'src/api/config';
import { secureStorage } from 'src/lib/secureStorage';

const MULTISIG_ROT_ROUTE = '/multisig/rot';

export function useMultisigJoin() {
  const keriClient = useKERIClient();

  const isJoining = ref(false);
  const hasJoined = ref(false);
  const error = ref<string | null>(null);

  let pollingTimer: ReturnType<typeof setInterval> | null = null;

  /**
   * Check for /multisig/rot notifications and join if found
   */
  async function checkAndJoinMultisig(): Promise<boolean> {
    const client = keriClient.getSignifyClient();
    if (!client) return false;

    try {
      // Ensure KERIA session is fresh before polling
      await keriClient.ensureSession();

      const allNotifications = await keriClient.listNotifications();

      const notifications = allNotifications.filter(
        n => n.a?.r === MULTISIG_ROT_ROUTE && !n.r
      );

      if (notifications.length === 0) return false;

      console.log(`[MultisigJoin] Found ${notifications.length} unread /multisig/rot notifications`);

      const configResult = await fetchOrgConfig();
      const config = configResult.status === 'configured'
        ? configResult.config
        : configResult.status === 'server_unreachable'
          ? configResult.cached
          : null;

      if (!config?.organization?.aid) {
        console.warn('[MultisigJoin] No org config available');
        return false;
      }

      const orgName = (config.organization.name || 'matou').toLowerCase().replace(/\s+/g, '-');

      const notification = notifications[0];
      isJoining.value = true;
      error.value = null;

      try {
        const gid = await keriClient.joinGroup(orgName, notification.a.d);
        console.log(`[MultisigJoin] Joined group: ${gid}`);

        await secureStorage.setItem('matou_org_aid', gid);
        keriClient.setOrgAID(gid);

        await keriClient.markNotificationRead(notification.i);

        hasJoined.value = true;
        return true;
      } catch (joinErr) {
        const msg = joinErr instanceof Error ? joinErr.message : String(joinErr);
        console.error('[MultisigJoin] Join failed:', joinErr);
        error.value = msg;

        // Don't mark as read on failure — let the poller retry on next cycle
        return false;
      } finally {
        isJoining.value = false;
      }
    } catch (err) {
      console.warn('[MultisigJoin] Check failed:', err);
      return false;
    }
  }

  function startPolling(interval = 5000): void {
    if (pollingTimer) return;

    console.log('[MultisigJoin] Starting poll for /multisig/rot...');

    checkAndJoinMultisig().then(joined => {
      if (joined) stopPolling();
    });

    pollingTimer = setInterval(async () => {
      const joined = await checkAndJoinMultisig();
      if (joined) stopPolling();
    }, interval);
  }

  function stopPolling(): void {
    if (pollingTimer) {
      clearInterval(pollingTimer);
      pollingTimer = null;
      console.log('[MultisigJoin] Polling stopped');
    }
  }

  onUnmounted(() => {
    stopPolling();
  });

  return {
    isJoining,
    hasJoined,
    error,
    checkAndJoinMultisig,
    startPolling,
    stopPolling,
  };
}
