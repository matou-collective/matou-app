/**
 * Composable for organization setup
 * Creates admin AID, org group AID, registry, and issues initial credential
 */
import { ref } from 'vue';
import { generateMnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english.js';
import { KERIClient, useKERIClient } from 'src/lib/keri/client';
import { saveOrgConfig, type OrgConfig } from 'src/api/config';
import { useOnboardingStore } from 'stores/onboarding';
import { useIdentityStore } from 'stores/identity';

export interface OrgSetupConfig {
  orgName: string;
  adminName: string;
}

export interface OrgSetupResult {
  adminAid: string;
  orgAid: string;
  registryId: string;
  credentialSaid: string;
  mnemonic: string[];
}

// Membership credential schema SAID (from schema server)
// The schema server is accessible from KERIA via Docker network
const MEMBERSHIP_SCHEMA_SAID = 'EOVL3N0K_tYc9U-HXg7r2jDPo4Gnq3ebCjDqbJzl6fsT';
const SCHEMA_OOBI_URL = `http://schema-server:7723/oobi/${MEMBERSHIP_SCHEMA_SAID}`;

export function useOrgSetup() {
  const keriClient = useKERIClient();

  // State
  const isSubmitting = ref(false);
  const error = ref<string | null>(null);
  const progress = ref<string>('');
  const result = ref<OrgSetupResult | null>(null);

  /**
   * Run the complete org setup flow
   * Creates all necessary KERI infrastructure for the organization
   */
  async function setupOrg(config: OrgSetupConfig): Promise<boolean> {
    isSubmitting.value = true;
    error.value = null;
    progress.value = '';

    const onboardingStore = useOnboardingStore();
    const identityStore = useIdentityStore();

    try {
      // Step 1: Generate mnemonic and derive passcode
      progress.value = 'Generating admin credentials...';
      const mnemonic = generateMnemonic(wordlist, 128); // 12 words
      const mnemonicWords = mnemonic.split(' ');
      const adminPasscode = KERIClient.passcodeFromMnemonic(mnemonic);
      console.log('[OrgSetup] Generated mnemonic and derived passcode');

      // Step 2: Initialize KERIA connection (boots agent if new)
      progress.value = 'Connecting to KERIA...';
      await keriClient.initialize(adminPasscode);
      console.log('[OrgSetup] Connected to KERIA');

      // Step 3: Create admin AID (personal identity)
      progress.value = 'Creating admin identity...';
      const adminAidName = `${config.adminName.toLowerCase().replace(/\s+/g, '-')}`;
      const adminAid = await keriClient.createAID(adminAidName);
      console.log('[OrgSetup] Created admin AID:', adminAid.prefix);

      // Store admin AID in identity store for credential polling
      identityStore.setCurrentAID(adminAid);

      // Step 4: Create org AID as group with admin as master
      progress.value = 'Creating organization identity...';
      const orgAidName = config.orgName.toLowerCase().replace(/\s+/g, '-');
      const orgAid = await keriClient.createGroupAID(orgAidName, adminAidName);
      console.log('[OrgSetup] Created org group AID:', orgAid.prefix);

      // Step 5: Create credential registry for the org
      progress.value = 'Creating credential registry...';
      const registryName = `${orgAidName}-registry`;
      const registryId = await keriClient.createRegistry(orgAidName, registryName);
      console.log('[OrgSetup] Created registry:', registryId);

      // Step 6: Resolve schema OOBI
      progress.value = 'Loading credential schema...';
      console.log('[OrgSetup] Resolving schema OOBI:', SCHEMA_OOBI_URL);
      await keriClient.resolveOOBI(SCHEMA_OOBI_URL, MEMBERSHIP_SCHEMA_SAID);
      console.log('[OrgSetup] Schema OOBI resolved');

      // Step 7: Issue membership credential to admin (as Operations Steward)
      progress.value = 'Issuing admin credential...';
      const credentialData = {
        communityName: 'MATOU',
        role: 'Operations Steward',
        verificationStatus: 'identity_verified',
        permissions: [
          'admin_keria',
          'manage_members',
          'approve_registrations',
          'issue_credentials',
          'revoke_credentials',
          'manage_spaces',
          'view_analytics',
        ],
        joinedAt: new Date().toISOString(),
      };

      const credential = await keriClient.issueCredential(
        orgAidName,
        registryId,
        MEMBERSHIP_SCHEMA_SAID,
        adminAid.prefix,
        credentialData
      );
      console.log('[OrgSetup] Issued credential:', credential.said);

      // Step 8: Get org OOBI
      progress.value = 'Generating organization OOBI...';
      let orgOobi: string;
      try {
        orgOobi = await keriClient.getOOBI(orgAidName);
      } catch {
        // Fallback to constructing OOBI URL manually
        orgOobi = `http://localhost:3902/oobi/${orgAid.prefix}`;
        console.log('[OrgSetup] Using fallback OOBI URL:', orgOobi);
      }

      // Step 9: Save config to server (and localStorage cache)
      progress.value = 'Saving configuration...';
      const orgConfig: OrgConfig = {
        organization: {
          aid: orgAid.prefix,
          name: config.orgName,
          oobi: orgOobi,
        },
        admin: {
          aid: adminAid.prefix,
          name: config.adminName,
        },
        registry: {
          id: registryId,
          name: registryName,
        },
        generated: new Date().toISOString(),
      };

      await saveOrgConfig(orgConfig);
      console.log('[OrgSetup] Config saved to server');

      // Step 10: Store admin passcode in localStorage
      localStorage.setItem('matou_passcode', adminPasscode);
      localStorage.setItem('matou_admin_aid', adminAid.prefix);
      localStorage.setItem('matou_org_aid', orgAid.prefix);
      console.log('[OrgSetup] Credentials stored in localStorage');

      // Update the KERI client with the new org AID
      keriClient.setOrgAID(orgAid.prefix);

      // Store mnemonic in onboarding store for display/verification
      onboardingStore.setMnemonic(mnemonicWords);
      onboardingStore.setUserAID(adminAid.prefix);
      onboardingStore.updateProfile({ name: config.adminName });

      // Store result
      result.value = {
        adminAid: adminAid.prefix,
        orgAid: orgAid.prefix,
        registryId,
        credentialSaid: credential.said,
        mnemonic: mnemonicWords,
      };

      progress.value = 'Setup complete!';
      console.log('[OrgSetup] Organization setup complete');

      return true;
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : 'Setup failed';
      console.error('[OrgSetup] Error:', err);
      error.value = errorMsg;
      progress.value = '';
      return false;
    } finally {
      isSubmitting.value = false;
    }
  }

  /**
   * Reset the setup state
   */
  function reset() {
    isSubmitting.value = false;
    error.value = null;
    progress.value = '';
    result.value = null;
  }

  return {
    // State
    isSubmitting,
    error,
    progress,
    result,

    // Actions
    setupOrg,
    reset,
  };
}
