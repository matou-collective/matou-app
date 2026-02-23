/**
 * Composable for admin pre-created invite flow.
 * Creates a KERIA agent + AID for an invitee, issues endorsement credential
 * via IPEX grant, then generates a claim link with the agent passcode.
 */
import { ref } from 'vue';
import { generateMnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english.js';
import { KERIClient, useKERIClient } from 'src/lib/keri/client';
import { useIdentityStore } from 'stores/identity';
import { getOrCreatePersonalRegistry } from 'src/lib/keri/registry';

export interface InviteConfig {
  inviteeName: string;
  reason?: string;
  role?: string;
}

export interface InviteResult {
  inviteCode: string;
  inviteeAid: string;
}

// Schema SAIDs (from schema server)
const ENDORSEMENT_SCHEMA_SAID = 'EIefouRuIuoi9ZtnW3BOCSVeXQSt8k3uJLvmYHfvNPOE';
const MEMBERSHIP_SCHEMA_SAID = 'EOVL3N0K_tYc9U-HXg7r2jDPo4Gnq3ebCjDqbJzl6fsT';
// Schema server URL is internal to Docker network (KERIA resolves it)
const SCHEMA_SERVER_URL = 'http://schema-server:7723';
const SCHEMA_OOBI_URL = `${SCHEMA_SERVER_URL}/oobi/${ENDORSEMENT_SCHEMA_SAID}`;

const WITNESS_AID = 'BBilc4-L3tFUnfM_wJr4S4OJanAv_VmF_dJNN6vkf2Ha';

// KERIA CESR URL as seen from inside Docker (used for bare OOBI resolution).
// Bare OOBIs (/oobi/{prefix}) serve the full KEL via hab.replay() and don't
// require an agent end role, unlike /oobi/{prefix}/agent/{agentId} OOBIs.
// This is a fixed internal Docker hostname, not configurable per environment.
const KERIA_DOCKER_URL = 'http://keria:3902';

export function usePreCreatedInvite() {
  const adminClient = useKERIClient();
  const identityStore = useIdentityStore();

  const isSubmitting = ref(false);
  const error = ref<string | null>(null);
  const progress = ref('');
  const result = ref<InviteResult | null>(null);

  async function createInvite(config: InviteConfig): Promise<boolean> {
    isSubmitting.value = true;
    error.value = null;
    progress.value = '';
    result.value = null;

    try {
      // Step 1: Generate temporary credentials for the invitee's agent
      progress.value = 'Generating temporary credentials...';
      const tempMnemonic = generateMnemonic(wordlist, 128);
      const tempPasscode = KERIClient.passcodeFromMnemonic(tempMnemonic);
      console.log('[PreCreatedInvite] Generated temp passcode for invitee agent');

      // Step 2: Create ephemeral client for invitee's agent
      progress.value = 'Creating invitee agent...';
      const inviteeClient = await KERIClient.createEphemeralClient(tempPasscode);
      console.log('[PreCreatedInvite] Ephemeral client created');

      // Step 3: Create AID in invitee's agent
      progress.value = 'Creating invitee identity...';
      const aidName = config.inviteeName.toLowerCase().replace(/\s+/g, '-');
      const createResult = await inviteeClient.identifiers().create(aidName, {
        wits: [WITNESS_AID],
        toad: 1,
      });
      const createOp = await createResult.op();
      await inviteeClient.operations().wait(createOp, { signal: AbortSignal.timeout(180000) });

      const inviteeAid = await inviteeClient.identifiers().get(aidName);
      console.log('[PreCreatedInvite] Created invitee AID:', inviteeAid.prefix);

      // Add agent end role
      const agentId = inviteeClient.agent?.pre;
      if (agentId) {
        const endRoleResult = await inviteeClient.identifiers().addEndRole(inviteeAid.prefix, 'agent', agentId);
        const endRoleOp = await endRoleResult.op();
        await inviteeClient.operations().wait(endRoleOp, { signal: AbortSignal.timeout(30000) });
        console.log('[PreCreatedInvite] Agent end role added');
      }

      // Step 4: Bidirectional OOBI resolution
      progress.value = 'Establishing contact between agents...';

      // Get invitee OOBI and resolve on admin's agent
      // OOBI resolution happens server-side (KERIA resolves via its Docker network),
      // so we pass the raw OOBI URL without hostname normalization.
      const inviteeOobiResult = await inviteeClient.oobis().get(inviteeAid.prefix, 'agent');
      const inviteeOobi = inviteeOobiResult.oobis?.[0] || inviteeOobiResult.oobi;
      if (!inviteeOobi) {
        throw new Error('Could not get invitee OOBI');
      }
      console.log('[PreCreatedInvite] Invitee OOBI:', inviteeOobi);
      const resolved = await adminClient.resolveOOBI(inviteeOobi, `invitee-${aidName}`, 30000);
      if (!resolved) {
        throw new Error('Failed to resolve invitee OOBI on admin agent');
      }
      console.log('[PreCreatedInvite] Admin resolved invitee OOBI');

      // Get admin/org OOBI and resolve on invitee's agent
      const adminSignifyClient = adminClient.getSignifyClient();
      if (!adminSignifyClient) throw new Error('Admin client not initialized');

      // Find org AID name from admin's identifiers
      const adminAids = await adminSignifyClient.identifiers().list();
      const adminAgentId = adminSignifyClient.agent?.pre;
      for (const aid of adminAids.aids) {
        try {
          let oobiResult = await adminSignifyClient.oobis().get(aid.prefix, 'agent');
          let oobi = oobiResult.oobis?.[0] || oobiResult.oobi;

          // If no agent OOBI exists (e.g. group AID created without end role),
          // add the agent end role so the OOBI can be served via KERIA.
          if (!oobi && adminAgentId) {
            console.log(`[PreCreatedInvite] Adding agent end role to "${aid.name}"...`);
            try {
              const endRoleResult = await adminSignifyClient.identifiers().addEndRole(aid.prefix, 'agent', adminAgentId);
              const endRoleOp = await endRoleResult.op();
              await adminSignifyClient.operations().wait(endRoleOp, { signal: AbortSignal.timeout(30000) });
              console.log(`[PreCreatedInvite] Agent end role added to "${aid.name}"`);

              oobiResult = await adminSignifyClient.oobis().get(aid.prefix, 'agent');
              oobi = oobiResult.oobis?.[0] || oobiResult.oobi;
            } catch (roleErr) {
              console.warn(`[PreCreatedInvite] Failed to add end role for ${aid.name}:`, roleErr);
            }
          }

          // Fall back to bare KERIA OOBI if no agent OOBI is available.
          // Group AIDs (e.g. org AID) can't have agent end roles added via
          // the single-sig API, so oobis().get() returns nothing. The bare
          // OOBI (/oobi/{prefix}) serves the full KEL via hab.replay() and
          // doesn't require an agent end role.
          if (!oobi) {
            oobi = `${KERIA_DOCKER_URL}/oobi/${aid.prefix}`;
            console.log(`[PreCreatedInvite] Using bare KERIA OOBI for ${aid.name}: ${oobi}`);
          }

          const resolveOp = await inviteeClient.oobis().resolve(oobi, `admin-${aid.name}`);
          await inviteeClient.operations().wait(resolveOp, { signal: AbortSignal.timeout(30000) });
          console.log(`[PreCreatedInvite] Invitee resolved admin OOBI for ${aid.name}`);
        } catch (oobiErr) {
          console.warn(`[PreCreatedInvite] Failed to resolve OOBI for ${aid.name}:`, oobiErr);
        }
      }

      // Step 5: Resolve schema OOBIs on both agents
      // The invitee's agent needs the schemas to verify and store the credential
      // after IPEX admit; the admin needs it for credential issuance.
      // Both endorsement AND membership schemas are needed because the endorsement
      // credential has an edge linking to the admin's membership credential.
      progress.value = 'Loading credential schemas...';
      const membershipSchemaOOBI = `${SCHEMA_SERVER_URL}/oobi/${MEMBERSHIP_SCHEMA_SAID}`;

      await adminClient.resolveOOBI(SCHEMA_OOBI_URL, ENDORSEMENT_SCHEMA_SAID);
      await adminClient.resolveOOBI(membershipSchemaOOBI, MEMBERSHIP_SCHEMA_SAID);
      console.log('[PreCreatedInvite] Schema OOBIs resolved on admin agent');

      const endorseSchemaOp = await inviteeClient.oobis().resolve(SCHEMA_OOBI_URL, ENDORSEMENT_SCHEMA_SAID);
      await inviteeClient.operations().wait(endorseSchemaOp, { signal: AbortSignal.timeout(30000) });
      const membershipSchemaOp = await inviteeClient.oobis().resolve(membershipSchemaOOBI, MEMBERSHIP_SCHEMA_SAID);
      await inviteeClient.operations().wait(membershipSchemaOp, { signal: AbortSignal.timeout(30000) });
      console.log('[PreCreatedInvite] Schema OOBIs resolved on invitee agent');

      const grantMessage = '';

      // Step 6: Issue endorsement credential from admin's personal AID
      // (not the org AID — endorsements should come from the admin who invited)
      progress.value = 'Issuing endorsement credential...';

      const adminAid = identityStore.currentAID;
      if (!adminAid) throw new Error('No admin identity found');

      // Get or create a personal endorsement registry for the admin
      const registryId = await getOrCreatePersonalRegistry();

      // Find the admin's membership credential for the endorsement edge
      const allCreds = await adminSignifyClient.credentials().list();
      const membershipCred = allCreds.find(
        (c: { sad?: { s?: string; a?: { i?: string } } }) =>
          c.sad?.s === MEMBERSHIP_SCHEMA_SAID && c.sad?.a?.i === adminAid.prefix
      );
      if (!membershipCred?.sad?.d) {
        throw new Error('Could not find admin membership credential. Admin must be an admitted member to invite.');
      }
      console.log('[PreCreatedInvite] Found admin membership credential:', membershipCred.sad.d);

      const credentialData = {
        endorsementType: 'membership_endorsement',
        category: 'general',
        claim: config.reason,
        confidence: 'high',
      };

      const edgeData = {
        d: '', // SAID placeholder — signify-ts computes this
        endorserMembership: {
          n: membershipCred.sad.d,
          s: MEMBERSHIP_SCHEMA_SAID,
        },
      };

      await adminClient.issueCredential(
        adminAid.prefix,
        registryId,
        ENDORSEMENT_SCHEMA_SAID,
        inviteeAid.prefix,
        credentialData,
        grantMessage,
        edgeData,
      );
      console.log('[PreCreatedInvite] Endorsement credential issued and IPEX grant sent');

      // Step 6b: Re-resolve admin OOBI on invitee's agent.
      // Credential issuance (step 6) created new IXN events on the admin's AID.
      // The invitee's agent resolved the admin's OOBI at step 4, before those events.
      // Without re-resolution, the grant arrives but the invitee's agent can't verify
      // it (admin's key state is stale) → grant gets escrowed → admit silently fails.
      progress.value = 'Syncing credential state...';
      for (const aid of adminAids.aids) {
        try {
          const oobiResult = await adminSignifyClient.oobis().get(aid.prefix, 'agent');
          let oobi = oobiResult.oobis?.[0] || oobiResult.oobi;
          if (!oobi) {
            oobi = `${KERIA_DOCKER_URL}/oobi/${aid.prefix}`;
          }
          const resolveOp = await inviteeClient.oobis().resolve(oobi, `admin-${aid.name}`);
          await inviteeClient.operations().wait(resolveOp, { signal: AbortSignal.timeout(30000) });
        } catch (oobiErr) {
          console.warn(`[PreCreatedInvite] Post-grant OOBI re-resolve failed for ${aid.name}:`, oobiErr);
        }
      }
      console.log('[PreCreatedInvite] Admin OOBI re-resolved on invitee agent');

      // Step 7: Generate invite code (encode mnemonic entropy as base64url)
      // The invite code encodes the mnemonic, NOT the raw passcode.
      // This allows the invitee to recover their identity using the mnemonic
      // derived from the invite code, since the agent was booted with
      // passcodeFromMnemonic(mnemonic) — matching the standard recovery flow.
      progress.value = 'Generating invite code...';

      result.value = {
        inviteCode: KERIClient.inviteCodeFromMnemonic(tempMnemonic),
        inviteeAid: inviteeAid.prefix,
      };

      progress.value = 'Invitation created!';
      console.log('[PreCreatedInvite] Invite complete, code generated');

      return true;
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : 'Failed to create invitation';
      console.error('[PreCreatedInvite] Error:', err);
      error.value = errorMsg;
      progress.value = '';
      return false;
    } finally {
      isSubmitting.value = false;
    }
  }

  function reset() {
    isSubmitting.value = false;
    error.value = null;
    progress.value = '';
    result.value = null;
  }

  return {
    isSubmitting,
    error,
    progress,
    result,
    createInvite,
    reset,
  };
}
