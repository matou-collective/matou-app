import { ref, computed, type ComputedRef, type Ref } from 'vue';
import { useKERIClient } from 'src/lib/keri/client';
import { getOrFetchOrgConfig } from 'src/api/config';

/**
 * Reactive state for the current org's witness configuration.
 *
 * Three states for `hasWitnesses`:
 *   undefined — not yet queried (banner hidden, no flash)
 *   false     — org has b: [] (banner shown to stewards)
 *   true      — org has witnesses (banner hidden)
 *
 * Call `refresh()` on dashboard mount and after running the migration to
 * re-evaluate.
 */
export function useOrgWitnessState(): {
  witnessCount: Ref<number | undefined>;
  hasWitnesses: ComputedRef<boolean | undefined>;
  refresh: () => Promise<void>;
} {
  const witnessCount = ref<number | undefined>(undefined);

  async function refresh(): Promise<void> {
    const config = await getOrFetchOrgConfig();
    if (!config?.organization?.aid) {
      witnessCount.value = undefined;
      return;
    }
    const keri = useKERIClient();
    const client = keri.getSignifyClient();
    if (!client) {
      witnessCount.value = undefined;
      return;
    }
    try {
      const op = await client.keyStates().query(config.organization.aid, undefined, undefined);
      const res = await client.operations().wait(op, { signal: AbortSignal.timeout(15_000) });
      const state = res.response as { b?: string[] } | undefined;
      witnessCount.value = state?.b?.length ?? 0;
      console.log(`[useOrgWitnessState] org ${config.organization.aid.slice(0, 12)}... has ${witnessCount.value} witnesses`);
    } catch (err) {
      console.warn('[useOrgWitnessState] keyStates().query failed:', err);
      witnessCount.value = undefined;
    }
  }

  const hasWitnesses = computed<boolean | undefined>(() => {
    if (witnessCount.value === undefined) return undefined;
    return witnessCount.value > 0;
  });

  return { witnessCount, hasWitnesses, refresh };
}
