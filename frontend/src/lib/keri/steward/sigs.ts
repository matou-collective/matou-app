import { parseCesrStream, type CesrMessage } from 'src/lib/keri/cesr';

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
const SIG_LEN = 88; // Ed25519 indexed signature, qb64

/**
 * The first controller indexed-signature group (`-A##`) of a CESR attachment,
 * optionally wrapped in an attachment group (`-V##`). Enough for the KEL events
 * KERIA exports and witnesses serve.
 */
export function indexedSigs(atc: string): string[] {
  let a = atc.replace(/[\r\n]+/g, '');
  if (a.startsWith('-V')) a = a.slice(4);
  if (!a.startsWith('-A')) throw new Error(`no indexed signature group at start of attachment "${a.slice(0, 8)}"`);
  const n = B64.indexOf(a[2]!) * 64 + B64.indexOf(a[3]!);
  const out: string[] = [];
  for (let i = 0; i < n; i++) out.push(a.substr(4 + i * SIG_LEN, SIG_LEN));
  return out;
}

/** Signing-key index of a single-char-index Ed25519 indexed signature. */
export function sigIndex(qb64: string): number {
  return B64.indexOf(qb64[1]!);
}

/** Union of two signature sets, one per key index (first seen wins), in index order. */
export function mergeSigs(a: string[], b: string[]): string[] {
  const byIdx = new Map<number, string>();
  for (const s of [...a, ...b]) if (!byIdx.has(sigIndex(s))) byIdx.set(sigIndex(s), s);
  return [...byIdx.entries()].sort((x, y) => x[0] - y[0]).map(([, s]) => s);
}

export interface TelBundle {
  acdc: CesrMessage;
  iss?: CesrMessage;
  rev?: CesrMessage;
  issAnc?: CesrMessage;
  revAnc?: CesrMessage;
}

/** Split a `credentials().get(said, true)` export into the parts a replay needs. */
export function telBundle(cesr: string, credSaid: string): TelBundle {
  const ms = parseCesrStream(cesr);
  const acdc = ms.find((m) => !m.event.t && m.event.d === credSaid);
  if (!acdc) throw new Error(`credential ${credSaid} not in export`);
  const anc = (sealSn: string) =>
    ms.find((m) => m.event.t === 'ixn' && Array.isArray(m.event.a) &&
      (m.event.a as Array<{ i?: string; s?: string }>).some((x) => x.i === credSaid && x.s === sealSn));
  return {
    acdc,
    iss: ms.find((m) => m.event.t === 'iss' && m.event.i === credSaid),
    rev: ms.find((m) => m.event.t === 'rev' && m.event.i === credSaid),
    issAnc: anc('0'),
    revAnc: anc('1'),
  };
}
