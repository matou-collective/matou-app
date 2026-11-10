/**
 * Admitting the credentials a member's community issues them AFTER they joined
 * (issue #685).
 *
 * A credential reaches its holder as an IPEX grant: a `/exn/ipex/grant`
 * notification in the holder's agent, which the holder must ADMIT before the
 * credential is in their wallet. The app admitted grants only while a member
 * was joining (the pending-approval screen), so a credential issued later — an
 * Administrator or any komiti credential from the IDSS control panel — stayed
 * an unread grant for ever: nothing on the Wallet page, nothing to present at
 * a door that asks for it.
 *
 * The rule (Ben, 2026-09-29): accept silently, then tell the member — and only
 * what the member's OWN community issued TO them. A grant from anyone else is
 * left unread and untouched.
 */
import { credentialTitle, type CredentialDisplay } from 'src/lib/credentialAppearance';
import { createLogger } from 'src/lib/logging';
import { isGrantAlreadyAdmitted, type CredentialListClient } from 'src/lib/keri/notifications';

const log = createLogger('GrantAdmission');

const GRANT_ROUTE = '/exn/ipex/grant';

/** The subset of a KERIA notification the admission reads. */
export interface GrantNote {
  i: string; // notification id
  r: boolean; // read flag
  a: { r: string; d: string }; // route, and the grant exchange's SAID
}

/** The credential a grant carries, as far as the admission reads it. */
interface GrantedAcdc {
  d?: string;
  s?: string;
  i?: string;
  a?: {
    i?: string;
    committee?: string;
    communityName?: string;
    display?: CredentialDisplay;
  };
}

/** A grant exchange as `exchanges().get()` returns it. */
export interface GrantExchange {
  exn: { i?: string; e?: { acdc?: GrantedAcdc; anc?: { s?: string; d?: string } } };
}

/** The subset of `SignifyClient` an admit depends on. */
export interface GrantClient extends CredentialListClient {
  exchanges(): {
    get(said: string): Promise<GrantExchange>;
    createExchangeMessage(
      sender: unknown,
      route: string,
      payload: Record<string, unknown>,
      embeds: Record<string, unknown>,
      recipient: string,
      datetime?: string,
      dig?: string,
    ): Promise<[unknown, string[], string]>;
  };
  identifiers(): { get(name: string): Promise<unknown> };
  ipex(): {
    submitAdmit(
      name: string,
      admit: unknown,
      sigs: string[],
      atc: string,
      recipients: string[],
    ): Promise<unknown>;
  };
  notifications(): { mark(notificationId: string): Promise<unknown> };
}

/** What one admit did. */
export interface AdmitOutcome {
  /** The sender of the grant (`exn.i`) — the AID whose key history de-escrows it. */
  grantSender: string;
  /** sn (hex) of the KEL event anchoring the credential (`exn.e.anc.s`). */
  ancSn: string | null;
  /** True when the credential was already in the wallet, so nothing was sent. */
  alreadyAdmitted: boolean;
}

/**
 * Admit one grant, then mark its notification read. Act-then-mark: a failed
 * admit throws with the notification still unread, so the next cycle retries.
 *
 * Idempotent on the credential (issue #470): two signify clients on one agent
 * both see the grant, so a credential already in the wallet is marked read and
 * never admitted a second time.
 */
export async function admitGrant(
  client: GrantClient,
  aidName: string,
  note: GrantNote,
  grantExn?: GrantExchange,
): Promise<AdmitOutcome> {
  const exn = grantExn ?? (await client.exchanges().get(note.a.d));
  const grantSender = exn.exn.i ?? '';
  const ancSn = exn.exn.e?.anc?.s ?? null;

  if (await isGrantAlreadyAdmitted(client, exn)) {
    await client.notifications().mark(note.i);
    return { grantSender, ancSn, alreadyAdmitted: true };
  }

  // Submit admit with empty embeds. KERIA's sendAdmit() for single-sig AIDs
  // does not process path labels — the Admitter background task retrieves
  // ACDC/ISS/ANC data from the GRANT's cloned attachments.
  const hab = await client.identifiers().get(aidName);
  const [admit, sigs, atc] = await client
    .exchanges()
    .createExchangeMessage(hab, '/ipex/admit', { m: '' }, {}, grantSender, undefined, note.a.d);
  await client.ipex().submitAdmit(aidName, admit, sigs, atc, [grantSender]);
  await client.notifications().mark(note.i);

  return { grantSender, ancSn, alreadyAdmitted: false };
}

/** A credential the admission put in the wallet — what the member is told. */
export interface AdmittedCredential {
  said: string;
  schema: string;
  /** The name on the credential's card ("Administrator"). */
  name: string;
  /** The community that issued it, as the credential names it (may be blank). */
  communityName: string;
}

export interface GrantAdmissionDeps {
  client: GrantClient;
  /** The member's identifier name in their agent. */
  aidName: string;
  /** The community's org AID — the only issuer whose grants are admitted. */
  orgAid: string;
  /**
   * Resolve the community's credential schemas into the agent. An agent that
   * has never resolved a credential's schema escrows the admit for ever, and a
   * member's agent has only ever resolved Membership.
   */
  resolveSchemas(): Promise<void>;
  /** Pull the issuer's key history, so a credential in escrow can land. */
  resolveIssuer(aid: string): Promise<void>;
}

/**
 * Admit every unread grant of a credential this member's community issued to
 * them. Returns what was newly admitted, in notification order.
 *
 * One grant's failure never stops the next; the failed grant stays unread and
 * is tried again on the next cycle.
 */
export async function admitCommunityGrants(
  deps: GrantAdmissionDeps,
  notes: readonly GrantNote[],
): Promise<AdmittedCredential[]> {
  const unread = notes.filter((n) => n.a?.r === GRANT_ROUTE && !n.r);
  if (unread.length === 0) return [];

  const holder = await holderPrefix(deps);
  const admitted: AdmittedCredential[] = [];
  let schemasResolved = false;

  for (const note of unread) {
    try {
      const exn = await deps.client.exchanges().get(note.a.d);
      const acdc = exn.exn.e?.acdc;
      if (!acdc?.d || acdc.i !== deps.orgAid) continue;
      if (holder && acdc.a?.i && acdc.a.i !== holder) continue;

      if (!schemasResolved) {
        await deps.resolveSchemas();
        schemasResolved = true;
      }

      const outcome = await admitGrant(deps.client, deps.aidName, note, exn);
      if (outcome.alreadyAdmitted) continue;

      await deps.resolveIssuer(outcome.grantSender);
      admitted.push({
        said: acdc.d,
        schema: acdc.s ?? '',
        name: credentialTitle(
          { display: acdc.a?.display, committee: acdc.a?.committee },
          'Credential',
        ),
        communityName: acdc.a?.communityName ?? '',
      });
    } catch (err) {
      log.warn(`grant ${note.a.d.slice(0, 12)} not admitted; it stays unread for the next cycle`, err);
    }
  }
  return admitted;
}

/** The member's own AID, or blank when the agent cannot say. */
async function holderPrefix(deps: GrantAdmissionDeps): Promise<string> {
  try {
    const hab = (await deps.client.identifiers().get(deps.aidName)) as { prefix?: string } | null;
    return hab?.prefix ?? '';
  } catch {
    return '';
  }
}

/**
 * Wait for an admitted credential to be in the wallet. KERIA works an admit in
 * the background, so the credential lands a few seconds after the admit is
 * accepted. Answers false when it has not landed after `attempts` reads —
 * never throws, and never waits for ever.
 */
export async function waitForCredential(
  client: CredentialListClient,
  said: string,
  opts: { attempts?: number; sleep?: (ms: number) => Promise<void>; intervalMs?: number } = {},
): Promise<boolean> {
  const attempts = opts.attempts ?? 20;
  const intervalMs = opts.intervalMs ?? 3000;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const creds = await client.credentials().list({ filter: { '-d': said }, limit: 1 });
      if ((creds ?? []).some((c) => (c?.sad?.d ?? c?.d) === said)) return true;
    } catch (err) {
      log.debug(`credential read failed while waiting for ${said.slice(0, 12)}`, err);
    }
    if (attempt < attempts) await sleep(intervalMs);
  }
  return false;
}

/** The line the member is told once a credential is in their wallet. */
export function admittedMessage(admitted: AdmittedCredential): string {
  return `${admitted.communityName || 'Your community'} issued you ${admitted.name}`;
}
