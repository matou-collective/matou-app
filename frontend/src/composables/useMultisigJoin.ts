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
import { toKeriAlias } from 'src/lib/keri/alias';
import { isAlreadyGroupSigner, hasLocalGroupIdentifier } from 'src/lib/keri/notifications';

const MULTISIG_ROT_ROUTE = '/multisig/rot';
// When admin pre-rotates between rounds and immediately sends a /multisig/rot,
// the receiver's KERIA doesn't yet have admin's new key state and rejects the
// EXN as "sender not in kevers". The keria-patches `exchanger_patch.py` adds
// /multisig/rot to its pending-notify list so the partial-signed escrow creates
// a notification we can react to here — by resolving admin's OOBI to push the
// new KEL into kevers. KERIA's escrow processor then retries the EXN and the
// normal /multisig/rot notification fires.
const MULTISIG_ROT_PENDING_ROUTE = '/exn/multisig/rot/pending';

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
      const orgName = toKeriAlias(config.organization.name || 'matou', {
        lowercase: true,
        fallback: 'org',
      });

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

          // Already a member of this group? Then this is a subsequent group
          // rotation we must CO-SIGN, not a join: KERIA's /multisig/join 400s
          // for an existing alias ("already used alias or prefix"), which
          // used to leave the notification unread and retried every cycle.
          const gidFromExn = (exn as { a?: { gid?: string } }).a?.gid;
          let existingGroup: { prefix?: string } | null = null;
          try {
            existingGroup = await client.identifiers().get(orgName) as { prefix?: string };
          } catch {
            existingGroup = null;
          }
          if (existingGroup?.prefix && existingGroup.prefix === gidFromExn) {
            console.log(`[MultisigJoin] already a member of ${gidFromExn.slice(0, 12)} — co-signing the proposed rotation`);
            try {
              await keriClient.coSignGroupRotation(orgName, notification.a.d);
              console.log('[MultisigJoin] co-signed group rotation');
            } catch (coSignErr) {
              // A proposal we can no longer reproduce is permanently
              // un-cosignable: some participant's key state has moved on (e.g.
              // the incoming member rotated between the admin building round 1
              // and us reading it). Leaving it unread would block every later
              // round, because we always take the oldest unread notification —
              // and the rotation does not need us anyway at isith=1.
              const msg = coSignErr instanceof Error ? coSignErr.message : String(coSignErr);
              if (!msg.includes('no longer match the proposed rotation')) throw coSignErr;
              console.warn(`[MultisigJoin] dropping un-cosignable rotation proposal: ${msg}`);
            }
            await keriClient.markNotificationRead(notification.i);
            return false; // keep watcher running
          }

          // Idempotency (issue #470): two signify clients on one agent both see
          // this round-2 /multisig/rot. If the group already commits our current
          // signing key we have already joined (agent-global identifiers, but
          // another client may have joined in this very window) — a second join
          // would duplicate our signature. Best-effort: a failed key-state read
          // falls through to the join (single-client behaviour unchanged).
          if (gidFromExn) {
            try {
              const readKeys = async (pre: string): Promise<string[]> => {
                const st = await client.keyStates().get(pre);
                const one = (Array.isArray(st) ? st[0] : st) as { k?: string[] } | undefined;
                return one?.k ?? [];
              };
              const [groupKeys, myKeys, localAids] = await Promise.all([
                readKeys(gidFromExn).catch(() => [] as string[]),
                readKeys(me).catch(() => [] as string[]),
                client.identifiers().list()
                  .then((r: { aids?: Array<{ prefix?: string }> }) => r?.aids ?? [])
                  .catch(() => [] as Array<{ prefix?: string }>),
              ]);
              // Both conditions, deliberately: the group committing our key is
              // true for the joining member as soon as round 2's rotation
              // lands, so on its own it would skip the join we are here to do.
              if (
                isAlreadyGroupSigner(groupKeys, myKeys) &&
                hasLocalGroupIdentifier(localAids, gidFromExn)
              ) {
                console.debug(`[MultisigJoin] already a signer of ${gidFromExn.slice(0, 12)} — skipping join (idempotent)`);
                await secureStorage.setItem('matou_org_aid', gidFromExn);
                keriClient.setOrgAID(gidFromExn);
                await keriClient.markNotificationRead(notification.i);
                hasJoined.value = true;
                return true;
              }
            } catch (idemErr) {
              console.warn('[MultisigJoin] round-2 signer idempotency check failed; proceeding to join', idemErr);
            }
          }

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

  /**
   * Resolve the sender's OOBI for any pending /multisig/rot notifications.
   * This pushes the sender's latest KEL into KERIA's kevers, allowing KERIA's
   * escrow processor to retry the EXN and convert it into a normal
   * /multisig/rot notification on the next cycle.
   */
  async function resolvePendingMultisigSenders(): Promise<void> {
    const client = keriClient.getSignifyClient();
    if (!client) return;

    const allNotifications = notificationService.notifications.value;
    const pending = allNotifications.filter(
      n => n.a?.r === MULTISIG_ROT_PENDING_ROUTE && !n.r,
    );
    if (pending.length === 0) return;
    console.log(`[MultisigJoin] Resolving ${pending.length} pending /multisig/rot sender(s)`);

    const cesrUrl = keriClient.getCesrUrl();
    for (const notification of pending) {
      const senderAid = notification.a?.i as string | undefined;
      if (!senderAid) continue;
      try {
        await keriClient.resolveOOBI(`${cesrUrl}/oobi/${senderAid}`, undefined, 30000);
        console.log(`[MultisigJoin] Resolved sender ${senderAid.slice(0, 12)} for pending /multisig/rot`);
        await keriClient.markNotificationRead(notification.i);
      } catch (err) {
        console.warn(`[MultisigJoin] Failed to resolve pending sender ${senderAid.slice(0, 12)}:`, err);
      }
    }
  }

  function startPolling(interval?: number): void {
    if (stopWatcher) return;

    console.log('[MultisigJoin] Starting watch for /multisig/rot...');

    // Check immediately
    (async () => {
      await resolvePendingMultisigSenders();
      const joined = await checkAndJoinMultisig();
      if (joined) stopPolling();
    })();

    // React to service fetches
    stopWatcher = watch(
      () => notificationService.lastFetchTime.value,
      async () => {
        await resolvePendingMultisigSenders();
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
