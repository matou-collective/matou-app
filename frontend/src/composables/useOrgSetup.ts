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
import { BACKEND_URL, setBackendIdentity } from 'src/lib/api/client';
import { secureStorage } from 'src/lib/secureStorage';
import { fetchClientConfig } from 'src/lib/clientConfig';

export interface OrgSetupConfig {
  orgName: string;
  adminName: string;
  adminEmail?: string;
  adminAvatar?: string; // fileRef from avatar upload
  adminAvatarPreview?: string; // base64 data URL for UI preview
}

export interface OrgSetupResult {
  adminAid: string;
  orgAid: string;
  registryId: string;
  credentialSaid: string;
  mnemonic: string[];
  communitySpaceId?: string;
  readOnlySpaceId?: string;
  adminSpaceId?: string;
  privateSpaceId?: string;
}

// Membership credential schema SAID (from schema server)
const MEMBERSHIP_SCHEMA_SAID = 'EOVL3N0K_tYc9U-HXg7r2jDPo4Gnq3ebCjDqbJzl6fsT';
// Schema server URL as seen by KERIA inside Docker (fixed internal hostname)
const SCHEMA_SERVER_URL = 'http://schema-server:7723';
const SCHEMA_OOBI_URL = `${SCHEMA_SERVER_URL}/oobi/${MEMBERSHIP_SCHEMA_SAID}`;

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
      const adminAid = await keriClient.createAID(adminAidName, { useWitnesses: true });
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
        const clientCfg = await fetchClientConfig();
        orgOobi = `${clientCfg.keri.cesr_url}/oobi/${orgAid.prefix}`;
        console.log('[OrgSetup] Using fallback OOBI URL:', orgOobi);
      }

      // Step 8b: Get admin OOBI (so users can contact admin for registration)
      let adminOobi: string | undefined;
      try {
        adminOobi = await keriClient.getOOBI(adminAidName);
        console.log('[OrgSetup] Admin OOBI:', adminOobi);
      } catch {
        // Fallback to constructing OOBI URL manually
        const clientCfg = await fetchClientConfig();
        adminOobi = `${clientCfg.keri.cesr_url}/oobi/${adminAid.prefix}`;
        console.log('[OrgSetup] Using fallback admin OOBI URL:', adminOobi);
      }

      // Step 9: Set backend identity (derives peer key from mnemonic, restarts SDK, auto-creates private space)
      // This MUST happen before community space creation so the mnemonic-derived
      // peer key is active and the backend can derive community space keys from it.
      progress.value = 'Configuring backend identity...';
      let adminPrivateSpaceId: string | undefined;

      // Clear any stale identity from a previous org setup run
      await fetch(`${BACKEND_URL}/api/v1/identity`, { method: 'DELETE' }).catch(() => {});

      try {
        const identityResult = await setBackendIdentity({
          aid: adminAid.prefix,
          mnemonic: mnemonic,
          orgAid: orgAid.prefix,
          credentialSaid: credential.said,
          mode: 'claim',
        });
        if (identityResult.success) {
          adminPrivateSpaceId = identityResult.privateSpaceId;
          console.log('[OrgSetup] Backend identity set, peer:', identityResult.peerId,
            'private space:', identityResult.privateSpaceId);
        } else {
          console.warn('[OrgSetup] Backend identity set failed:', identityResult.error);
        }
      } catch (err) {
        console.warn('[OrgSetup] Backend identity configuration deferred:', err);
      }

      // Step 10: Create community space in any-sync
      // Now that identity is set, the backend derives community space keys from the
      // stored mnemonic (DeriveSpaceKeySet index 1), making the admin the recoverable owner.
      progress.value = 'Creating community space...';
      let communitySpaceId: string | undefined;

      let readOnlySpaceId: string | undefined;
      let adminSpaceId: string | undefined;

      try {
        const spaceResponse = await fetch(`${BACKEND_URL}/api/v1/spaces/community`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            orgAid: orgAid.prefix,
            orgName: config.orgName,
            adminAid: adminAid.prefix,
            adminName: config.adminName,
            adminEmail: config.adminEmail,
            adminAvatar: config.adminAvatar,
            credentialSaid: credential.said,
          }),
          signal: AbortSignal.timeout(15000),
        });

        if (spaceResponse.ok) {
          const spaceResult = await spaceResponse.json() as {
            success: boolean;
            communitySpaceId: string;
            readOnlySpaceId: string;
            adminSpaceId: string;
            objects: Array<{ spaceId: string; objectId: string; headId: string; type: string }>;
            spaceId: string; // backward compat
          };
          communitySpaceId = spaceResult.communitySpaceId || spaceResult.spaceId;
          readOnlySpaceId = spaceResult.readOnlySpaceId;
          adminSpaceId = spaceResult.adminSpaceId;
          console.log('[OrgSetup] Created spaces — community:', communitySpaceId,
            'readonly:', readOnlySpaceId, 'admin:', adminSpaceId);
          if (spaceResult.objects?.length) {
            console.log('[OrgSetup] Seeded objects:', spaceResult.objects.map(o => `${o.type}@${o.spaceId}`).join(', '));
          }

          // Update backend identity with the community space ID
          await setBackendIdentity({
            aid: adminAid.prefix,
            mnemonic: mnemonic,
            orgAid: orgAid.prefix,
            communitySpaceId,
            mode: 'claim',
          });
        } else {
          console.warn('[OrgSetup] Failed to create community space:', await spaceResponse.text());
        }
      } catch (err) {
        // Non-fatal error - space can be created later
        console.warn('[OrgSetup] Community space creation deferred:', err);
      }

      // Step 11: Save config to server (single save with space IDs included)
      progress.value = 'Saving configuration...';
      const orgConfig: OrgConfig = {
        organization: {
          aid: orgAid.prefix,
          name: config.orgName,
          oobi: orgOobi,
        },
        admins: [
          {
            aid: adminAid.prefix,
            name: config.adminName,
            oobi: adminOobi,
          },
        ],
        admin: {
          aid: adminAid.prefix,
          name: config.adminName,
        },
        registry: {
          id: registryId,
          name: registryName,
        },
        communitySpaceId,
        readOnlySpaceId,
        adminSpaceId,
        generated: new Date().toISOString(),
      };

      await saveOrgConfig(orgConfig);
      console.log('[OrgSetup] Config saved to server');

      // Step 12: Admin profiles are now seeded by the backend during space creation
      // (type definitions + profiles written to each space's ObjectTree).
      // No additional frontend profile creation needed.
      console.log('[OrgSetup] Admin profiles seeded by backend during space creation');

      // Step 13: Store admin passcode and mnemonic in secure storage
      await secureStorage.setItem('matou_passcode', adminPasscode);
      await secureStorage.setItem('matou_mnemonic', mnemonic);
      await secureStorage.setItem('matou_admin_aid', adminAid.prefix);
      await secureStorage.setItem('matou_org_aid', orgAid.prefix);
      console.log('[OrgSetup] Credentials stored in secure storage');

      // Update the KERI client with the new org AID
      keriClient.setOrgAID(orgAid.prefix);

      // Store mnemonic in onboarding store for display/verification
      onboardingStore.setMnemonic(mnemonicWords);
      onboardingStore.setUserAID(adminAid.prefix);
      onboardingStore.updateProfile({
        name: config.adminName,
        avatarPreview: config.adminAvatarPreview || null,
        avatarFileRef: config.adminAvatar || null,
      });

      // Fetch user spaces into identity store before transitioning to dashboard
      await identityStore.fetchUserSpaces();

      // Store result
      result.value = {
        adminAid: adminAid.prefix,
        orgAid: orgAid.prefix,
        registryId,
        credentialSaid: credential.said,
        mnemonic: mnemonicWords,
        communitySpaceId,
        readOnlySpaceId,
        adminSpaceId,
        privateSpaceId: adminPrivateSpaceId,
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
