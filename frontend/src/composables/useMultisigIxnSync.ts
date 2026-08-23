/**
 * Keeps a group member's agent in step with group `ixn`s created by OTHER
 * members (issue #63).
 *
 * With kt=1 each member's agent completes a group interaction alone, and
 * KERIA never tells the other members' agents — so the next member to issue
 * anchors at the same sn and the group KEL forks. Issuers now send KERIA's
 * native `/multisig/ixn` exn (KERIClient.sendMultisigIxnExn); this watcher
 * applies those notifications on every fetch of the shared notification
 * service (KERIClient.syncGroupIxnNotifications), for as long as the user is
 * a member of the org group. Issuance paths also drain before anchoring, so
 * this watcher is the fast path, not the only one.
 */
import { ref, watch, onUnmounted } from 'vue';
import { useKERIClient } from 'src/lib/keri/client';
import { getOrFetchOrgConfig } from 'src/api/config';
import { useKERINotificationService } from './useKERINotificationService';

const MULTISIG_IXN_ROUTE = '/multisig/ixn';

export function useMultisigIxnSync() {
  const keriClient = useKERIClient();
  const notificationService = useKERINotificationService();

  const isSyncing = ref(false);
  const appliedTotal = ref(0);
  const error = ref<string | null>(null);

  let stopWatcher: (() => void) | null = null;
  let orgName: string | null = null;

  async function syncOnce(): Promise<number> {
    if (isSyncing.value) return 0;
    const client = keriClient.getSignifyClient();
    if (!client) return 0;
    const pending = notificationService.notifications.value.filter(
      (n) => n.a?.r === MULTISIG_IXN_ROUTE && !n.r,
    );
    if (pending.length === 0) return 0;

    isSyncing.value = true;
    try {
      if (!orgName) {
        const config = await getOrFetchOrgConfig();
        if (!config?.organization?.aid) return 0;
        orgName = (config.organization.name || 'matou').toLowerCase().replace(/\s+/g, '-');
      }
      const applied = await keriClient.syncGroupIxnNotifications(orgName);
      if (applied > 0) {
        appliedTotal.value += applied;
        console.log(`[MultisigIxnSync] applied ${applied} group ixn(s) from other members`);
      }
      error.value = null;
      return applied;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error('[MultisigIxnSync] sync failed:', msg);
      error.value = msg;
      return 0;
    } finally {
      isSyncing.value = false;
    }
  }

  function start(): void {
    if (stopWatcher) return;
    console.log('[MultisigIxnSync] Starting watch for /multisig/ixn...');
    void syncOnce();
    stopWatcher = watch(
      () => notificationService.lastFetchTime.value,
      () => { void syncOnce(); },
    );
  }

  function stop(): void {
    if (stopWatcher) {
      stopWatcher();
      stopWatcher = null;
    }
  }

  onUnmounted(stop);

  return { isSyncing, appliedTotal, error, syncOnce, start, stop };
}
