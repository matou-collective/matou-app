import { defineStore } from 'pinia';
import { ref, computed } from 'vue';
import { Notify } from 'quasar';
import { KERIClient, useKERIClient, type AIDInfo, type CredentialInfo } from 'src/lib/keri/client';
import { getUserSpaces, verifyCommunityAccess as apiVerifyCommunityAccess, joinCommunity as apiJoinCommunity, getAuthChallenge, postAuthLogin, setSessionToken } from 'src/lib/api/client';
import { secureStorage } from 'src/lib/secureStorage';
import { fetchOrgConfig } from 'src/api/config';
import { useAppStore } from 'stores/app';

export interface AdminCredentialInfo extends CredentialInfo {
  role?: string;
  communityName?: string;
}

export interface RestoreResult {
  success: boolean;
  hasAID: boolean;
  error?: string;
}

export const useIdentityStore = defineStore('identity', () => {
  // State
  const keriClient = useKERIClient();
  const currentAID = ref<AIDInfo | null>(null);
  const passcode = ref<string | null>(null);
  const isConnected = ref(false);
  const isConnecting = ref(false);
  const error = ref<string | null>(null);
  const isInitializing = ref(true);  // True until boot completes
  const initError = ref<string | null>(null);
  const privateSpaceId = ref<string | null>(null);
  const communitySpaceId = ref<string | null>(null);
  const communityReadOnlySpaceId = ref<string | null>(null);
  const adminSpaceId = ref<string | null>(null);
  const privateKeysAvailable = ref(false);
  const communityKeysAvailable = ref(false);
  const spacesLoaded = ref(false);
  const communityAccessVerified = ref(false);
  const communityAccessChecking = ref(false);

  // Admin state (checked once, shared across all pages)
  const isAdmin = ref(false);
  const adminCredential = ref<AdminCredentialInfo | null>(null);
  const adminChecked = ref(false);

  // Admin computed
  const isSteward = computed(() => {
    const role = (adminCredential.value?.role || '').toLowerCase();
    return role.includes('steward') || role.includes('founding member');
  });

  const canManageMembers = computed(() => {
    const role = (adminCredential.value?.role || '').toLowerCase();
    return role.includes('operations steward') || role.includes('founding member');
  });

  // Computed
  const hasIdentity = computed(() => currentAID.value !== null);
  const aidPrefix = computed(() => currentAID.value?.prefix ?? null);
  const isReady = computed(() => !isInitializing.value);

  // Actions
  async function connect(bran: string): Promise<boolean> {
    isConnecting.value = true;
    error.value = null;

    try {
      await keriClient.initialize(bran);
      passcode.value = bran;
      isConnected.value = true;

      // Check for existing AIDs (don't fail if this errors - new users won't have any)
      try {
        // Log the controller/agent info
        const client = keriClient.getSignifyClient();
        if (client) {
          const agent = client.agent;
          console.log('[IdentityStore] Connected as agent/controller:', agent);
        }

        const aids = await keriClient.listAIDs();
        console.log(`[IdentityStore] Found ${aids.length} AID(s) in KERIA`);
        if (aids.length > 0) {
          // Prefer the stored personal admin AID over the org group AID.
          // After org setup there are two AIDs in KERIA (personal + org group);
          // picking aids[0] could land on the org AID and break credential
          // checks — and attribute the user's actions (X-User-AID) to the org.
          // matou_admin_aid is only written during org setup and is lost when
          // browser storage is cleaned, so also exclude the org group AID
          // (known from org config) when falling back.
          const savedAdminAid = await secureStorage.getItem('matou_admin_aid');
          const orgAid = useAppStore().orgAid;
          const fallbackAID = aids.find((a) => a.prefix !== orgAid) ?? aids[0];
          const personalAID = savedAdminAid
            ? aids.find((a) => a.prefix === savedAdminAid) ?? fallbackAID
            : fallbackAID;
          currentAID.value = personalAID;
          console.log('[IdentityStore] Set currentAID to:', personalAID.prefix);
        } else {
          console.log('[IdentityStore] No AIDs found in KERIA for this agent');
        }
      } catch (listErr) {
        console.warn('[IdentityStore] Could not list AIDs (expected for new users):', listErr);
      }

      // Authenticate to the backend via signed-challenge login so RBAC-protected
      // requests carry a cryptographically verified session (issue #18).
      // Best-effort: with enforcement off (dev default) the bare X-User-AID
      // header still works, so a failure here must not block connect.
      await signInToBackend();

      // Surface + repair an agent re-boot: when the agent behind this
      // passcode was re-created, every agent-form OOBI shared before is dead
      // (Andrew Weaver incident). Re-publish the end role so fresh OOBIs
      // resolve, and tell the user once — silently rebooting is how contacts
      // end up unable to reach an identity for months.
      await handleAgentReboot();

      // Persist passcode (encrypted in production)
      await secureStorage.setItem('matou_passcode', bran);

      return true;
    } catch (e) {
      error.value = e instanceof Error ? e.message : 'Connection failed';
      return false;
    } finally {
      isConnecting.value = false;
    }
  }

  /**
   * Handle a detected agent re-creation (see KERIClient.recordAgentLifecycle).
   * For an identity with an AID: re-publish the agent end role (so the new
   * agent serves this AID's OOBI) and show a one-time warning — mirrors the
   * useAdminActions.notifyApprovalWarning pattern. The persisted marker is
   * only cleared once the repair succeeds, so a failed repair retries on the
   * next connect. Never throws: connection must succeed regardless.
   */
  async function handleAgentReboot(): Promise<void> {
    try {
      const reboot = keriClient.getPendingAgentReboot();
      if (!reboot) return;

      if (!currentAID.value) {
        // No AID on this identity yet — nothing was ever shared under the old
        // agent, so there is nothing to repair or announce.
        await keriClient.clearAgentRebootMarker();
        return;
      }

      console.warn(
        `[IdentityStore] Agent was re-created (${reboot.occurredAt}): ` +
        `${reboot.previousAgentAid} → ${reboot.newAgentAid} — re-publishing end role`
      );

      let repairNote = '';
      try {
        await keriClient.republishAgentEndRole(currentAID.value.prefix);
      } catch (endRoleErr) {
        const msg = endRoleErr instanceof Error ? endRoleErr.message : String(endRoleErr);
        repairNote = ` Automatic repair failed (${msg}) — it will be retried next time the app starts.`;
      }

      Notify.create({
        type: 'warning',
        message:
          'Your identity agent was recreated — contacts may need to re-resolve ' +
          `your identity before they can reach you.${repairNote}`,
        timeout: 0,
        actions: [{ label: 'Dismiss', color: 'white' }],
      });

      if (!repairNote) {
        await keriClient.clearAgentRebootMarker();
      }
    } catch (rebootErr) {
      console.warn('[IdentityStore] Agent re-boot handling failed:', rebootErr);
    }
  }

  async function createIdentity(name: string, options?: { useWitnesses?: boolean }): Promise<AIDInfo | null> {
    if (!isConnected.value) {
      error.value = 'Not connected to KERIA';
      return null;
    }

    try {
      // Sanitize name for use as KERIA alias — signify-ts uses the alias
      // directly in URL paths (e.g. /identifiers/{name}/credentials) without
      // encoding, so slashes and other URL-unsafe characters break API calls.
      const safeName = name.replace(/[/\\?#%\s]+/g, '-').replace(/^-|-$/g, '').trim();
      const aid = await keriClient.createAID(safeName, { useWitnesses: options?.useWitnesses ?? false });
      currentAID.value = aid;
      return aid;
    } catch (e) {
      error.value = e instanceof Error ? e.message : 'AID creation failed';
      return null;
    }
  }

  async function restore(): Promise<RestoreResult> {
    const savedPasscode = await secureStorage.getItem('matou_passcode');
    if (!savedPasscode) {
      return { success: false, hasAID: false };
    }

    try {
      const connected = await connect(savedPasscode);
      if (connected) {
        return { success: true, hasAID: currentAID.value !== null };
      }
      return { success: false, hasAID: false, error: error.value || 'Connection failed' };
    } catch (e) {
      const errorMessage = e instanceof Error ? e.message : 'Restore failed';
      return { success: false, hasAID: false, error: errorMessage };
    }
  }

  function setInitialized() {
    isInitializing.value = false;
  }

  function setInitError(err: string | null) {
    initError.value = err;
  }

  /**
   * Check admin status via KERI credentials, org group membership, and config.
   * Called once after login — result is cached for all pages.
   */
  async function checkAdminStatus(): Promise<boolean> {
    // Return cached result if already checked
    if (adminChecked.value) return isAdmin.value;

    const client = keriClient.getSignifyClient();
    if (!client || !currentAID.value) return false;

    try {
      await keriClient.ensureSession();

      // Method 1: Check credentials in wallet
      const credentials = await client.credentials().list();
      console.log('[AdminAccess] Checking credentials:', credentials.length);

      for (const cred of credentials) {
        const credAny = cred as Record<string, unknown>;
        const sad = credAny.sad as Record<string, unknown> | undefined;
        const credData = (sad?.a || sad?.d || {}) as Record<string, unknown>;
        const schemaId = typeof credAny.schema === 'string' ? credAny.schema : (sad?.s as string) || '';
        const statusObj = credAny.status as Record<string, unknown> | undefined;

        const issuee = (credData.i as string) || '';
        if (issuee && issuee !== currentAID.value!.prefix) continue;

        const role = ((credData.role as string) || '').toLowerCase();
        if (role.includes('steward') || role.includes('admin') || role.includes('founding')) {
          console.log('[AdminAccess] Found admin role in credential:', role);
          isAdmin.value = true;
          adminCredential.value = {
            said: (sad?.d as string) || '',
            schema: schemaId,
            issuer: (sad?.i as string) || '',
            issuee: (credData.i as string) || currentAID.value!.prefix,
            status: (statusObj?.s as string) || 'issued',
            role: credData.role as string | undefined,
            communityName: credData.communityName as string | undefined,
          };
          adminChecked.value = true;
          return true;
        }
      }

      // Method 1b: Check org group AID membership
      try {
        const configResult2 = await fetchOrgConfig();
        const orgConfig = configResult2.status === 'configured'
          ? configResult2.config
          : configResult2.status === 'server_unreachable'
            ? configResult2.cached
            : null;

        if (orgConfig?.organization?.aid) {
          const aids = await client.identifiers().list();
          const orgGroupAid = aids.aids?.find(
            (a: { prefix: string }) => a.prefix === orgConfig.organization.aid
          );
          if (orgGroupAid) {
            console.log('[AdminAccess] User is a member of the org group AID');
            isAdmin.value = true;
            adminCredential.value = {
              said: '',
              schema: '',
              issuer: orgConfig.organization.aid,
              issuee: currentAID.value!.prefix,
              status: 'group_member',
              role: 'Community Steward',
            };
            adminChecked.value = true;
            return true;
          }
        }
      } catch (groupErr) {
        console.warn('[AdminAccess] Failed to check org group membership:', groupErr);
      }

      // Method 2: Check config admins list
      const configResult = await fetchOrgConfig();
      if (configResult.status === 'configured' || configResult.status === 'server_unreachable') {
        const config = configResult.status === 'configured'
          ? configResult.config
          : configResult.cached;

        if (config?.admins) {
          const isConfigAdmin = config.admins.some(admin => admin.aid === currentAID.value!.prefix);
          if (isConfigAdmin) {
            console.log('[AdminAccess] User AID found in config admins list');
            isAdmin.value = true;
            adminCredential.value = {
              said: '',
              schema: '',
              issuer: '',
              issuee: currentAID.value!.prefix,
              status: 'config',
              role: 'Founding Member',
            };
            adminChecked.value = true;
            return true;
          }
        }
      }

      console.log('[AdminAccess] User is not an admin');
      isAdmin.value = false;
      adminCredential.value = null;
      adminChecked.value = true;
      return false;
    } catch (err) {
      console.error('[AdminAccess] Error checking admin status:', err);
      isAdmin.value = false;
      adminChecked.value = true;
      return false;
    }
  }

  /** Force re-check admin status (e.g., after multisig join) */
  async function recheckAdminStatus(): Promise<boolean> {
    adminChecked.value = false;
    return checkAdminStatus();
  }

  /**
   * Authenticate to the backend using the signed-challenge flow (issue #18):
   * request a challenge for the current AID, sign it with the AID's key, and
   * exchange the signature for a short-lived session token attached as a Bearer
   * token on subsequent requests. Best-effort and never throws — with signed-auth
   * enforcement off (dev default) the backend still accepts the X-User-AID header.
   */
  async function signInToBackend(): Promise<boolean> {
    const aid = currentAID.value?.prefix;
    if (!aid) return false;
    try {
      const { challenge } = await getAuthChallenge(aid);
      const signature = await keriClient.signChallenge(challenge, aid);
      const { token } = await postAuthLogin(aid, challenge, signature);
      setSessionToken(token);
      console.log('[IdentityStore] Backend session established');
      return true;
    } catch (err) {
      console.warn('[IdentityStore] Backend sign-in failed (continuing unauthenticated):', err);
      setSessionToken(null);
      return false;
    }
  }

  async function disconnect() {
    currentAID.value = null;
    passcode.value = null;
    isConnected.value = false;
    isAdmin.value = false;
    adminCredential.value = null;
    adminChecked.value = false;
    setSessionToken(null);
    await secureStorage.removeItem('matou_passcode');
    await secureStorage.removeItem('matou_mnemonic');
  }

  async function fetchUserSpaces(): Promise<void> {
    if (!currentAID.value?.prefix) return;
    try {
      const spaces = await getUserSpaces(currentAID.value.prefix);
      privateSpaceId.value = spaces.privateSpace?.spaceId ?? null;
      communitySpaceId.value = spaces.communitySpace?.spaceId ?? null;
      communityReadOnlySpaceId.value = spaces.communityReadOnlySpace?.spaceId ?? null;
      adminSpaceId.value = spaces.adminSpace?.spaceId ?? null;
      privateKeysAvailable.value = spaces.privateSpace?.keysAvailable ?? false;
      communityKeysAvailable.value = spaces.communitySpace?.keysAvailable ?? false;
      spacesLoaded.value = true;
      console.log('[IdentityStore] Spaces loaded:', {
        private: privateSpaceId.value,
        community: communitySpaceId.value,
        communityReadOnly: communityReadOnlySpaceId.value,
        admin: adminSpaceId.value,
        privateKeys: privateKeysAvailable.value,
        communityKeys: communityKeysAvailable.value,
      });
    } catch (err) {
      console.warn('[IdentityStore] Failed to fetch user spaces:', err);
    }
  }

  async function verifyCommunityAccess(): Promise<boolean> {
    if (!currentAID.value?.prefix) return false;
    communityAccessChecking.value = true;
    try {
      const result = await apiVerifyCommunityAccess(currentAID.value.prefix);
      communityAccessVerified.value = result.hasAccess;
      if (result.spaceId) communitySpaceId.value = result.spaceId;
      return result.hasAccess;
    } catch {
      return false;
    } finally {
      communityAccessChecking.value = false;
    }
  }

  async function joinCommunitySpace(params: {
    inviteKey: string;
    spaceId?: string;
    readOnlyInviteKey?: string;
    readOnlySpaceId?: string;
  }): Promise<boolean> {
    if (!currentAID.value?.prefix) return false;
    try {
      const result = await apiJoinCommunity({
        userAid: currentAID.value.prefix,
        inviteKey: params.inviteKey,
        spaceId: params.spaceId,
        readOnlyInviteKey: params.readOnlyInviteKey,
        readOnlySpaceId: params.readOnlySpaceId,
      });
      if (result.success) {
        communityAccessVerified.value = true;
        if (result.spaceId) communitySpaceId.value = result.spaceId;
      }
      return result.success;
    } catch {
      return false;
    }
  }

  /**
   * Set the current AID directly (used by org setup)
   */
  function setCurrentAID(aid: AIDInfo) {
    currentAID.value = aid;
  }

  return {
    // State
    currentAID,
    passcode,
    isConnected,
    isConnecting,
    error,
    isInitializing,
    initError,
    privateSpaceId,
    communitySpaceId,
    communityReadOnlySpaceId,
    adminSpaceId,
    privateKeysAvailable,
    communityKeysAvailable,
    spacesLoaded,
    communityAccessVerified,
    communityAccessChecking,

    // Admin state
    isAdmin,
    adminCredential,
    adminChecked,
    isSteward,
    canManageMembers,

    // Computed
    hasIdentity,
    aidPrefix,
    isReady,

    // Actions
    connect,
    createIdentity,
    restore,
    signInToBackend,
    disconnect,
    setInitialized,
    setInitError,
    setCurrentAID,
    fetchUserSpaces,
    verifyCommunityAccess,
    joinCommunitySpace,
    checkAdminStatus,
    recheckAdminStatus,
  };
});
