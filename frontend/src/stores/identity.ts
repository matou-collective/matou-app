import { defineStore } from 'pinia';
import { ref, computed } from 'vue';
import { KERIClient, useKERIClient, type AIDInfo } from 'src/lib/keri/client';
import { getUserSpaces, verifyCommunityAccess as apiVerifyCommunityAccess, joinCommunity as apiJoinCommunity } from 'src/lib/api/client';
import { secureStorage } from 'src/lib/secureStorage';

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
        console.log('[IdentityStore] Listed AIDs from KERIA:', JSON.stringify(aids, null, 2));
        if (aids.length > 0) {
          currentAID.value = aids[0];
          console.log('[IdentityStore] Set currentAID to:', aids[0].prefix);
        } else {
          console.log('[IdentityStore] No AIDs found in KERIA for this agent');
        }
      } catch (listErr) {
        console.warn('[IdentityStore] Could not list AIDs (expected for new users):', listErr);
      }

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

  async function createIdentity(name: string, options?: { useWitnesses?: boolean }): Promise<AIDInfo | null> {
    if (!isConnected.value) {
      error.value = 'Not connected to KERIA';
      return null;
    }

    try {
      // Create AID (witnesses can be enabled later for production)
      const aid = await keriClient.createAID(name, { useWitnesses: options?.useWitnesses ?? false });
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

  async function disconnect() {
    currentAID.value = null;
    passcode.value = null;
    isConnected.value = false;
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

    // Computed
    hasIdentity,
    aidPrefix,
    isReady,

    // Actions
    connect,
    createIdentity,
    restore,
    disconnect,
    setInitialized,
    setInitError,
    setCurrentAID,
    fetchUserSpaces,
    verifyCommunityAccess,
    joinCommunitySpace,
  };
});
