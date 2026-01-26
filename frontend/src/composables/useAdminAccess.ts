/**
 * Composable for checking admin access based on credentials
 * Determines if the current user has admin privileges for registration approval
 */
import { ref, computed } from 'vue';
import { useKERIClient, CredentialInfo } from 'src/lib/keri/client';
import { useIdentityStore } from 'stores/identity';
import { fetchOrgConfig } from 'src/api/config';

// Schema SAIDs for admin credentials
const OPERATIONS_STEWARD_SCHEMA = 'EOperationsStewardSchemaV1';

// Permissions that grant admin access
const ADMIN_PERMISSIONS = ['approve_registrations', 'admin', 'steward'];

export interface AdminCredentialInfo extends CredentialInfo {
  role?: string;
  permissions?: string[];
  communityName?: string;
}

export function useAdminAccess() {
  const keriClient = useKERIClient();
  const identityStore = useIdentityStore();

  // State
  const isAdmin = ref(false);
  const adminCredential = ref<AdminCredentialInfo | null>(null);
  const permissions = ref<string[]>([]);
  const isChecking = ref(false);
  const error = ref<string | null>(null);

  // Computed
  const canApproveRegistrations = computed(() =>
    permissions.value.includes('approve_registrations') ||
    permissions.value.includes('admin') ||
    permissions.value.includes('steward')
  );

  /**
   * Check if the current user has admin status
   * Looks for Operations Steward credential or credentials with admin permissions
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
      // Method 1: Check credentials in wallet
      const credentials = await client.credentials().list();
      console.log('[AdminAccess] Checking credentials:', credentials.length);

      for (const cred of credentials) {
        // Use type assertions for flexible access to credential properties
        const credAny = cred as Record<string, unknown>;
        const sad = credAny.sad as Record<string, unknown> | undefined;
        const credData = (sad?.a || sad?.d || {}) as Record<string, unknown>;
        const schemaId = typeof credAny.schema === 'string' ? credAny.schema : (sad?.s as string) || '';
        const statusObj = credAny.status as Record<string, unknown> | undefined;

        // Check for Operations Steward schema
        if (schemaId === OPERATIONS_STEWARD_SCHEMA) {
          console.log('[AdminAccess] Found Operations Steward credential');
          isAdmin.value = true;
          adminCredential.value = {
            said: (sad?.d as string) || (sad?.i as string) || '',
            schema: schemaId,
            issuer: (sad?.i as string) || '',
            issuee: (credData.i as string) || currentAID.prefix,
            status: (statusObj?.s as string) || 'issued',
            role: (credData.role as string) || 'Operations Steward',
            permissions: (credData.permissions as string[]) || ['approve_registrations', 'admin'],
            communityName: credData.communityName as string | undefined,
          };
          permissions.value = adminCredential.value?.permissions || [];
          return true;
        }

        // Check for role field indicating admin/steward
        const role = ((credData.role as string) || '').toLowerCase();
        if (role.includes('steward') || role.includes('admin') || role.includes('operations')) {
          console.log('[AdminAccess] Found admin role in credential:', role);
          isAdmin.value = true;
          adminCredential.value = {
            said: (sad?.d as string) || '',
            schema: schemaId,
            issuer: (sad?.i as string) || '',
            issuee: (credData.i as string) || currentAID.prefix,
            status: (statusObj?.s as string) || 'issued',
            role: credData.role as string | undefined,
            permissions: (credData.permissions as string[]) || ['approve_registrations'],
            communityName: credData.communityName as string | undefined,
          };
          permissions.value = adminCredential.value?.permissions || [];
          return true;
        }

        // Check for permissions array
        const credPermissions = (credData.permissions as string[]) || [];
        const hasAdminPermission = credPermissions.some((p: string) =>
          ADMIN_PERMISSIONS.includes(p.toLowerCase())
        );

        if (hasAdminPermission) {
          console.log('[AdminAccess] Found admin permissions in credential');
          isAdmin.value = true;
          adminCredential.value = {
            said: (sad?.d as string) || '',
            schema: schemaId,
            issuer: (sad?.i as string) || '',
            issuee: (credData.i as string) || currentAID.prefix,
            status: (statusObj?.s as string) || 'issued',
            role: credData.role as string | undefined,
            permissions: credPermissions,
            communityName: credData.communityName as string | undefined,
          };
          permissions.value = credPermissions;
          return true;
        }
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
            permissions.value = ['approve_registrations', 'admin'];
            // No credential, but still admin by config
            return true;
          }
        }
      }

      console.log('[AdminAccess] User is not an admin');
      isAdmin.value = false;
      adminCredential.value = null;
      permissions.value = [];
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
    permissions.value = [];
    error.value = null;
  }

  return {
    // State
    isAdmin,
    adminCredential,
    permissions,
    isChecking,
    error,

    // Computed
    canApproveRegistrations,

    // Actions
    checkAdminStatus,
    reset,
  };
}
