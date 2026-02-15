/**
 * Composable for IPEX grant polling and credential admission
 * Handles the flow: poll for grants → admit credential → poll for credential in wallet
 */
import { ref, computed, onUnmounted } from 'vue';
import { useKERIClient } from 'src/lib/keri/client';
import { useIdentityStore } from 'stores/identity';
import { fetchOrgConfig } from 'src/api/config';
import { BACKEND_URL } from 'src/lib/api/client';
import { secureStorage } from 'src/lib/secureStorage';

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

  // Space invite state
  const spaceInviteReceived = ref(false);
  const spaceInviteKey = ref<string | null>(null);
  const spaceId = ref<string | null>(null);
  const readOnlyInviteKey = ref<string | null>(null);
  const readOnlySpaceId = ref<string | null>(null);

  // Rejection and message state
  const rejectionReceived = ref(false);
  const rejectionInfo = ref<RejectionInfo | null>(null);
  const adminMessages = ref<AdminMessage[]>([]);

  // Internal state
  let pollingTimer: ReturnType<typeof setInterval> | null = null;
  let isProcessingGrant = false;

  // Rejection persistence (keyed by AID)
  const rejectionStorageKey = computed(() => {
    const aid = identityStore.currentAID?.prefix;
    return aid ? `matou_rejection_${aid}` : null;
  });

  /**
   * Save rejection state to secure storage
   */
  async function saveRejectionState(): Promise<void> {
    if (!rejectionStorageKey.value || !rejectionInfo.value) return;

    try {
      const data = {
        reason: rejectionInfo.value.reason,
        declinedAt: rejectionInfo.value.declinedAt,
        savedAt: new Date().toISOString(),
      };
      await secureStorage.setItem(rejectionStorageKey.value, JSON.stringify(data));
      console.log('[CredentialPolling] Rejection state saved');
    } catch (err) {
      console.warn('[CredentialPolling] Failed to save rejection state:', err);
    }
  }

  /**
   * Load rejection state from secure storage
   * Returns true if rejection state was found and restored
   */
  async function loadRejectionState(): Promise<boolean> {
    if (!rejectionStorageKey.value) return false;

    try {
      const raw = await secureStorage.getItem(rejectionStorageKey.value);
      if (!raw) return false;

      const data = JSON.parse(raw);
      rejectionReceived.value = true;
      rejectionInfo.value = {
        reason: data.reason || 'Your registration has been declined.',
        declinedAt: data.declinedAt || data.savedAt || new Date().toISOString(),
      };
      console.log('[CredentialPolling] Rejection state restored from storage');
      return true;
    } catch (err) {
      console.warn('[CredentialPolling] Failed to load rejection state:', err);
      return false;
    }
  }

  /**
   * Clear rejection state from secure storage
   */
  async function clearRejectionState(): Promise<void> {
    if (!rejectionStorageKey.value) return;
    await secureStorage.removeItem(rejectionStorageKey.value);
  }

  /**
   * Get the current AID name for IPEX operations
   */
  function getAIDName(): string | null {
    const aid = identityStore.currentAID;
    return aid?.prefix ?? null;
  }

  /**
   * Resolve org and admin OOBIs so we can receive messages from them
   * This is essential for receiving decline/message notifications
   */
  async function resolveOrgOobis(): Promise<void> {
    console.log('[CredentialPolling] Resolving org OOBIs...');
    try {
      const configResult = await fetchOrgConfig();
      console.log('[CredentialPolling] Config result status:', configResult.status);
      const config = configResult.status === 'configured'
        ? configResult.config
        : configResult.status === 'server_unreachable'
          ? configResult.cached
          : null;

      if (!config) {
        console.log('[CredentialPolling] No org config available for OOBI resolution');
        return;
      }

      // Resolve schema OOBI (required for credential verification)
      // The schema SAID is defined in the org setup
      const schemaOOBI = config.schema?.oobi;
      if (schemaOOBI) {
        try {
          await keriClient.resolveOOBI(schemaOOBI, undefined, 10000);
          console.log('[CredentialPolling] Resolved schema OOBI:', schemaOOBI.slice(0, 50) + '...');
        } catch (err) {
          console.log('[CredentialPolling] Could not resolve schema OOBI:', err);
        }
      } else {
        // Fallback: try default schema server URL with known schema SAID
        const MEMBERSHIP_SCHEMA_SAID = 'EOVL3N0K_tYc9U-HXg7r2jDPo4Gnq3ebCjDqbJzl6fsT';
        // Schema server URL is internal to Docker network (KERIA resolves it)
        const schemaServerUrl = 'http://schema-server:7723';
        const fallbackSchemaOOBI = `${schemaServerUrl}/oobi/${MEMBERSHIP_SCHEMA_SAID}`;
        try {
          await keriClient.resolveOOBI(fallbackSchemaOOBI, undefined, 10000);
          console.log('[CredentialPolling] Resolved schema OOBI (fallback):', fallbackSchemaOOBI);
        } catch (err) {
          console.log('[CredentialPolling] Could not resolve schema OOBI:', err);
        }
      }

      // Resolve org OOBI (for receiving credentials)
      // The org OOBI is stored at config.organization.oobi
      const orgOOBI = config.organization?.oobi;
      if (orgOOBI) {
        try {
          await keriClient.resolveOOBI(orgOOBI, undefined, 10000);
          console.log('[CredentialPolling] Resolved org OOBI:', orgOOBI.slice(0, 50) + '...');
        } catch (err) {
          console.log('[CredentialPolling] Could not resolve org OOBI:', err);
        }
      } else {
        console.log('[CredentialPolling] No org OOBI found in config');
      }

      // Resolve admin OOBIs (for receiving messages/rejections)
      if (config.admins?.length) {
        for (const admin of config.admins) {
          if (admin.oobi) {
            try {
              await keriClient.resolveOOBI(admin.oobi, undefined, 5000);
              console.log(`[CredentialPolling] Resolved admin OOBI: ${admin.aid?.slice(0, 12)}...`);
            } catch (err) {
              console.log(`[CredentialPolling] Could not resolve admin OOBI: ${err}`);
            }
          }
        }
      }
    } catch (err) {
      console.warn('[CredentialPolling] Failed to resolve org OOBIs:', err);
    }
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
      if (!credentialReceived.value) {
        try {
          const credentials = await client.credentials().list();
          console.log('[CredentialPolling] Existing credentials check:', credentials.length);
          if (credentials.length > 0) {
            console.log('[CredentialPolling] Credential already in wallet:', credentials[0]);
            credential.value = credentials[0];
            credentialReceived.value = true;
            grantReceived.value = true;
            syncCredentialToBackend();
            // Don't stop polling — still need to wait for space invite
          }
        } catch (credErr) {
          console.log('[CredentialPolling] Could not check credentials:', credErr);
        }
      }

      // Check notifications for grants, invites, rejections, and messages
      const notifications = await client.notifications().list();
      console.log('[CredentialPolling] Raw notifications response:', JSON.stringify(notifications, null, 2));

      // Check for grant notifications (only if credential not yet received)
      if (!credentialReceived.value) {
        const grants = notifications.notes?.filter(
          (n: IPEXNotification) => n.a?.r === '/exn/ipex/grant' && !n.r
        ) ?? [];

        console.log('[CredentialPolling] Filtered grants:', grants.length, grants);

        if (grants.length > 0) {
          console.log('[CredentialPolling] Grant detected:', grants[0]);
          grantReceived.value = true;
          isProcessingGrant = true;

          // Extract space invite data from grant message (embedded by admin)
          const grantMsg = grants[0].a?.m;
          if (grantMsg && !spaceInviteReceived.value) {
            try {
              const inviteData = JSON.parse(grantMsg);
              if (inviteData.type === 'space_invite' && inviteData.inviteKey) {
                console.log('[CredentialPolling] Space invite found in grant message:', inviteData);
                spaceInviteReceived.value = true;
                spaceInviteKey.value = inviteData.inviteKey;
                spaceId.value = inviteData.spaceId || null;
                readOnlyInviteKey.value = inviteData.readOnlyInviteKey || null;
                readOnlySpaceId.value = inviteData.readOnlySpaceId || null;
              }
            } catch {
              // Not JSON or not invite data — ignore
            }
          }

          try {
            await admitGrant(grants[0]);
            // After admitting, poll for credential to appear in wallet
            await pollForCredential();
          } finally {
            isProcessingGrant = false;
          }
        }
      }

      // Check for rejection notifications (both unread AND read as fallback)
      // This ensures we detect rejections even after session restart when notification was already marked read
      const allRejections = notifications.notes?.filter(
        (n: IPEXNotification) => n.a?.r === '/exn/matou/registration/decline'
      ) ?? [];
      const unreadRejections = allRejections.filter((n: IPEXNotification) => !n.r);

      // Process unread rejections first, fall back to read rejections if no unread
      const rejectionsToProcess = unreadRejections.length > 0 ? unreadRejections : allRejections;

      if (rejectionsToProcess.length > 0 && !rejectionReceived.value) {
        console.log('[CredentialPolling] Rejection detected:', rejectionsToProcess[0], 'isRead:', rejectionsToProcess[0].r);
        try {
          const rejectionExn = await client.exchanges().get(rejectionsToProcess[0].a.d);
          const payload = rejectionExn.exn.a || {};
          rejectionReceived.value = true;
          rejectionInfo.value = {
            reason: (payload.reason as string) || 'Your registration has been declined.',
            declinedAt: (payload.declinedAt as string) || new Date().toISOString(),
          };
          // Mark as read if not already
          if (!rejectionsToProcess[0].r) {
            await client.notifications().mark(rejectionsToProcess[0].i);
          }
          // Persist rejection state for future sessions
          await saveRejectionState();
          stopPolling();
        } catch (rejErr) {
          console.warn('[CredentialPolling] Failed to fetch rejection details:', rejErr);
        }
      }

      // Check for message notifications
      const messages = notifications.notes?.filter(
        (n: IPEXNotification) => n.a?.r === '/exn/matou/registration/message' && !n.r
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

      // Check for space invite notifications
      const spaceInvites = notifications.notes?.filter(
        (n: IPEXNotification) => n.a?.r === '/exn/matou/space/invite' && !n.r
      ) ?? [];

      if (spaceInvites.length > 0 && !spaceInviteReceived.value) {
        try {
          const inviteExn = await client.exchanges().get(spaceInvites[0].a.d);
          const payload = inviteExn.exn.a || {};
          spaceInviteReceived.value = true;
          spaceInviteKey.value = payload.inviteKey as string;
          spaceId.value = payload.spaceId as string;
          readOnlyInviteKey.value = (payload.readOnlyInviteKey as string) || null;
          readOnlySpaceId.value = (payload.readOnlySpaceId as string) || null;
          await client.notifications().mark(spaceInvites[0].i);
          console.log('[CredentialPolling] Space invite received');
        } catch (inviteErr) {
          console.warn('[CredentialPolling] Failed to fetch space invite:', inviteErr);
        }
      }

      // Stop polling once both credential and space invite have been received
      if (credentialReceived.value && spaceInviteReceived.value) {
        console.log('[CredentialPolling] Both credential and space invite received — stopping');
        stopPolling();
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
      // Get the grant exchange message to find the sender
      const grantExn = await client.exchanges().get(grant.a.d);
      const grantSender = grantExn.exn.i; // Issuer of the grant message

      // Submit admit with empty embeds. KERIA's sendAdmit() for single-sig
      // AIDs does not process path labels — the Admitter background task
      // retrieves ACDC/ISS/ANC data from the GRANT's cloned attachments.
      const hab = await client.identifiers().get(aidName);
      const [admit, sigs, atc] = await client.exchanges().createExchangeMessage(
        hab,
        '/ipex/admit',
        { m: '' },
        {},
        grantSender,
        undefined,
        grant.a.d,
      );

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
    console.log('[CredentialPolling] Starting pollForCredential...');
    const client = keriClient.getSignifyClient();
    if (!client) {
      console.warn('[CredentialPolling] No client available for credential polling');
      return;
    }

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
          // Sync to backend for space routing (non-blocking)
          syncCredentialToBackend();
          return true;
        }
      } catch (err) {
        console.warn('[CredentialPolling] Credential check error:', err);
      }
      return false;
    };

    // Check immediately first
    if (await checkCredential()) {
      return; // Don't stop polling — space invite may still be pending
    }

    // Then poll with interval
    console.log('[CredentialPolling] Starting credential poll loop...');
    return new Promise((resolve) => {
      const credentialTimer = setInterval(async () => {
        attempts++;
        console.log(`[CredentialPolling] Polling attempt ${attempts}/${maxAttempts}...`);

        if (await checkCredential()) {
          clearInterval(credentialTimer);
          resolve(); // Don't stop polling — space invite may still be pending
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
  async function startPolling(): Promise<void> {
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

    // Check for persisted rejection state first (fast path)
    const wasRejected = await loadRejectionState();
    if (wasRejected) {
      console.log('[CredentialPolling] Registration was previously rejected - not polling');
      return;
    }

    isPolling.value = true;
    error.value = null;
    consecutiveErrors.value = 0;

    // Resolve org/admin OOBIs so we can receive messages from them
    await resolveOrgOobis();

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

  /**
   * Sync credential to backend for space routing
   * This triggers RouteCredential() which syncs to both private and community spaces
   */
  async function syncCredentialToBackend(): Promise<void> {
    const currentAID = identityStore.currentAID;
    if (!currentAID || !credential.value) {
      console.log('[CredentialPolling] No AID or credential to sync');
      return;
    }

    try {
      // Map the signify-ts credential to the backend's keri.Credential format
      const sad = credential.value.sad || credential.value;
      const backendCredential = {
        said: sad.d || '',
        issuer: sad.i || '',
        recipient: sad.a?.i || currentAID.prefix,
        schema: sad.s || '',
        data: {
          communityName: sad.a?.communityName || '',
          role: sad.a?.role || '',
          verificationStatus: sad.a?.verificationStatus || 'unverified',
          permissions: sad.a?.permissions || [],
          joinedAt: sad.a?.joinedAt || new Date().toISOString(),
        },
      };

      const syncResponse = await fetch(`${BACKEND_URL}/api/v1/sync/credentials`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          userAid: currentAID.prefix,
          credentials: [backendCredential],
        }),
        signal: AbortSignal.timeout(15000),
      });

      if (syncResponse.ok) {
        const syncResult = await syncResponse.json() as { synced: number; spaces: string[] };
        console.log('[CredentialPolling] Credential synced to backend:', syncResult);
      } else {
        console.warn('[CredentialPolling] Backend sync failed:', await syncResponse.text());
      }
    } catch (err) {
      // Non-fatal - credential is in KERIA wallet, sync can be retried later
      console.warn('[CredentialPolling] Backend sync deferred:', err);
    }
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
    spaceInviteReceived,
    spaceInviteKey,
    spaceId,
    readOnlyInviteKey,
    readOnlySpaceId,
    rejectionReceived,
    rejectionInfo,
    adminMessages,

    // Actions
    startPolling,
    stopPolling,
    retry,
    clearRejectionState,
  };
}
