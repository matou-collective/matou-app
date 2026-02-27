/**
 * Composable for auto-joining the org multisig group.
 * Watches the shared notification service for /multisig/rot notifications and completes the join.
 * Used by stewards after being promoted to Founding Member or Community Steward.
 */
import { ref, watch, onUnmounted } from 'vue';
import { useKERIClient } from 'src/lib/keri/client';
import { getOrFetchOrgConfig } from 'src/api/config';
import { secureStorage } from 'src/lib/secureStorage';
import { useKERINotificationService } from './useKERINotificationService';

const MULTISIG_ROT_ROUTE = '/multisig/rot';

export function useMultisigJoin() {
  const keriClient = useKERIClient();
  const notificationService = useKERINotificationService();

  const isJoining = ref(false);
  const hasJoined = ref(false);
  const error = ref<string | null>(null);

  let stopWatcher: (() => void) | null = null;

  /**
   * Check for /multisig/rot notifications and join if found
   */
  async function checkAndJoinMultisig(): Promise<boolean> {
    const client = keriClient.getSignifyClient();
    if (!client) return false;

    try {
      const allNotifications = notificationService.notifications.value;

      const notifications = allNotifications.filter(
        n => n.a?.r === MULTISIG_ROT_ROUTE && !n.r
      );

      if (notifications.length === 0) return false;

      console.log(`[MultisigJoin] Found ${notifications.length} unread /multisig/rot notifications`);

      const config = await getOrFetchOrgConfig();

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

        // Don't mark as read on failure — let the watcher retry on next fetch
        return false;
      } finally {
        isJoining.value = false;
      }
    } catch (err) {
      console.warn('[MultisigJoin] Check failed:', err);
      return false;
    }
  }

  function startPolling(interval?: number): void {
    if (stopWatcher) return;

    console.log('[MultisigJoin] Starting watch for /multisig/rot...');

    // Check immediately
    checkAndJoinMultisig().then(joined => {
      if (joined) stopPolling();
    });

    // React to service fetches
    stopWatcher = watch(
      () => notificationService.lastFetchTime.value,
      async () => {
        const joined = await checkAndJoinMultisig();
        if (joined) stopPolling();
      },
    );
  }

  function stopPolling(): void {
    if (stopWatcher) {
      stopWatcher();
      stopWatcher = null;
    }
    console.log('[MultisigJoin] Stopped');
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
