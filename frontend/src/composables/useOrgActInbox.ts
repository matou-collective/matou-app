import { ref, watch } from 'vue';
import { useKERIClient } from 'src/lib/keri/client';
import { useKERINotificationService } from 'src/composables/useKERINotificationService';
import { resolveOrgGroupPrefix } from 'src/composables/useAdminActions';
import { fetchOrgConfig } from 'src/api/config';
import { ORG_ACT_ROUTES, parseActExn } from 'src/lib/keri/steward/replicate';
import type { ReplayInput } from 'src/lib/keri/steward/replay';
import { NotJoined, userFacingMessage } from 'src/lib/keri/steward/errors';
import { resolveOrgRegistryId } from 'src/lib/keri/registry';
import { secureStorage } from 'src/lib/secureStorage';

type Note = { i: string; r: boolean; a?: { r?: string; d?: string; dt?: string } };
export interface InboxDeps {
  org: { group: string; registry: string };
  getRequest(said: string): Promise<Array<{ exn: Record<string, unknown>; paths: Record<string, string> }>>;
  replay(input: ReplayInput): Promise<'applied' | 'already' | 'skipped'>;
  mark(noteId: string): Promise<void>;
}

const isOrgAct = (n: Note) => ORG_ACT_ROUTES.includes(n.a?.r as never);

/**
 * Apply unread /multisig/iss|rev notes oldest-first; act-then-mark. KERIA
 * never re-notifies an identical exn, so a note is marked read ONLY after its
 * replay returned — a failed replay stays unread for the next pass.
 */
export async function processOrgActNotes(notes: Note[], deps: InboxDeps): Promise<{ applied: number; failed: number }> {
  let applied = 0;
  let failed = 0;
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
      if (out === 'skipped') console.warn(`[OrgActInbox] skipped ${input.kind} for ${String(input.acdc.d).slice(0, 12)}... (predates our last rotation)`);
      await deps.mark(n.i);
      applied++;
    } catch (err) {
      failed++;
      console.warn('[OrgActInbox] replay failed, left unread:', err);
    }
  }
  return { applied, failed };
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
    const list = (notes.notifications.value as Note[])
      .filter((n) => !n.r && isOrgAct(n))
      .sort((a, b) => (a.a?.dt ?? '').localeCompare(b.a?.dt ?? ''));
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
    });
    pending.value = res.failed;
    lastError.value = res.failed ? `${res.failed} change(s) from other stewards not applied yet` : null;
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
