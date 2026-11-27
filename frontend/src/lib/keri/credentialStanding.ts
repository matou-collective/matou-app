/**
 * Reading whether a held credential has been revoked (issue #687).
 *
 * Revoking writes to the ISSUER's registry and anchors the event in the
 * issuer's key history; nothing is sent to the holder, and the holder's agent
 * asks for a credential's registry state only while admitting it. So the
 * standing an agent reports for a held credential is the standing on the day
 * it was admitted: a credential revoked since stayed Active on the Wallet page
 * and was still offered at a door that then refused it.
 *
 * The wallet reads standing where the IDSS door reads it (idss
 * `internal/keriauth/ledger.go`, `WalkSeals`). A credential's registry holds
 * exactly two events — issue at `s = 0`, revoke at `s = 1` — and each is
 * anchored as a seal `{i: <credential SAID>, s, d}` in the issuer's key
 * history. A seal at `s = 1` naming the credential means it is revoked.
 *
 * A key history that could not be read is "unknown", never "revoked": the
 * credential then stands as the agent read it.
 */
import { credentialTitle, type CredentialDisplay } from 'src/lib/credentialAppearance';
import { isCredentialRevoked } from 'src/lib/keri/notifications';
import { createLogger } from 'src/lib/logging';

const log = createLogger('CredentialStanding');

/** Key events that can carry a registry anchor. */
const ANCHORING_ILKS = new Set(['ixn', 'rot', 'drt']);

/** The sequence number of a credential registry's revocation event. */
const REVOKED_SN = '1';

/** One event of a key history, as `keyEvents().get()` returns it. */
export interface KeyEventRecord {
  ked?: Record<string, unknown> | null;
}

/** The subset of a held credential the standing read depends on. */
export interface StandingCredential {
  sad?: {
    d?: string;
    /** The issuer AID. */
    i?: string;
    a?: {
      /** The holder AID. */
      i?: string;
      committee?: string;
      communityName?: string;
      display?: CredentialDisplay;
      [k: string]: unknown;
    };
    [k: string]: unknown;
  };
  schema?: { title?: string };
  status?: { s?: string; et?: string; [k: string]: unknown };
}

/**
 * The credentials among `saids` whose revocation `issuerAid` anchored in its
 * key history. Reads past anything that is not an event of that issuer or not
 * a seal — a rotation's anchors need not be seals. Never throws.
 */
export function revokedBySeals(
  events: readonly KeyEventRecord[],
  issuerAid: string,
  saids: Iterable<string>,
): Set<string> {
  const asked = new Set(saids);
  const revoked = new Set<string>();
  for (const event of events ?? []) {
    const ked = event?.ked;
    if (!ked || ked.i !== issuerAid || !ANCHORING_ILKS.has(String(ked.t))) continue;
    if (!Array.isArray(ked.a)) continue;
    for (const seal of ked.a as unknown[]) {
      if (!seal || typeof seal !== 'object') continue;
      const { i, s } = seal as { i?: unknown; s?: unknown };
      if (typeof i === 'string' && s === REVOKED_SN && asked.has(i)) revoked.add(i);
    }
  }
  return revoked;
}

/**
 * How far a copy of `issuerAid`'s key history reaches: its highest sequence
 * number, or -1 when it holds none of that issuer's events.
 */
export function latestSn(events: readonly KeyEventRecord[], issuerAid: string): number {
  let latest = -1;
  for (const event of events ?? []) {
    const ked = event?.ked;
    if (!ked || ked.i !== issuerAid || typeof ked.s !== 'string') continue;
    if (!/^[0-9a-f]+$/i.test(ked.s)) continue;
    latest = Math.max(latest, parseInt(ked.s, 16));
  }
  return latest;
}

export interface StandingDeps {
  /** The issuer's key history. Rejects when it could not be read. */
  keyHistory(issuerAid: string): Promise<readonly KeyEventRecord[]>;
}

/** A revocation the key history revealed — what the member is told. */
export interface RevokedCredential {
  said: string;
  /** The name on the credential's card ("Administrator"). */
  name: string;
  /** The community that issued it, as the credential names it (may be blank). */
  communityName: string;
}

export interface StandingRead<T> {
  /** The credentials, in the order given, each with the standing its issuer's
   *  key history gives it. One the history does not revoke is the same object. */
  credentials: T[];
  /** This member's credentials the agent read as live and the history revokes. */
  revealed: RevokedCredential[];
}

/**
 * Read each credential's standing from its issuer's key history. One issuer's
 * history failing to read never stops the next, and leaves that issuer's
 * credentials as the agent read them.
 */
export async function readStanding<T extends StandingCredential>(
  deps: StandingDeps,
  credentials: readonly T[],
  holderAid: string,
): Promise<StandingRead<T>> {
  const byIssuer = new Map<string, string[]>();
  for (const cred of credentials) {
    const issuer = cred.sad?.i;
    const said = cred.sad?.d;
    if (!issuer || !said) continue;
    byIssuer.set(issuer, [...(byIssuer.get(issuer) ?? []), said]);
  }

  const revoked = new Set<string>();
  await Promise.all(
    [...byIssuer].map(async ([issuer, saids]) => {
      try {
        const history = await deps.keyHistory(issuer);
        for (const said of revokedBySeals(history, issuer, saids)) revoked.add(said);
      } catch (err) {
        log.debug(`standing unknown for credentials of ${issuer.slice(0, 12)}; left as the agent read them`, err);
      }
    }),
  );

  const revealed: RevokedCredential[] = [];
  const read = credentials.map((cred) => {
    const said = cred.sad?.d ?? '';
    if (!revoked.has(said) || isCredentialRevoked(cred)) return cred;
    const issuee = cred.sad?.a?.i;
    if (holderAid && issuee === holderAid) {
      revealed.push({
        said,
        name: credentialTitle(
          { display: cred.sad?.a?.display, committee: cred.sad?.a?.committee },
          cred.schema?.title || 'Credential',
        ),
        communityName: cred.sad?.a?.communityName ?? '',
      });
    }
    return { ...cred, status: { ...cred.status, s: REVOKED_SN, et: 'rev' } };
  });
  return { credentials: read, revealed };
}

/** Which revocations the member has been told of, kept across app opens. */
export interface ToldMemory {
  read(): string[];
  write(saids: string[]): void;
}

/**
 * The revocations the member has not yet been told of, remembered as told.
 * When the memory cannot be read or written nothing is told: a line that
 * cannot be remembered would be said again on every look.
 */
export function takeUntold(
  revealed: readonly RevokedCredential[],
  memory: ToldMemory,
): RevokedCredential[] {
  if (revealed.length === 0) return [];
  try {
    const told = new Set(memory.read());
    const untold = revealed.filter((r) => !told.has(r.said));
    if (untold.length === 0) return [];
    memory.write([...told, ...untold.map((r) => r.said)]);
    return untold;
  } catch (err) {
    log.debug('could not remember which revocations were told; telling none', err);
    return [];
  }
}

/** The line the member is told once a credential of theirs is revoked. */
export function revokedMessage(revoked: RevokedCredential): string {
  return `${revoked.communityName || 'Your community'} revoked ${revoked.name}`;
}

export interface StandingReaderDeps {
  /** The issuer's key history as the member's agent holds it: verified by the
   *  agent, and as old as the agent's last pull. */
  agentHistory(issuerAid: string): Promise<readonly KeyEventRecord[]>;
  /** The issuer's key history as the community serves it now. */
  servedHistory(issuerAid: string): Promise<readonly KeyEventRecord[]>;
  /** Ask the agent to pull the issuer's key history up to `sn`. Not waited on. */
  catchUp?(issuerAid: string, sn: number): void;
  /** How long one read of a key history answers the looks that follow it. */
  cacheMs?: number;
  now?(): number;
}

/**
 * The standing read over the two copies of an issuer's key history the app can
 * reach. A seal in either is a seal, so they are read together; one that cannot
 * be read leaves the other to answer, and when neither can the standing is
 * unknown. An agent whose copy is behind the served one is asked to catch up.
 *
 * Looks that come together — the Wallet page opening while the watch runs —
 * share one read.
 */
export function createStandingReader(deps: StandingReaderDeps) {
  const cacheMs = deps.cacheMs ?? 15_000;
  const now = deps.now ?? (() => Date.now());
  const recent = new Map<string, { at: number; history: Promise<KeyEventRecord[]> }>();
  const asked = new Set<string>();

  async function readHistory(issuerAid: string): Promise<KeyEventRecord[]> {
    const [agent, served] = await Promise.allSettled([
      deps.agentHistory(issuerAid),
      deps.servedHistory(issuerAid),
    ]);
    if (agent.status === 'rejected' && served.status === 'rejected') {
      throw new Error(`no copy of the key history of ${issuerAid.slice(0, 12)} could be read`);
    }
    const held = agent.status === 'fulfilled' ? agent.value : [];
    const fresh = served.status === 'fulfilled' ? served.value : [];
    const reach = latestSn(fresh, issuerAid);
    if (agent.status === 'fulfilled' && reach > latestSn(held, issuerAid)) {
      // Once per point: an agent that cannot catch up is not asked every look.
      const point = `${issuerAid}:${reach}`;
      if (!asked.has(point)) {
        asked.add(point);
        deps.catchUp?.(issuerAid, reach);
      }
    }
    return [...held, ...fresh];
  }

  function keyHistory(issuerAid: string): Promise<readonly KeyEventRecord[]> {
    const last = recent.get(issuerAid);
    if (last && now() - last.at < cacheMs) return last.history;
    const history = readHistory(issuerAid);
    recent.set(issuerAid, { at: now(), history });
    // A look that read nothing answers no later look.
    history.catch(() => {
      if (recent.get(issuerAid)?.history === history) recent.delete(issuerAid);
    });
    return history;
  }

  return {
    read<T extends StandingCredential>(
      credentials: readonly T[],
      holderAid: string,
    ): Promise<StandingRead<T>> {
      return readStanding({ keyHistory }, credentials, holderAid);
    },
  };
}
