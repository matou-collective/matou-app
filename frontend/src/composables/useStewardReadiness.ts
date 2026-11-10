import { ref, watch, type Ref } from 'vue';
import { useKERIClient } from 'src/lib/keri/client';
import { useKERINotificationService } from 'src/composables/useKERINotificationService';
import { resolveHeldOrgGroup } from 'src/composables/useOrgActInbox';
import { resolveOrgRegistryId } from 'src/lib/keri/registry';
import { StewardRefusal } from 'src/lib/keri/steward/errors';

export interface ReadinessDeps {
  /** The held org group prefix; throws NotJoined when this wallet is not a signer yet. */
  resolveGroup(): Promise<string>;
  resolveRegistry(): Promise<string>;
  groupMemberAid(group: string): Promise<unknown>;
  syncGroup(group: string): Promise<unknown>;
  adoptRegistry(group: string, registry: string): Promise<unknown>;
  pushHistory(group: string, registry: string): Promise<unknown>;
}

export interface StewardReadiness {
  ready: Ref<boolean>;
  reason: Ref<string | null>;
  /** Single-flight full check. */
  ensureReady(): Promise<boolean>;
  /** Re-run the check only while not ready (cheap to call on every poll). */
  recheck(): Promise<boolean>;
}

/** joined + synced + registry adopted, then history pushed (spec §3.6). */
export function createStewardReadiness(deps: ReadinessDeps): StewardReadiness {
  const ready = ref(false);
  const reason = ref<string | null>('Checking your steward setup…');
  let running: Promise<boolean> | null = null;

  async function check(): Promise<boolean> {
    try {
      const group = await deps.resolveGroup();                 // NotJoined
      await deps.groupMemberAid(group);                        // NotJoined
      await deps.syncGroup(group);                             // GroupBehind / GroupDiverged
      const registry = await deps.resolveRegistry();
      await deps.adoptRegistry(group, registry);               // RegistryNotAdopted
      ready.value = true;
      reason.value = null;
      void deps.pushHistory(group, registry).catch((e) => console.warn('[StewardReadiness] history push failed:', e));
      return true;
    } catch (err) {
      ready.value = false;
      reason.value = err instanceof StewardRefusal
        ? err.userMessage
        : `Steward setup check failed: ${err instanceof Error ? err.message : String(err)}`;
      console.warn('[StewardReadiness]', err);
      return false;
    }
  }

  function ensureReady(): Promise<boolean> {
    running ??= check().finally(() => { running = null; });
    return running;
  }

  function recheck(): Promise<boolean> {
    return ready.value ? Promise.resolve(true) : ensureReady();
  }

  return { ready, reason, ensureReady, recheck };
}

export function useStewardReadiness() {
  const keriClient = useKERIClient();
  const notes = useKERINotificationService();
  const readiness = createStewardReadiness({
    resolveGroup: async () => {
      const client = keriClient.getSignifyClient();
      if (!client) throw new Error('Not connected to KERIA');
      return resolveHeldOrgGroup(client);
    },
    resolveRegistry: () => resolveOrgRegistryId(),
    groupMemberAid: (g) => keriClient.groupMemberAid(g),
    syncGroup: (g) => keriClient.syncGroupFromWitnesses(g),
    adoptRegistry: (g, r) => keriClient.ensureOrgRegistryAdopted(g, r),
    pushHistory: (g, r) => keriClient.pushOrgHistory(g, r),
  });
  let stopWatch: (() => void) | null = null;

  /** Check now, then re-check on every notification fetch while not ready (a transient GroupBehind must not leave Approve stuck disabled). */
  function start(): void {
    void readiness.ensureReady();
    if (stopWatch) return;
    stopWatch = watch(() => notes.lastFetchTime.value, () => { void readiness.recheck(); });
  }
  function stop(): void {
    stopWatch?.();
    stopWatch = null;
  }

  return { ...readiness, start, stop };
}
