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

interface RotationSignalEvent {
  signalId: string;
  adminAid: string;
  adminSn: string;
  targetMemberAid: string;
  round: 'round-1' | 'round-2';
  groupAid: string;
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
