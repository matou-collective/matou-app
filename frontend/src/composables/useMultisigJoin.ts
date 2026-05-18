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
        n => n.a?.r === MULTISIG_ROT_ROUTE && !n.r,
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

      const { classifyMultisigRot, adminPrefixFromExn } = await import('src/lib/keri/multisigRound');
      const exchResp = await client.exchanges().get(notification.a.d);
      const exn = exchResp?.exn ?? {};

      const aids = await client.identifiers().list();
      const me = aids?.aids?.[0]?.prefix as string | undefined;
      if (!me) throw new Error('No personal AID');
      const round = classifyMultisigRot(exn, me);
      const adminPrefix = adminPrefixFromExn(exn);
      console.log(`[MultisigJoin] notification ${notification.a.d.slice(0, 12)} classified as ${round}, admin=${adminPrefix?.slice(0, 12)}`);

      try {
        if (round === 'round-1') {
          if (!adminPrefix) throw new Error('round-1 EXN missing admin prefix');
          const cesrUrl = keriClient.getCesrUrl();
          await keriClient.resolveOOBI(`${cesrUrl}/oobi/${adminPrefix}`, undefined, 30000);
          const personalName = aids.aids[0]?.name as string;
          await keriClient.rotatePersonalAid(personalName);
          await keriClient.markNotificationRead(notification.i);
          console.log('[MultisigJoin] round-1 done; waiting for round-2 EXN');
          return false; // keep watcher running
        }

        if (round === 'round-2') {
          if (!adminPrefix) throw new Error('round-2 EXN missing admin prefix');
          const cesrUrl = keriClient.getCesrUrl();
          await keriClient.resolveOOBI(`${cesrUrl}/oobi/${adminPrefix}`, undefined, 30000);
          const gid = await keriClient.joinGroup(orgName, notification.a.d);
          await secureStorage.setItem('matou_org_aid', gid);
          keriClient.setOrgAID(gid);
          await keriClient.markNotificationRead(notification.i);
          hasJoined.value = true;
          console.log(`[MultisigJoin] round-2 done, joined ${gid.slice(0, 12)}`);
          return true;
        }

        console.warn('[MultisigJoin] unknown round — leaving unread for diagnostic');
        return false;
      } catch (joinErr) {
        const msg = joinErr instanceof Error ? joinErr.message : String(joinErr);
        console.error('[MultisigJoin] handler failed:', joinErr);
        error.value = msg;
        return false;
      } finally {
        isJoining.value = false;
      }
    } catch (err) {
      console.warn('[MultisigJoin] check failed:', err);
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
