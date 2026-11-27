import { ownSigningIndex } from './replay';

export interface PromotionHistoryDeps {
  /** syncGroupFromWitnesses — brings our agent to the witnessed group KEL. */
  sync(group: string): Promise<unknown>;
  keyState(group: string): Promise<{ k: string[]; latestEstSn: number; memberKey: string }>;
  resolveRegistry(): Promise<string>;
  /** pushOrgHistory — sends each other signer the acts it has not been sent. */
  pushHistory(group: string, registry: string): Promise<unknown>;
  sleep(ms: number): Promise<void>;
}

/**
 * Push the org's credential history to every other signer right after a
 * promotion (spec §3.5), once the group rotation that made the new steward a
 * signer is in our agent: until then our (just-rotated) member key is not in
 * the group's keys and the new steward is not yet a peer to send to.
 * Best-effort and bounded; never rejects. True when the push ran.
 */
export async function pushHistoryWhenSigner(
  group: string,
  deps: PromotionHistoryDeps,
  opts: { attempts?: number; intervalMs?: number } = {},
): Promise<boolean> {
  const attempts = opts.attempts ?? 36;
  const intervalMs = opts.intervalMs ?? 5_000;
  try {
    for (let i = 0; i < attempts; i++) {
      if (i > 0) await deps.sleep(intervalMs);
      try {
        await deps.sync(group);
      } catch (err) {
        console.debug('[PromotionHistory] group sync not ready yet:', err instanceof Error ? err.message : err);
        continue;
      }
      if (ownSigningIndex(await deps.keyState(group)) < 0) continue;
      await deps.pushHistory(group, await deps.resolveRegistry());
      return true;
    }
    console.warn(`[PromotionHistory] group ${group.slice(0, 12)}... rotation not seen after ${attempts} checks; history push left to the next sign-in`);
    return false;
  } catch (err) {
    console.warn('[PromotionHistory] history push after promotion failed (next sign-in retries):', err);
    return false;
  }
}
