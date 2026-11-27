/**
 * The live wiring of the after-joining admission (issue #685): the member's
 * agent, the community's org AID and schema OOBIs from its descriptor, handed
 * to the rules in `grantAdmission`. Shared by the dashboard's poll and the
 * sign-in card, which a code scanned cold opens without the dashboard.
 */
import { useKERIClient } from 'src/lib/keri/client';
import { getOrFetchOrgConfig } from 'src/api/config';
import { getSchemaOobis } from 'src/lib/clientConfig';
import { createLogger } from 'src/lib/logging';
import {
  admitCommunityGrants,
  waitForCredential,
  type AdmittedCredential,
  type GrantClient,
  type GrantNote,
} from 'src/lib/keri/grantAdmission';

const log = createLogger('GrantAdmission');

/** The admit surface, plus the notification read the sign-in card needs. */
type LiveClient = Omit<GrantClient, 'notifications'> & {
  notifications(): {
    mark(notificationId: string): Promise<unknown>;
    list(start?: number, end?: number): Promise<{ notes?: GrantNote[] }>;
  };
};

/**
 * Admit what the community issued this member and wait for each credential to
 * reach the wallet. Returns the credentials that did. `notes` is the
 * notification list when the caller already holds it; otherwise it is read
 * from the agent. Never throws on a missing client, identity or org — there is
 * then simply nothing to admit.
 */
export async function admitPendingCommunityGrants(
  aidName: string | null | undefined,
  notes?: readonly GrantNote[],
): Promise<AdmittedCredential[]> {
  const keriClient = useKERIClient();
  const client = keriClient.getSignifyClient() as unknown as LiveClient | null;
  if (!client || !aidName) return [];

  const pending = notes ?? (await client.notifications().list(0, 1000)).notes ?? [];
  if (!pending.some((n) => n.a?.r === '/exn/ipex/grant' && !n.r)) return [];

  const config = await getOrFetchOrgConfig();
  const orgAid = config?.organization?.aid;
  if (!orgAid) return [];

  const admitted = await admitCommunityGrants(
    {
      client,
      aidName,
      orgAid,
      async resolveSchemas() {
        const oobis = await getSchemaOobis();
        await Promise.all(oobis.map((oobi) => keriClient.resolveOOBI(oobi, undefined, 30000)));
      },
      async resolveIssuer(aid: string) {
        // Not awaited to completion by design: the witness route can take a
        // while, and waitForCredential decides whether the credential landed.
        const oobi = `${keriClient.getCesrUrl().replace(/\/+$/, '')}/oobi/${aid}`;
        void keriClient.resolveOOBIWithReason(oobi, undefined, 30000);
        void keriClient.resolveViaWitnesses(aid);
      },
    },
    pending,
  );

  const landed: AdmittedCredential[] = [];
  for (const credential of admitted) {
    if (await waitForCredential(client, credential.said)) landed.push(credential);
    else log.warn(`admitted ${credential.name} but it has not reached the wallet yet`);
  }
  return landed;
}
