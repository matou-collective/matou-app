/**
 * Composable for the MEMBER side of the multisig member-to-admin upgrade.
 *
 * When admin pre-rotates their master AID, admin's backend writes a
 * MultisigRotationSignal to the community space.  Tree listener fans that
 * out as an `multisig:rotation-signal` SSE event.  This handler:
 *   1. Filters by targetMemberAid so only the intended steward responds.
 *   2. Calls keyStates().query(adminAid, adminSn) — verified empirically
 *      to push admin's KEL up to adminSn into the member's local kevers
 *      (see test-query-pushes-kel.ts).
 *   3. POSTs to /api/v1/multisig/rotation-ack so admin can proceed.
 *
 * This recreates the POC's `memberQueryAdminAt` cross-client call
 * (test-multisig.ts:402) over any-sync SSE — see MULTISIG-POC-FINDINGS.md
 * item #4.
 */
import { watch, onUnmounted } from 'vue';
import { useKERIClient } from 'src/lib/keri/client';
import { useBackendEvents } from './useBackendEvents';
import { BACKEND_URL, authHeaders } from 'src/lib/api/client';
import { secureStorage } from 'src/lib/secureStorage';
import { resolveOrgRegistryId } from 'src/lib/keri/registry';
import { pushHistoryWhenSigner } from 'src/lib/keri/steward/promotionHistory';

interface RotationSignalEvent {
  signalId: string;
  adminAid: string;
  adminSn: string;
  targetMemberAid: string;
  round: 'round-1' | 'round-2';
  groupAid: string;
  // 'rotate' additionally asks us to rotate our own personal AID before
  // acking. The admin sends it to the group's EXISTING co-signers: KERI only
  // lets a rotation install keys the previous group event pre-committed, so a
  // co-signer that does not install its next key each round cannot stay in the
  // rotated group at all. Absent/'query' keeps the original behaviour (the
  // joining member's own rotation is driven by the round-1 EXN instead).
  action?: 'query' | 'rotate';
}

const ROTATION_SIGNAL_TIMEOUT_MS = 30_000;

export function useMultisigRotationSignal() {
  const keriClient = useKERIClient();
  const events = useBackendEvents();

  // Idempotency: don't re-handle the same signal across re-renders or
  // event bus replays.  Keyed by signalId (which is the any-sync object ID
  // and uniquely identifies the signal write).
  const processed = new Set<string>();

  let stopWatcher: (() => void) | null = null;

  function start(myAid: string): void {
    if (stopWatcher) return;
    console.log(`[RotationSignal] Watching for signals targeted at ${myAid.slice(0, 12)}...`);

    stopWatcher = watch(
      () => events.lastEvent.value,
      async (evt) => {
        if (!evt || evt.type !== 'multisig:rotation-signal') return;
        const data = evt.data as unknown as RotationSignalEvent;

        if (data.targetMemberAid !== myAid) return;
        if (processed.has(data.signalId)) return;
        processed.add(data.signalId);

        await handleSignal(data, myAid);
      },
    );
  }

  async function handleSignal(sig: RotationSignalEvent, myAid: string): Promise<void> {
    console.log(
      `[RotationSignal] admin=${sig.adminAid.slice(0, 12)} rotated to sn=${sig.adminSn} (${sig.round}) — querying`,
    );
    const client = keriClient.getSignifyClient();
    if (!client) {
      console.warn('[RotationSignal] no signify client — cannot query');
      return;
    }

    try {
      const op = await client.keyStates().query(sig.adminAid, sig.adminSn, undefined);
      await client.operations().wait(op, {
        signal: AbortSignal.timeout(ROTATION_SIGNAL_TIMEOUT_MS),
      });
      console.log(
        `[RotationSignal] queried admin@sn=${sig.adminSn} — KEL now in local kevers, posting ack`,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[RotationSignal] keyStates().query failed: ${msg}`);
      // Fall through and ack anyway — failing to ack stalls admin's flow,
      // and the EXN can still recover via the existing escrow → pending
      // notification path.
    }

    if (sig.action === 'rotate') {
      try {
        const aids = await client.identifiers().list();
        const mine = aids?.aids?.find((a: { prefix: string }) => a.prefix === myAid) ?? aids?.aids?.[0];
        const name = mine?.name as string | undefined;
        if (!name) throw new Error('no local alias for this AID');
        // Apply every peer steward's act and catch up on the group's witnessed
        // KEL BEFORE rotating: once our key moves on, an unapplied act signed
        // under the old key state can no longer be replayed here.
        // drain() never rejects — it parks failures in `pending`.
        const { useOrgActInbox } = await import('src/composables/useOrgActInbox');
        const inbox = useOrgActInbox();
        await inbox.drain();
        if (inbox.pending.value > 0) {
          throw new Error(`changes from other stewards not applied yet — try again (${inbox.lastError.value ?? `${inbox.pending.value} pending`})`);
        }
        const group = sig.groupAid || await secureStorage.getItem('matou_org_aid');
        if (group) await keriClient.syncGroupFromWitnesses(group);
        const newSn = await keriClient.rotatePersonalAid(name);
        console.log(`[RotationSignal] rotated own AID for ${sig.round} -> sn=${newSn}`);
      } catch (err) {
        // Do NOT ack: the admin waits for our KEL to advance and fails the
        // promotion with a message naming us, which is far better than acking
        // and having the admin build a rotation that drops us from the group.
        console.error('[RotationSignal] own rotation failed — not acking:', err);
        return;
      }
    }

    try {
      const resp = await fetch(`${BACKEND_URL}/api/v1/multisig/rotation-ack`, {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({
          signalId: sig.signalId,
          adminAid: sig.adminAid,
          adminSn: sig.adminSn,
          ackBy: myAid,
        }),
      });
      if (!resp.ok) {
        console.warn(`[RotationSignal] ack POST returned ${resp.status}`);
      } else {
        console.log(`[RotationSignal] acked admin@sn=${sig.adminSn}`);
      }
    } catch (err) {
      console.warn('[RotationSignal] ack POST failed:', err);
    }

    // Spec §3.5: a co-signer that holds the org's history pushes it to the
    // new steward right after the promotion — i.e. once the round-2 group
    // rotation our ack unblocks lands in our agent. Background, best-effort.
    if (sig.action === 'rotate' && sig.round === 'round-2') {
      const group = sig.groupAid || await secureStorage.getItem('matou_org_aid');
      if (group) {
        void pushHistoryWhenSigner(group, {
          sync: (g) => keriClient.syncGroupFromWitnesses(g),
          keyState: (g) => keriClient.groupKeyState(g),
          resolveRegistry: () => resolveOrgRegistryId(),
          pushHistory: (g, r) => keriClient.pushOrgHistory(g, r),
          sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
        });
      }
    }
  }

  function stop(): void {
    if (stopWatcher) {
      stopWatcher();
      stopWatcher = null;
    }
    processed.clear();
    console.log('[RotationSignal] Stopped');
  }

  onUnmounted(stop);

  return { start, stop };
}
