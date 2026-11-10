import { parseCesrStream, filterKelMessages, mergeKelMessages, type CesrMessage } from 'src/lib/keri/cesr';
import { GroupBehind, GroupDiverged } from './errors';

/** Strict hex sn parse: NaN-free or null. */
function parseSn(s: unknown): number | null {
  if (typeof s !== 'string' || !/^[0-9a-f]+$/i.test(s)) return null;
  const n = parseInt(s, 16);
  return Number.isFinite(n) ? n : null;
}

export interface GroupSyncDeps {
  /** Browser-reachable witness base URLs (client config `witnesses.urls`). */
  witnessUrls(): Promise<string[]>;
  /** GET a URL's body, or null on any non-2xx / network failure. */
  fetchText(url: string): Promise<string | null>;
  /** POST one event to OUR agent's CESR door with CESR-DESTINATION = memberAid. */
  pushEvent(msg: CesrMessage, destination: string): Promise<boolean>;
  /** Our agent's current sn for the group, as a number. */
  localGroupSn(group: string): Promise<number>;
  /** SAID of the event our agent holds for the group at sn, or null if it cannot be read. */
  localEventSaid(group: string, sn: number): Promise<string | null>;
}

/**
 * A fork at the SAME sn is invisible to sn arithmetic: compare the agent's
 * event SAID with what the witnesses serve there (any witness, since the
 * merged stream is de-duplicated by SAID).
 */
async function assertSameEvent(group: string, sn: number, own: Array<{ m: CesrMessage; sn: number }>, deps: GroupSyncDeps): Promise<void> {
  const witnessSaids = own.filter((x) => x.sn === sn).map((x) => String(x.m.event.d));
  if (witnessSaids.length === 0) return; // witnesses don't serve this sn — nothing to compare
  const mine = await deps.localEventSaid(group, sn);
  if (mine === null) throw new GroupBehind(`cannot read the agent's group event at sn=${sn}`);
  if (!witnessSaids.includes(mine)) {
    throw new GroupDiverged(`agent event at sn=${sn} is ${mine.slice(0, 12)}, witnesses hold ${witnessSaids.map((d) => d.slice(0, 12)).join(', ')}`);
  }
}

/**
 * Bring this steward's agent to the group sn the witnesses hold, or refuse.
 * The ONLY fork guard: a steward that anchors from a stale view writes a
 * second event at an sn the witnesses already hold — silently (spike 2b).
 * Beyond sn, the agent's event SAID at its pre-push sn and at the final sn
 * must match the witnesses' — a same-sn fork is GroupDiverged.
 * Pull goes witness → browser → our CESR door because re-resolving an
 * already-known OOBI through the agent does not move sn.
 */
export async function syncGroup(group: string, memberAid: string, deps: GroupSyncDeps): Promise<{ sn: number }> {
  const bases = await deps.witnessUrls();
  if (bases.length === 0) throw new GroupBehind('no witness URLs configured');
  const streams = await Promise.all(bases.map((b) => deps.fetchText(`${b.replace(/\/+$/, '')}/oobi/${group}`)));
  let msgs: CesrMessage[] = [];
  for (const s of streams) if (s) msgs = mergeKelMessages(msgs, filterKelMessages(parseCesrStream(s)));
  const own = msgs
    .filter((m) => m.event.i === group)
    .map((m) => ({ m, sn: parseSn(m.event.s) }))
    .filter((x): x is { m: CesrMessage; sn: number } => x.sn !== null)
    .sort((a, b) => a.sn - b.sn);
  if (own.length === 0) throw new GroupBehind('witnesses unreachable or none serves valid group events');
  const target = own[own.length - 1]!.sn;
  if (!Number.isFinite(target)) throw new GroupBehind('non-finite witness sn');

  const before = await deps.localGroupSn(group);
  if (!Number.isFinite(before)) throw new GroupBehind(`agent sn is not a finite number (${before})`);
  if (before > target) throw new GroupDiverged(`agent sn=${before}, witnesses sn=${target}`);
  if (before >= 0 && before < target) await assertSameEvent(group, before, own, deps);
  for (const { m, sn } of own) {
    if (sn > before) await deps.pushEvent(m, memberAid);
  }
  const after = await deps.localGroupSn(group);
  if (!Number.isFinite(after)) throw new GroupBehind(`agent sn is not a finite number after push (${after})`);
  if (after > target) throw new GroupDiverged(`agent sn=${after}, witnesses sn=${target}`);
  if (after < target) throw new GroupBehind(`agent sn=${after} after push, witnesses sn=${target}`);
  await assertSameEvent(group, after, own, deps);
  return { sn: after };
}
