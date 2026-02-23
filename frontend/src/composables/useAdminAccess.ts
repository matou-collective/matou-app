/**
 * Composable for checking admin access based on credentials.
 * Determines if the current user has admin privileges for registration approval.
 *
 * Admin detection methods (in priority order):
 * 1. Credential role field — matches steward/admin/founding roles
 * 2. Org group AID membership — user participates in multisig group
 * 3. Config admins list — user AID listed in org config
 */
import { ref, computed } from 'vue';
import { useKERIClient, CredentialInfo } from 'src/lib/keri/client';
import { useIdentityStore } from 'stores/identity';
import { fetchOrgConfig } from 'src/api/config';

export interface AdminCredentialInfo extends CredentialInfo {
  role?: string;
  communityName?: string;
}

export function useAdminAccess() {
  const keriClient = useKERIClient();
  const identityStore = useIdentityStore();

  // State
  const isAdmin = ref(false);
  const adminCredential = ref<AdminCredentialInfo | null>(null);
  const isChecking = ref(false);
  const error = ref<string | null>(null);

  // Computed — admin status implies approval rights
  const canApproveRegistrations = computed(() => isAdmin.value);

  // Check if user has a role that can manage members (update roles)
  const canManageMembers = computed(() => {
    const role = (adminCredential.value?.role || '').toLowerCase();
    return role.includes('operations steward') || role.includes('founding member');
  });

  // Check if user has any steward/admin role
  const isSteward = computed(() => {
    const role = (adminCredential.value?.role || '').toLowerCase();
    return role.includes('steward') || role.includes('founding member');
  });

  /**
   * Check if the current user has admin status.
   * Checks credential roles, org group membership, and config admins list.
   */
  async function checkAdminStatus(): Promise<boolean> {
    const client = keriClient.getSignifyClient();
    if (!client) {
      console.warn('[AdminAccess] SignifyClient not available');
      error.value = 'Not connected to KERIA';
      return false;
    }

    const currentAID = identityStore.currentAID;
    if (!currentAID) {
      console.warn('[AdminAccess] No current AID');
      error.value = 'No identity found';
      return false;
    }

    isChecking.value = true;
    error.value = null;

    try {
      // Ensure KERIA session is fresh before making credential queries
      await keriClient.ensureSession();

      // Method 1: Check credentials in wallet
      // NOTE: client.credentials().list() returns ALL credentials KERIA knows about,
      // including chained credentials from ACDC edges (e.g., the admin's membership
      // credential pulled in when admitting an endorsement or attendance credential).
      // We must check the issuee field (sad.a.i) matches our AID to avoid treating
      // someone else's credential as ours.
      const credentials = await client.credentials().list();
      console.log('[AdminAccess] Checking credentials:', credentials.length);

      for (const cred of credentials) {
        // Use type assertions for flexible access to credential properties
        const credAny = cred as Record<string, unknown>;
        const sad = credAny.sad as Record<string, unknown> | undefined;
        const credData = (sad?.a || sad?.d || {}) as Record<string, unknown>;
        const schemaId = typeof credAny.schema === 'string' ? credAny.schema : (sad?.s as string) || '';
        const statusObj = credAny.status as Record<string, unknown> | undefined;

        // Only consider credentials issued TO the current user.
        // KERIA stores chained ACDC credentials (from edge resolution) that belong
        // to other users — skip those to prevent false admin detection.
        const issuee = (credData.i as string) || '';
        if (issuee && issuee !== currentAID.prefix) continue;

        // Check for role field indicating admin/steward
        const role = ((credData.role as string) || '').toLowerCase();
        if (role.includes('steward') || role.includes('admin') || role.includes('founding')) {
          console.log('[AdminAccess] Found admin role in credential:', role);
          isAdmin.value = true;
          adminCredential.value = {
            said: (sad?.d as string) || '',
            schema: schemaId,
            issuer: (sad?.i as string) || '',
            issuee: (credData.i as string) || currentAID.prefix,
            status: (statusObj?.s as string) || 'issued',
            role: credData.role as string | undefined,
            communityName: credData.communityName as string | undefined,
          };
          return true;
        }
      }

      // Method 1b: Check if user participates in the org group AID
      // After multisig join, the org AID appears in identifiers list
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
              issuee: currentAID.prefix,
              status: 'group_member',
              role: 'Community Steward',
            };
            return true;
          }
        }
      } catch (groupErr) {
        console.warn('[AdminAccess] Failed to check org group membership:', groupErr);
      }

      // Method 2: Check if user's AID is in org config admins list
      const configResult = await fetchOrgConfig();
      if (configResult.status === 'configured' || configResult.status === 'server_unreachable') {
        const config = configResult.status === 'configured'
          ? configResult.config
          : configResult.cached;

        if (config?.admins) {
          const isConfigAdmin = config.admins.some(admin => admin.aid === currentAID.prefix);
          if (isConfigAdmin) {
            console.log('[AdminAccess] User AID found in config admins list');
            isAdmin.value = true;
            adminCredential.value = {
              said: '',
              schema: '',
              issuer: '',
              issuee: currentAID.prefix,
              status: 'config',
              role: 'Founding Member',
            };
            return true;
          }
        }
      }

      console.log('[AdminAccess] User is not an admin');
      isAdmin.value = false;
      adminCredential.value = null;
      return false;
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      console.error('[AdminAccess] Error checking admin status:', err);
      error.value = errorMsg;
      isAdmin.value = false;
      return false;
    } finally {
      isChecking.value = false;
    }
  }

  /**
   * Reset admin access state
   */
  function reset() {
    isAdmin.value = false;
    adminCredential.value = null;
    error.value = null;
  }

  return {
    // State
    isAdmin,
    adminCredential,
    isChecking,
    error,

    // Computed
    canApproveRegistrations,
    isSteward,
    canManageMembers,

    // Actions
    checkAdminStatus,
    reset,
  };
}
