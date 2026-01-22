import { defineStore } from 'pinia';
import { ref, computed } from 'vue';
import { KERIClient, useKERIClient, type AIDInfo } from 'src/lib/keri/client';

export const useIdentityStore = defineStore('identity', () => {
  // State
  const keriClient = useKERIClient();
  const currentAID = ref<AIDInfo | null>(null);
  const passcode = ref<string | null>(null);
  const isConnected = ref(false);
  const isConnecting = ref(false);
  const error = ref<string | null>(null);

  // Computed
  const hasIdentity = computed(() => currentAID.value !== null);
  const aidPrefix = computed(() => currentAID.value?.prefix ?? null);

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
        const aids = await keriClient.listAIDs();
        if (aids.length > 0) {
          currentAID.value = aids[0];
        }
      } catch (listErr) {
        console.warn('[IdentityStore] Could not list AIDs (expected for new users):', listErr);
      }

      // Persist passcode (encrypted in production)
      localStorage.setItem('matou_passcode', bran);

      return true;
    } catch (e) {
      error.value = e instanceof Error ? e.message : 'Connection failed';
      return false;
    } finally {
      isConnecting.value = false;
    }
  }

  async function createIdentity(name: string): Promise<AIDInfo | null> {
    if (!isConnected.value) {
      error.value = 'Not connected to KERIA';
      return null;
    }

    try {
      const aid = await keriClient.createAID(name);
      currentAID.value = aid;
      return aid;
    } catch (e) {
      error.value = e instanceof Error ? e.message : 'AID creation failed';
      return null;
    }
  }

  async function restore(): Promise<boolean> {
    const savedPasscode = localStorage.getItem('matou_passcode');
    if (savedPasscode) {
      return await connect(savedPasscode);
    }
    return false;
  }

  function disconnect() {
    currentAID.value = null;
    passcode.value = null;
    isConnected.value = false;
    localStorage.removeItem('matou_passcode');
  }

  return {
    // State
    currentAID,
    passcode,
    isConnected,
    isConnecting,
    error,

    // Computed
    hasIdentity,
    aidPrefix,

    // Actions
    connect,
    createIdentity,
    restore,
    disconnect,
  };
});
