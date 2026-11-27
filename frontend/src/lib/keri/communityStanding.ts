/**
 * The live wiring of the standing read (issue #687): the member's agent and
 * the key history their community serves, handed to the rules in
 * `credentialStanding`. Every place that reads whether a credential stands —
 * the Wallet page, the sign-in card, the watch that tells the member — reads
 * it through {@link withLiveStanding}.
 */
import { ref } from 'vue';
import { useKERIClient } from 'src/lib/keri/client';
import { filterKelMessages, parseCesrStream } from 'src/lib/keri/cesr';
import { createLogger } from 'src/lib/logging';
import {
  createStandingReader,
  type KeyEventRecord,
  type RevokedCredential,
  type StandingCredential,
  type ToldMemory,
} from 'src/lib/keri/credentialStanding';

const log = createLogger('CredentialStanding');

/** How long a read of the served key history may take. */
const SERVED_TIMEOUT_MS = 8000;

/** How long the agent is given to hand over its copy. */
const AGENT_TIMEOUT_MS = 10_000;

/**
 * The revocations the latest look revealed. The dashboard's watch tells the
 * member of the ones they have not been told of; a look made where no watch is
 * mounted (the sign-in card) leaves them here for the next one that is.
 */
export const revealedRevocations = ref<RevokedCredential[]>([]);

/** The subset of `SignifyClient` the agent's copy is read through. */
interface KeyEventClient {
  keyEvents(): { get(pre: string): Promise<unknown> };
}

const reader = createStandingReader({
  async agentHistory(issuerAid) {
    const client = useKERIClient().getSignifyClient() as unknown as KeyEventClient | null;
    if (!client) throw new Error('not connected to the agent');
    const events = await Promise.race([
      client.keyEvents().get(issuerAid),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('the agent did not answer')), AGENT_TIMEOUT_MS),
      ),
    ]);
    return (Array.isArray(events) ? events : []) as KeyEventRecord[];
  },
  async servedHistory(issuerAid) {
    const base = useKERIClient().getCesrFetchUrl().replace(/\/+$/, '');
    const resp = await fetch(`${base}/oobi/${issuerAid}`, {
      signal: AbortSignal.timeout(SERVED_TIMEOUT_MS),
    });
    if (!resp.ok) throw new Error(`key history not served (${resp.status})`);
    return filterKelMessages(parseCesrStream(await resp.text())).map((m) => ({ ked: m.event }));
  },
  catchUp(issuerAid, sn) {
    // To a sequence number the community already serves, so the pull ends.
    void useKERIClient().queryKeyStateToSn(issuerAid, sn.toString(16));
  },
});

/**
 * The credentials with the standing their issuers' key histories give them.
 * Never throws: a standing that cannot be read leaves the credential as the
 * agent read it.
 */
export async function withLiveStanding<T extends StandingCredential>(
  credentials: readonly T[],
  holderAid: string | null | undefined,
): Promise<T[]> {
  try {
    const read = await reader.read(credentials, holderAid ?? '');
    if (read.revealed.length > 0) revealedRevocations.value = read.revealed;
    return read.credentials;
  } catch (err) {
    log.warn('could not read the standing of the held credentials', err);
    return [...credentials];
  }
}

/** Look at every credential the wallet holds. Never throws. */
export async function lookForRevocations(holderAid: string | null | undefined): Promise<void> {
  try {
    const client = useKERIClient().getSignifyClient();
    if (!client || !holderAid) return;
    await withLiveStanding((await client.credentials().list()) as StandingCredential[], holderAid);
  } catch (err) {
    log.debug('could not look for revocations; the next look tries again', err);
  }
}

const TOLD_KEY = 'matou_revocations_told';

/** Which revocations this device has told the member of. */
export const toldOnThisDevice: ToldMemory = {
  read() {
    const raw = localStorage.getItem(TOLD_KEY);
    const saids: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(saids) ? saids.filter((s): s is string => typeof s === 'string') : [];
  },
  write(saids) {
    localStorage.setItem(TOLD_KEY, JSON.stringify(saids));
  },
};
