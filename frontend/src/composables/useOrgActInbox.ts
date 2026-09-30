import { ref, watch } from 'vue';
import { useKERIClient } from 'src/lib/keri/client';
import { useKERINotificationService } from 'src/composables/useKERINotificationService';
import { resolveOrgGroupPrefix } from 'src/composables/useAdminActions';
import { fetchOrgConfig } from 'src/api/config';
import { ORG_ACT_ROUTES, parseActExn } from 'src/lib/keri/steward/replicate';
import type { ReplayInput } from 'src/lib/keri/steward/replay';
import { NotJoined, NotSignerYet, userFacingMessage } from 'src/lib/keri/steward/errors';
import { resolveOrgRegistryId } from 'src/lib/keri/registry';
import { secureStorage } from 'src/lib/secureStorage';

type Note = { i: string; r: boolean; a?: { r?: string; d?: string; dt?: string } };
export interface InboxDeps {
  org: { group: string; registry: string };
  getRequest(said: string): Promise<Array<{ exn: Record<string, unknown>; paths: Record<string, string> }>>;
  replay(input: ReplayInput): Promise<'applied' | 'already' | 'skipped'>;
  mark(noteId: string): Promise<void>;
  /** Remember a credential whose replay this wallet had to skip (keys[0], anchor older than our last rotation). */
  recordSkipped?(credSaid: string): Promise<void>;
}

type KV = { getItem(k: string): Promise<string | null>; setItem(k: string, v: string): Promise<void> };
const SKIPPED_MAX = 100;
const skippedKey = (group: string) => `matou_org_acts_skipped:${group}`;

/** Credential SAIDs whose replay this wallet skipped, oldest first; corrupt → empty. */
export async function readSkippedActs(group: string, store: KV = secureStorage): Promise<string[]> {
  try {
    const parsed: unknown = JSON.parse((await store.getItem(skippedKey(group))) || '[]');
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

/** Record a skipped credential SAID (de-duplicated, keeps the newest SKIPPED_MAX). */
export async function recordSkippedAct(group: string, credSaid: string, store: KV = secureStorage): Promise<void> {
  const list = (await readSkippedActs(group, store)).filter((s) => s !== credSaid);
  list.push(credSaid);
  await store.setItem(skippedKey(group), JSON.stringify(list.slice(-SKIPPED_MAX)));
}

export function skippedActsMessage(count: number): string | null {
  return count > 0 ? `${count} change(s) from other stewards could not be applied by this wallet` : null;
}

const isOrgAct = (n: Note) => ORG_ACT_ROUTES.includes(n.a?.r as never);

/** Unread /multisig/iss|rev notes, oldest-first. Feed it a FRESH agent list — the poll cache can be ~15 s stale. */
export function selectOrgActNotes(notes: readonly Note[]): Note[] {
  return notes
    .filter((n) => !n.r && isOrgAct(n))
    .sort((a, b) => (a.a?.dt ?? '').localeCompare(b.a?.dt ?? ''));
}

const alreadyMarked = (err: unknown) => /no notification to mark as read/i.test(err instanceof Error ? err.message : String(err));

/**
 * Apply unread /multisig/iss|rev notes oldest-first; act-then-mark. KERIA
 * never re-notifies an identical exn, so a note is marked read ONLY after its
 * replay returned — a failed replay stays unread for the next pass.
 */
export async function processOrgActNotes(notes: Note[], deps: InboxDeps): Promise<{ applied: number; failed: number; waiting: number; skipped: number }> {
  let applied = 0;
  let failed = 0;
  let waiting = 0;
  let skipped = 0;
  for (const n of notes) {
    if (n.r || !isOrgAct(n) || !n.a?.d) continue;
    try {
      const [req] = await deps.getRequest(n.a.d);
      const input = req ? parseActExn(req.exn as never, req.paths ?? {}, deps.org) : null;
      if (!input) {
        await deps.mark(n.i);
        continue;
      }
      const out = await deps.replay(input);
      if (out === 'skipped') {
        // keys[0] cannot sign an anchor older than its last rotation and an
        // unsigned replay would wedge its escrow: report it (spec §9), mark read.
        skipped++;
        const said = String(input.acdc.d);
        console.warn(`[OrgActInbox] skipped ${input.kind} for ${said.slice(0, 12)}... (predates our last rotation)`);
        try {
          await deps.recordSkipped?.(said);
        } catch (recErr) {
          console.warn('[OrgActInbox] could not record skipped act:', recErr);
        }
      } else {
        applied++;
      }
      // The act is applied; a mark failure is not a replay failure. A 404
      // "no notification to mark as read" means an earlier pass marked it;
      // anything else: the next pass replays -> 'already' and marks again.
      try {
        await deps.mark(n.i);
      } catch (markErr) {
        if (alreadyMarked(markErr)) console.debug(`[OrgActInbox] note ${n.i} already marked read`);
        else console.warn(`[OrgActInbox] applied but could not mark note ${n.i} read:`, markErr);
      }
    } catch (err) {
      if (err instanceof NotSignerYet) {
        // Expected mid-promotion (our key rotated ahead of the group): retry
        // on a later pass, quietly — still pending, never posted.
        waiting++;
        console.debug(`[OrgActInbox] waiting for the group rotation, left unread: ${err.message}`);
        continue;
      }
      failed++;
      console.warn('[OrgActInbox] replay failed, left unread:', err);
    }
  }
  return { applied, failed, waiting, skipped };
}

/** The org group this wallet holds (R4: config first, then stored); null = not a steward yet. */
export async function resolveHeldOrgGroup(client: Parameters<typeof resolveOrgGroupPrefix>[0]): Promise<string> {
  let config = null;
  try {
    const r = await fetchOrgConfig();
    config = r.status === 'configured' ? r.config : r.status === 'server_unreachable' ? r.cached : null;
  } catch { /* fall through to stored */ }
  return resolveOrgGroupPrefix(client, config, await secureStorage.getItem('matou_org_aid'));
}

export function useOrgActInbox() {
  const keriClient = useKERIClient();
  const notes = useKERINotificationService();
  const pending = ref(0);
  const lastError = ref<string | null>(null);
  let running: Promise<void> | null = null;
  let stopWatch: (() => void) | null = null;

  async function drainOnce(): Promise<void> {
    const client = keriClient.getSignifyClient();
    if (!client) return;
    // Fresh from the agent, not the poll cache: a cached note an earlier pass
    // already marked read would otherwise be re-processed (R13).
    const fresh = (await client.notifications().list(0, 1000)) as { notes?: Note[] };
    const list = selectOrgActNotes(fresh.notes ?? []);
    pending.value = list.length;
    if (list.length === 0) return;
    let group: string;
    try {
      group = await resolveHeldOrgGroup(client);
    } catch (err) {
      if (err instanceof NotJoined) return; // not a steward yet — leave the notes for after the join
      throw err;
    }
    const org = { group, registry: await resolveOrgRegistryId() };
    await keriClient.syncGroupFromWitnesses(group);
    const res = await processOrgActNotes(list, {
      org,
      getRequest: async (said) => (await client.groups().getRequest(said)) as never,
      replay: (input) => keriClient.replayOrgAct(input, group),
      mark: async (id) => { await keriClient.markNotificationRead(id); },
      recordSkipped: (said) => recordSkippedAct(group, said),
    });
    pending.value = res.failed + res.waiting;
    lastError.value = res.failed
      ? `${res.failed} change(s) from other stewards not applied yet`
      : res.waiting ? new NotSignerYet('').userMessage
        : skippedActsMessage((await readSkippedActs(group)).length);
  }

  /** Single-flight: concurrent callers share one pass. Never rejects. */
  function drain(): Promise<void> {
    running ??= drainOnce()
      .catch((err) => {
        lastError.value = userFacingMessage(err);
        console.warn('[OrgActInbox] drain failed, will retry on next fetch:', err);
      })
      .finally(() => { running = null; });
    return running;
  }

  function start(): void {
    if (stopWatch) return;
    void drain();
    stopWatch = watch(() => notes.lastFetchTime.value, () => { void drain(); });
  }
  function stop(): void {
    stopWatch?.();
    stopWatch = null;
  }

  return { pending, lastError, drain, start, stop };
}
