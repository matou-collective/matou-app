/**
 * Composable for admin pre-created invite flow.
 * Creates a KERIA agent + AID for an invitee, issues endorsement credential
 * via IPEX grant, then generates a claim link with the agent passcode.
 */
import { ref } from 'vue';
import { generateMnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english.js';
import { KERIClient, useKERIClient } from 'src/lib/keri/client';
import { fetchOrgConfig } from 'src/api/config';

export interface InviteConfig {
  inviteeName: string;
  reason: string;
}

export interface InviteResult {
  inviteCode: string;
  inviteeAid: string;
}

// Endorsement credential schema SAID (from schema server)
const ENDORSEMENT_SCHEMA_SAID = 'EIefouRuIuoi9ZtnW3BOCSVeXQSt8k3uJLvmYHfvNPOE';
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

      // Step 5: Resolve schema OOBI on both agents
      // The invitee's agent needs the schema to verify and store the credential
      // after IPEX admit; the admin needs it for credential issuance.
      progress.value = 'Loading credential schema...';
      await adminClient.resolveOOBI(SCHEMA_OOBI_URL, ENDORSEMENT_SCHEMA_SAID);
      console.log('[PreCreatedInvite] Schema OOBI resolved on admin agent');

      const schemaResolveOp = await inviteeClient.oobis().resolve(SCHEMA_OOBI_URL, ENDORSEMENT_SCHEMA_SAID);
      await inviteeClient.operations().wait(schemaResolveOp, { signal: AbortSignal.timeout(30000) });
      console.log('[PreCreatedInvite] Schema OOBI resolved on invitee agent');

      const grantMessage = '';

      // Step 6: Issue endorsement credential from admin's agent
      progress.value = 'Issuing endorsement credential...';

      // Get org AID from config (more reliable than localStorage which is context-specific)
      const configResult = await fetchOrgConfig();
      const orgConfig = configResult.status === 'configured'
        ? configResult.config
        : configResult.status === 'server_unreachable'
          ? configResult.cached
          : null;
      const orgAidPrefix = orgConfig?.organization?.aid;
      if (!orgAidPrefix) throw new Error('Organization not set up — no org AID found');

      // Find the org AID name from the admin's identifiers
      const orgAidEntry = adminAids.aids.find(
        (a: { prefix: string }) => a.prefix === orgAidPrefix
      );
      if (!orgAidEntry) throw new Error('Organization AID not found in admin identifiers');
      const orgAidId = orgAidEntry.prefix;

      // Find the registry for the org AID
      const registries = await adminSignifyClient.registries().list(orgAidId);
      if (registries.length === 0) throw new Error('No credential registry found for org');
      const registryId = registries[0].regk;

      const credentialData = {
        endorsementType: 'community_endorsement',
        category: 'general',
        claim: config.reason,
        confidence: 'high',
      };

      await adminClient.issueCredential(
        orgAidId,
        registryId,
        ENDORSEMENT_SCHEMA_SAID,
        inviteeAid.prefix,
        credentialData,
        grantMessage
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
