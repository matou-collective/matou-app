/**
 * Thin wrapper around the identity store's admin state.
 * Admin status is checked once and cached in the store — no repeated KERIA calls.
 *
 * Page-specific role checks (project lead, proposal lead, assigned contributor, etc.)
 * remain in their respective pages/composables and are NOT part of admin access.
 */
import { useIdentityStore } from 'stores/identity';
import { computed } from 'vue';

// Re-export the type from the store
export type { AdminCredentialInfo } from 'stores/identity';

export function useAdminAccess() {
  const identityStore = useIdentityStore();

  return {
    // State (from store)
    isAdmin: computed(() => identityStore.isAdmin),
    adminCredential: computed(() => identityStore.adminCredential),
    isChecking: computed(() => !identityStore.adminChecked),
    error: computed(() => null as string | null),

    // Computed (from store)
    canApproveRegistrations: computed(() => identityStore.isAdmin),
    isSteward: computed(() => identityStore.isSteward),
    canManageMembers: computed(() => identityStore.canManageMembers),

    // Actions — checkAdminStatus returns cached result if already checked
    checkAdminStatus: () => identityStore.checkAdminStatus(),
    recheckAdminStatus: () => identityStore.recheckAdminStatus(),
    reset: () => {
      // No-op — state is managed by store disconnect
    },
  };
}
