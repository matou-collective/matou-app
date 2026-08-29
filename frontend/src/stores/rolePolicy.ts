import { defineStore } from 'pinia';
import {
  fetchRolePolicy,
  updateRolePolicy,
  RolePolicyConflictError,
  type RolePolicy,
  type RolePolicyUpdate,
} from 'src/lib/api/rolePolicy';

interface RolePolicyState {
  policy: RolePolicy | null;
  source: 'synced' | 'default' | null;
  capabilities: Record<string, string[]>;
  callerCapabilities: string[];
  loading: boolean;
  error: string | null;
}

export const useRolePolicyStore = defineStore('rolePolicy', {
  state: (): RolePolicyState => ({
    policy: null,
    source: null,
    capabilities: {},
    callerCapabilities: [],
    loading: false,
    error: null,
  }),

  getters: {
    canManageRoles(state): boolean {
      return state.callerCapabilities.includes('manage_roles');
    },
    can(state): (cap: string) => boolean {
      return (cap: string) => state.callerCapabilities.includes(cap);
    },
    // Role options for member role assignment (ChangeRoleModal): the
    // policy registry, builtins first, preserving server order.
    roleOptions(state): { id: string; displayName: string; builtin: boolean }[] {
      return state.policy?.roles ?? [];
    },
  },

  actions: {
    async load() {
      this.loading = true;
      this.error = null;
      try {
        const resp = await fetchRolePolicy();
        this.policy = resp.policy;
        this.source = resp.source;
        this.capabilities = resp.capabilities;
        this.callerCapabilities = resp.callerCapabilities ?? [];
      } catch (e) {
        this.error = e instanceof Error ? e.message : String(e);
      } finally {
        this.loading = false;
      }
    },

    // Returns true on success; on version conflict reloads the latest
    // policy and returns false so the UI can tell the admin to re-apply.
    async save(update: RolePolicyUpdate): Promise<boolean> {
      this.error = null;
      try {
        this.policy = await updateRolePolicy(update);
        this.source = 'synced';
        return true;
      } catch (e) {
        if (e instanceof RolePolicyConflictError) {
          await this.load();
          this.error = 'Someone else changed the policy — review the latest version and retry.';
          return false;
        }
        this.error = e instanceof Error ? e.message : String(e);
        return false;
      }
    },
  },
});
