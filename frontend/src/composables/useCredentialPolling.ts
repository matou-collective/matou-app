/**
 * Composable for IPEX grant polling and credential admission
 * Handles the flow: poll for grants → admit credential → poll for credential in wallet
 */
import { ref, onUnmounted } from 'vue';
import { useKERIClient } from 'src/lib/keri/client';
import { useIdentityStore } from 'stores/identity';

export interface CredentialPollingOptions {
  pollingInterval?: number; // Default: 5000ms
  maxConsecutiveErrors?: number; // Default: 5
}

export interface IPEXNotification {
  i: string; // Notification ID
  a: {
    r: string; // Route (e.g., '/exn/ipex/grant')
    d: string; // SAID of the grant
    i?: string; // Sender AID (optional)
  };
  r: boolean; // Read status
}

export interface AdminMessage {
  id: string;
  content: string;
  sentAt: string;
  senderAid?: string;
}

export interface RejectionInfo {
  reason: string;
  declinedAt: string;
}

export function useCredentialPolling(options: CredentialPollingOptions = {}) {
  const { pollingInterval = 5000, maxConsecutiveErrors = 5 } = options;

  const keriClient = useKERIClient();
  const identityStore = useIdentityStore();

  // State
  const isPolling = ref(false);
  const error = ref<string | null>(null);
  const grantReceived = ref(false);
  const credentialReceived = ref(false);
  const credential = ref<any | null>(null);
  const consecutiveErrors = ref(0);

  // Rejection and message state
  const rejectionReceived = ref(false);
  const rejectionInfo = ref<RejectionInfo | null>(null);
  const adminMessages = ref<AdminMessage[]>([]);

  // Internal state
  let pollingTimer: ReturnType<typeof setInterval> | null = null;
  let isProcessingGrant = false;

  /**
   * Get the current AID name for IPEX operations
   */
  function getAIDName(): string | null {
    const aid = identityStore.currentAID;
    return aid?.name ?? null;
  }

  /**
   * Poll for IPEX grant notifications or existing credentials
   */
  async function pollForGrants(): Promise<void> {
    if (isProcessingGrant) return;

    const client = keriClient.getSignifyClient();
    if (!client) {
      console.warn('[CredentialPolling] SignifyClient not available');
      return;
    }

    try {
      // First, check if credentials are already in the wallet
      // This handles the case where admin issues credential to themselves (same agent)
      try {
        const credentials = await client.credentials().list();
        console.log('[CredentialPolling] Existing credentials check:', credentials.length);
        if (credentials.length > 0) {
          console.log('[CredentialPolling] Credential already in wallet:', credentials[0]);
          credential.value = credentials[0];
          credentialReceived.value = true;
          grantReceived.value = true; // Mark grant as received too
          stopPolling();
          return;
        }
      } catch (credErr) {
        console.log('[CredentialPolling] Could not check credentials:', credErr);
      }

      // If no credentials, check for grant notifications
      const notifications = await client.notifications().list();
      console.log('[CredentialPolling] Raw notifications response:', JSON.stringify(notifications, null, 2));

      // Check for grant notifications
      const grants = notifications.notes?.filter(
        (n: IPEXNotification) => n.a?.r === '/exn/ipex/grant' && !n.r
      ) ?? [];

      console.log('[CredentialPolling] Filtered grants:', grants.length, grants);

      if (grants.length > 0) {
        console.log('[CredentialPolling] Grant detected:', grants[0]);
        grantReceived.value = true;
        isProcessingGrant = true;

        try {
          await admitGrant(grants[0]);
          // After admitting, start polling for credential
          await pollForCredential();
        } finally {
          isProcessingGrant = false;
        }
      }

      // Check for rejection notifications
      const rejections = notifications.notes?.filter(
        (n: IPEXNotification) => n.a?.r === '/matou/registration/decline' && !n.r
      ) ?? [];

      if (rejections.length > 0 && !rejectionReceived.value) {
        console.log('[CredentialPolling] Rejection detected:', rejections[0]);
        try {
          const rejectionExn = await client.exchanges().get(rejections[0].a.d);
          const payload = rejectionExn.exn.a || {};
          rejectionReceived.value = true;
          rejectionInfo.value = {
            reason: (payload.reason as string) || 'Your registration has been declined.',
            declinedAt: (payload.declinedAt as string) || new Date().toISOString(),
          };
          // Mark as read
          await client.notifications().mark(rejections[0].i);
          stopPolling();
        } catch (rejErr) {
          console.warn('[CredentialPolling] Failed to fetch rejection details:', rejErr);
        }
      }

      // Check for message notifications
      const messages = notifications.notes?.filter(
        (n: IPEXNotification) => n.a?.r === '/matou/registration/message' && !n.r
      ) ?? [];

      for (const msgNotification of messages) {
        try {
          const msgExn = await client.exchanges().get(msgNotification.a.d);
          const payload = msgExn.exn.a || {};

          // Check if we already have this message
          const existingIds = adminMessages.value.map(m => m.id);
          if (!existingIds.includes(msgNotification.a.d)) {
            adminMessages.value.push({
              id: msgNotification.a.d,
              content: (payload.content as string) || '',
              sentAt: (payload.sentAt as string) || new Date().toISOString(),
              senderAid: msgExn.exn.i,
            });
            console.log('[CredentialPolling] New admin message received');
          }

          // Mark as read
          await client.notifications().mark(msgNotification.i);
        } catch (msgErr) {
          console.warn('[CredentialPolling] Failed to fetch message:', msgErr);
        }
      }

      // Reset error counter on successful poll
      consecutiveErrors.value = 0;
      error.value = null;
    } catch (err) {
      consecutiveErrors.value++;
      console.error('[CredentialPolling] Poll error:', err);

      if (consecutiveErrors.value >= maxConsecutiveErrors) {
        error.value = `Failed to poll for credentials after ${maxConsecutiveErrors} attempts. Please check your connection.`;
        stopPolling();
      }
    }
  }

  /**
   * Admit an IPEX grant
   */
  async function admitGrant(grant: IPEXNotification): Promise<void> {
    const client = keriClient.getSignifyClient();
    if (!client) {
      throw new Error('SignifyClient not available');
    }

    const aidName = getAIDName();
    if (!aidName) {
      throw new Error('No AID found');
    }

    console.log('[CredentialPolling] Admitting grant:', grant.a.d);

    try {
      // Get the grant exchange message to find the sender (who we need to send admit to)
      const grantExn = await client.exchanges().get(grant.a.d);
      const grantSender = grantExn.exn.i; // Issuer of the grant message

      // Create admit message using the IpexAdmitArgs interface
      const [admit, sigs, atc] = await client.ipex().admit({
        senderName: aidName,
        recipient: grantSender,
        message: '',
        grantSaid: grant.a.d,
      });

      // Submit the admit
      await client.ipex().submitAdmit(aidName, admit, sigs, atc, [grantSender]);

      // Mark notification as read
      await client.notifications().mark(grant.i);

      console.log('[CredentialPolling] Grant admitted successfully');
    } catch (err) {
      console.error('[CredentialPolling] Failed to admit grant:', err);
      throw err;
    }
  }

  /**
   * Poll for credential in wallet after admitting
   */
  async function pollForCredential(): Promise<void> {
    const client = keriClient.getSignifyClient();
    if (!client) return;

    // Poll with shorter interval for credential arrival
    const credentialPollInterval = 2000;
    const maxAttempts = 30; // 60 seconds max
    let attempts = 0;

    const checkCredential = async (): Promise<boolean> => {
      try {
        const credentials = await client.credentials().list();
        if (credentials.length > 0) {
          console.log('[CredentialPolling] Credential received:', credentials[0]);
          credential.value = credentials[0];
          credentialReceived.value = true;
          return true;
        }
      } catch (err) {
        console.warn('[CredentialPolling] Credential check error:', err);
      }
      return false;
    };

    // Check immediately first
    if (await checkCredential()) {
      stopPolling();
      return;
    }

    // Then poll with interval
    return new Promise((resolve) => {
      const credentialTimer = setInterval(async () => {
        attempts++;

        if (await checkCredential()) {
          clearInterval(credentialTimer);
          stopPolling();
          resolve();
          return;
        }

        if (attempts >= maxAttempts) {
          clearInterval(credentialTimer);
          console.warn('[CredentialPolling] Credential not received within timeout');
          error.value = 'Credential not received. Please try again later.';
          resolve();
        }
      }, credentialPollInterval);
    });
  }

  /**
   * Start polling for grants
   */
  function startPolling(): void {
    if (isPolling.value) return;

    const client = keriClient.getSignifyClient();
    const aidName = getAIDName();
    console.log('[CredentialPolling] Starting polling...', {
      hasClient: !!client,
      isConnected: client ? 'connected' : 'not connected',
      aidName,
      currentAID: identityStore.currentAID,
    });

    if (!client) {
      console.warn('[CredentialPolling] No SignifyClient available - cannot poll');
      error.value = 'Not connected to KERIA. Please refresh the page.';
      return;
    }

    if (!aidName) {
      console.warn('[CredentialPolling] No AID name available - cannot poll');
      error.value = 'No identity found. Please complete registration first.';
      return;
    }

    isPolling.value = true;
    error.value = null;
    consecutiveErrors.value = 0;

    // Poll immediately
    pollForGrants();

    // Then poll at interval
    pollingTimer = setInterval(() => {
      pollForGrants();
    }, pollingInterval);
  }

  /**
   * Stop polling
   */
  function stopPolling(): void {
    if (pollingTimer) {
      clearInterval(pollingTimer);
      pollingTimer = null;
    }
    isPolling.value = false;
    console.log('[CredentialPolling] Polling stopped');
  }

  /**
   * Retry after error
   */
  function retry(): void {
    error.value = null;
    consecutiveErrors.value = 0;
    startPolling();
  }

  // Cleanup on unmount
  onUnmounted(() => {
    stopPolling();
  });

  return {
    // State
    isPolling,
    error,
    grantReceived,
    credentialReceived,
    credential,
    rejectionReceived,
    rejectionInfo,
    adminMessages,

    // Actions
    startPolling,
    stopPolling,
    retry,
  };
}
