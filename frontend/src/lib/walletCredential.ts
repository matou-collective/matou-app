/**
 * The wallet's view of one held credential, and the words its card wears.
 *
 * Two surfaces draw a held credential as a card — the wallet's Credentials tab
 * and the sign-in approve screen (#683), which shows the credential about to be
 * presented as the very card the member already knows from their wallet. Both
 * map the agent's raw record and word the card through this module, so the two
 * cannot drift apart.
 *
 * Pure: no store, no client. The wallet store supplies the schema titles it
 * fetched; the approve screen reads the schema the agent returned on the record.
 */

import { parseCredentialDisplay, type CredentialDisplay } from 'src/lib/credentialAppearance';

export interface WalletCredential {
  said: string;
  schemaSaid: string;
  schemaTitle: string;
  schemaDescription: string;
  issuerAid: string;
  issueeAid: string;
  communityName: string;
  role: string;
  permissions: string[];
  joinedAt: string;
  issuedAt: string;
  status: string;
  // Endorsement-specific
  claim: string;
  endorsementType: string;
  // Event attendance-specific
  eventName: string;
  eventType: string;
  // IDSS committee slug (a.committee), if any
  committee: string;
  // IDSS "look" (a.display), if the community styled the credential
  display?: CredentialDisplay;
}

/** A schema's title and description, keyed by schema SAID. */
export type SchemaInfoMap = Map<string, { title: string; description: string }>;

/**
 * Map the agent's raw credential record to a {@link WalletCredential}. The
 * schema's title and description come from `schemaMap` when it knows the
 * schema, else from the schema the agent returned on the record itself.
 * `fallbackIssuee` stands in when the credential names no issuee.
 */
export function toWalletCredential(
  cred: Record<string, unknown>,
  schemaMap: SchemaInfoMap = new Map(),
  fallbackIssuee = '',
): WalletCredential {
  const sad = cred.sad as Record<string, unknown> | undefined;
  const attrs = (sad?.a || {}) as Record<string, unknown>;
  const statusObj = cred.status as Record<string, unknown> | undefined;
  const schemaSaid = (sad?.s as string) || '';
  const onRecord =
    cred.schema && typeof cred.schema === 'object' ? (cred.schema as Record<string, unknown>) : undefined;
  const schema = schemaMap.get(schemaSaid);

  return {
    said: (sad?.d as string) || '',
    schemaSaid,
    schemaTitle: schema?.title || (onRecord?.title as string) || '',
    schemaDescription: schema?.description || (onRecord?.description as string) || '',
    issuerAid: (sad?.i as string) || '',
    issueeAid: (attrs.i as string) || fallbackIssuee,
    communityName: (attrs.communityName as string) || '',
    role: (attrs.role as string) || '',
    permissions: (attrs.permissions as string[]) || [],
    joinedAt: (attrs.joinedAt as string) || '',
    issuedAt: (attrs.dt as string) || '',
    status: (statusObj?.s as string) || 'unknown',
    claim: (attrs.claim as string) || '',
    endorsementType: (attrs.endorsementType as string) || '',
    eventName: (attrs.eventName as string) || '',
    eventType: (attrs.eventType as string) || '',
    committee: (attrs.committee as string) || '',
    display: parseCredentialDisplay(attrs.display),
  };
}

/** True when a credential's status says it has been revoked. */
export function isRevokedStatus(status: string): boolean {
  const s = status.toLowerCase();
  return s === '1' || s === 'revoked';
}

/** The status chip's word: Active, Revoked, or the raw status while pending. */
export function credentialStatusLabel(status: string): string {
  const s = status.toLowerCase();
  if (s === '0' || s === 'issued' || s === 'valid') return 'Active';
  if (s === '1' || s === 'revoked') return 'Revoked';
  return status || 'Pending';
}

/**
 * An IDSS credential names the slug services gate on — the panel card's
 * "services know it as" line. Legacy (Mātou-schema) credentials have none.
 */
export function credentialCardServiceName(
  cred: Pick<WalletCredential, 'display' | 'committee' | 'role'>,
): string {
  if (!cred.display && !cred.committee) return '';
  return cred.committee || cred.role || '';
}
