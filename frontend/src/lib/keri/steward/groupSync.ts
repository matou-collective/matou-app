import { parseCesrStream, filterKelMessages, mergeKelMessages, type CesrMessage } from 'src/lib/keri/cesr';
import { GroupBehind, GroupDiverged } from './errors';

export interface GroupSyncDeps {
  /** Browser-reachable witness base URLs (client config `witnesses.urls`). */
  witnessUrls(): Promise<string[]>;
  /** GET a URL's body, or null on any non-2xx / network failure. */
  fetchText(url: string): Promise<string | null>;
  /** POST one event to OUR agent's CESR door with CESR-DESTINATION = memberAid. */
  pushEvent(msg: CesrMessage, destination: string): Promise<boolean>;
  /** Our agent's current sn for the group, as a number. */
  localGroupSn(group: string): Promise<number>;
}

/**
 * Bring this steward's agent to the group sn the witnesses hold, or refuse.
 * The ONLY fork guard: a steward that anchors from a stale view writes a
 * second event at an sn the witnesses already hold — silently (spike 2b).
 * Pull goes witness → browser → our CESR door because re-resolving an
 * already-known OOBI through the agent does not move sn.
 */
export async function syncGroup(group: string, memberAid: string, deps: GroupSyncDeps): Promise<{ sn: number }> {
  const bases = await deps.witnessUrls();
  if (bases.length === 0) throw new GroupBehind('no witness URLs configured');
  const streams = await Promise.all(bases.map((b) => deps.fetchText(`${b.replace(/\/+$/, '')}/oobi/${group}`)));
  let msgs: CesrMessage[] = [];
  for (const s of streams) if (s) msgs = mergeKelMessages(msgs, filterKelMessages(parseCesrStream(s)));
  const own = msgs.filter((m) => m.event.i === group).sort((a, b) => parseInt(a.event.s, 16) - parseInt(b.event.s, 16));
  if (own.length === 0) throw new GroupBehind('witnesses unreachable or none serves the group');
  const target = parseInt(own[own.length - 1]!.event.s, 16);

  const before = await deps.localGroupSn(group);
  if (before > target) throw new GroupDiverged(`agent sn=${before}, witnesses sn=${target}`);
  for (const m of own) {
    if (parseInt(m.event.s, 16) > before) await deps.pushEvent(m, memberAid);
  }
  const after = await deps.localGroupSn(group);
  if (after > target) throw new GroupDiverged(`agent sn=${after}, witnesses sn=${target}`);
  if (after < target) throw new GroupBehind(`agent sn=${after} after push, witnesses sn=${target}`);
  return { sn: after };
}
