import { parseCesrStream } from 'src/lib/keri/cesr';
import { indexedSigs } from './sigs';
import { RegistryNotAdopted } from './errors';

export interface AdoptionDeps {
  listRegistries(group: string): Promise<string[]>;
  heldCredentialSaids(regk: string): Promise<string[]>;
  exportCredential(said: string): Promise<string>;
  createFromEvents(vcp: Record<string, unknown>, anc: Record<string, unknown>, sigs: string[], name: string): Promise<void>;
  sleep(ms: number): Promise<void>;
}

/**
 * Give this agent a `Registry` for the org's EXISTING registry, so KERIA's
 * `Registrar.issue` (`rgy.regs[regk]`) stops raising KeyError → 500. Replays
 * the registry's original `vcp` and the group ixn that anchored it — both
 * taken from a credential this steward already holds — through
 * `createFromEvents`. keripy treats the ixn as a duplicate and swallows the
 * vcp's LikelyDuplicitous, so nothing new is anchored (spike 1).
 */
export async function ensureOrgRegistry(
  group: string,
  regk: string,
  deps: AdoptionDeps,
  opts: { timeoutMs?: number; pollMs?: number } = {},
): Promise<'present' | 'adopted'> {
  if ((await deps.listRegistries(group)).includes(regk)) return 'present';

  const held = await deps.heldCredentialSaids(regk);
  if (held.length === 0) throw new RegistryNotAdopted(`agent holds no credential from ${regk} to adopt from`);
  const ms = parseCesrStream(await deps.exportCredential(held[0]!));
  const vcp = ms.find((m) => m.event.t === 'vcp' && m.event.i === regk);
  const anc = ms.find((m) => m.event.t === 'ixn' && m.event.i === group && Array.isArray(m.event.a) &&
    (m.event.a as Array<{ i?: string; s?: string }>).some((x) => x.i === regk && x.s === '0'));
  if (!vcp || !anc) throw new RegistryNotAdopted(`export of ${held[0]} lacks the registry inception or its anchor`);

  let sigs: string[];
  try {
    sigs = indexedSigs(anc.attachment);
  } catch (e) {
    throw new RegistryNotAdopted(`anchoring ixn of ${regk} has no usable signatures: ${(e as Error).message}`);
  }
  await deps.createFromEvents(vcp.event, anc.event, sigs, `org-${regk.slice(0, 12)}`);

  const deadline = Date.now() + (opts.timeoutMs ?? 15_000);
  do {
    if ((await deps.listRegistries(group)).includes(regk)) return 'adopted';
    await deps.sleep(opts.pollMs ?? 1000);
  } while (Date.now() < deadline);
  throw new RegistryNotAdopted(`${regk} not listed after adoption`);
}
