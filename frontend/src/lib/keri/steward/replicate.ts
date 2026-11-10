import type { TelBundle } from './sigs';
import { indexedSigs } from './sigs';
import type { ReplayInput } from './replay';

export const ORG_ACT_ROUTES = ['/multisig/iss', '/multisig/rev'] as const;

type Part = { sad: Record<string, unknown>; atc: string };

/** Embeds for keripy's native group-issuance exns (spec §3.3). */
export function actEmbedParts(b: TelBundle, kind: 'iss' | 'rev'): Record<string, Part> {
  if (!b.iss || !b.issAnc) throw new Error(`credential ${b.acdc.event.d} export lacks its issuance`);
  const base: Record<string, Part> = { acdc: { sad: b.acdc.event, atc: '' }, iss: { sad: b.iss.event, atc: '' } };
  if (kind === 'iss') return { ...base, anc: { sad: b.issAnc.event, atc: b.issAnc.attachment } };
  if (!b.rev || !b.revAnc) throw new Error(`credential ${b.acdc.event.d} export lacks its revocation`);
  return { ...base, issanc: { sad: b.issAnc.event, atc: b.issAnc.attachment }, rev: { sad: b.rev.event, atc: '' }, anc: { sad: b.revAnc.event, atc: b.revAnc.attachment } };
}

const anchor = (sad: Record<string, unknown>, atc: string | undefined) =>
  ({ raw: JSON.stringify(sad), sad, sigs: atc ? indexedSigs(atc) : [] });

/** A peer's /multisig/iss|rev as a replay for OUR org group + registry; null = not ours. */
export function parseActExn(
  exn: { r?: string; a?: { gid?: string }; e?: Record<string, unknown> },
  paths: Record<string, string>,
  org: { group: string; registry: string },
): ReplayInput | null {
  const e = (exn.e ?? {}) as Record<string, Record<string, unknown> | undefined>;
  const acdc = e.acdc;
  if (exn.a?.gid !== org.group || !acdc || acdc.ri !== org.registry) return null;
  const kind = exn.r?.endsWith('/rev') ? 'rev' : 'iss';
  if (kind === 'iss') {
    if (!e.iss || !e.anc) return null;
    return { kind, registry: org.registry, acdc, event: e.iss, anc: anchor(e.anc, paths.anc) };
  }
  if (!e.rev || !e.anc) return null;
  return {
    kind, registry: org.registry, acdc, event: e.rev, anc: anchor(e.anc, paths.anc),
    issForRev: e.iss && e.issanc ? { event: e.iss, anc: anchor(e.issanc, paths.issanc) } : undefined,
  };
}

export type SentLedger = Record<string, Record<string, 'iss' | 'rev'>>;

/** What each peer still needs from our held credentials (spec §3.5). */
export function planHistoryPush(
  held: Array<{ said: string; revoked: boolean }>,
  peers: string[],
  ledger: SentLedger,
): Array<{ peer: string; said: string; kind: 'iss' | 'rev' }> {
  const out: Array<{ peer: string; said: string; kind: 'iss' | 'rev' }> = [];
  for (const peer of peers) {
    for (const c of held) {
      const want = c.revoked ? 'rev' : 'iss';
      const sent = ledger[peer]?.[c.said];
      if (sent === want || sent === 'rev') continue;
      out.push({ peer, said: c.said, kind: want });
    }
  }
  return out;
}

/**
 * HTTP status of a signify-ts call: 200 when it resolves, the status parsed
 * from signify's `HTTP <method> <path> - <status> <statusText> - <body>` error
 * otherwise, 599 for anything else (network failure, unexpected error).
 */
export async function statusOf(p: Promise<unknown>): Promise<number> {
  try {
    await p;
    return 200;
  } catch (err) {
    const m = /^HTTP \S+ \S+ - (\d{3})\b/.exec(err instanceof Error ? err.message : String(err));
    return m ? Number(m[1]) : 599;
  }
}
