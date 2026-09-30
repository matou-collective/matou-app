import { mergeSigs } from './sigs';
import { ReplayFailed } from './errors';

export interface Anchor { raw: string; sad: Record<string, unknown>; sigs: string[] }
export interface ReplayInput {
  kind: 'iss' | 'rev';
  registry: string;
  acdc: Record<string, unknown>;
  event: Record<string, unknown>;
  anc: Anchor;
  issForRev?: { event: Record<string, unknown>; anc: Anchor };
}
export interface ReplayDeps {
  credentialState(registry: string, said: string): Promise<'iss' | 'rev' | null>;
  ownSigs(raw: string): Promise<string[]>;
  postIss(body: Record<string, unknown>): Promise<number>;
  deleteRev(said: string, body: Record<string, unknown>): Promise<number>;
  sync(): Promise<void>;
  keyState(): Promise<{ k: string[]; latestEstSn: number; memberKey: string }>;
}

/**
 * Whether our signature over an ixn is valid (only after the group's latest
 * establishment event — our key is the current one), and whether we must skip:
 * keys[0] is the group's elected witnesser and parks a replay without its own
 * signature in an escrow it never leaves (spike round 1, route C).
 */
export function cosignPolicy(ancSn: number, ks: { k: string[]; latestEstSn: number; memberKey: string }) {
  const sign = ancSn > ks.latestEstSn;
  const isKeys0 = ks.k[0] === ks.memberKey;
  return { sign, skip: !sign && isKeys0 };
}

async function withRetry(call: () => Promise<number>, deps: ReplayDeps, what: string): Promise<void> {
  let status = await call();
  if (status >= 500) {
    await deps.sync();
    status = await call();
  }
  if (status < 200 || status >= 300) throw new ReplayFailed(`${what} → HTTP ${status}`);
}

function ancSn(anc: Anchor): number {
  const s = String(anc.sad.s);
  if (!/^[0-9a-fA-F]+$/.test(s)) throw new ReplayFailed(`anchor sequence number "${s}" is not hex`);
  return parseInt(s, 16);
}

async function signed(anc: Anchor, deps: ReplayDeps): Promise<string[] | null> {
  const policy = cosignPolicy(ancSn(anc), await deps.keyState());
  if (policy.skip) return null;
  return policy.sign ? mergeSigs(anc.sigs, await deps.ownSigs(anc.raw)) : anc.sigs;
}

/**
 * Re-create another steward's TEL event in OUR agent. A shared registry is
 * local to every agent that holds it, and keripy refuses inbound TEL events
 * for a local registry — so each steward's agent must apply each iss/rev
 * itself (spike rounds 1–2). Idempotent on the credential's TEL state.
 */
export async function replayAct(input: ReplayInput, deps: ReplayDeps): Promise<'applied' | 'already' | 'skipped'> {
  const said = String(input.acdc.d);
  const state = await deps.credentialState(input.registry, said);
  if (state === input.kind) return 'already';

  if (input.kind === 'rev' && state === null) {
    if (!input.issForRev) throw new ReplayFailed(`rev for ${said} but its issuance is unknown here`);
    const r = await replayAct({ kind: 'iss', registry: input.registry, acdc: input.acdc, event: input.issForRev.event, anc: input.issForRev.anc }, deps);
    if (r === 'skipped') return 'skipped';
  }

  const sigs = await signed(input.anc, deps);
  if (!sigs) return 'skipped';
  if (input.kind === 'iss') {
    await withRetry(() => deps.postIss({ acdc: input.acdc, iss: input.event, ixn: input.anc.sad, sigs }), deps, `iss ${said}`);
  } else {
    await withRetry(() => deps.deleteRev(said, { rev: input.event, ixn: input.anc.sad, sigs }), deps, `rev ${said}`);
  }
  return 'applied';
}
