import { defineStore } from 'pinia';
import {
  fetchRolePolicy,
  updateRolePolicy,
  RolePolicyConflictError,
  type RolePolicy,
  type RolePolicyUpdate,
  type RoleDef,
  type CapabilityMeta,
} from 'src/lib/api/rolePolicy';

interface RolePolicyState {
  policy: RolePolicy | null;
  source: 'synced' | 'default' | null;
  capabilities: Record<string, string[]>;
  capabilityOrder: string[];
  projectCapabilities: string[];
  callerCapabilities: string[];
  capabilityMeta: CapabilityMeta[];
  loading: boolean;
  error: string | null;
}

export const useRolePolicyStore = defineStore('rolePolicy', {
  state: (): RolePolicyState => ({
    policy: null,
    source: null,
    capabilities: {},
    capabilityOrder: [],
    projectCapabilities: [],
    callerCapabilities: [],
    capabilityMeta: [],
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
    // Capability column order: the server-provided AllCapabilities() order,
    // falling back to the (unordered) capabilities map keys for older backends.
    capabilityColumns(state): string[] {
      return state.capabilityOrder.length
        ? state.capabilityOrder
        : Object.keys(state.capabilities);
    },
    // Whether a capability may be held by a project-scoped role.
    isProjectCapability(state): (cap: string) => boolean {
      const set = new Set(state.projectCapabilities);
      // Empty set (older backend) → treat every capability as allowed so the
      // page still functions; the split simply won't disable any column.
      return (cap: string) => set.size === 0 || set.has(cap);
    },
    // Feature areas in display order, each with its capability IDs — the
    // read-only overview (#319) renders one column per group and the per-feature
    // tables (#312) one table per group. Derived from the server capabilityMeta,
    // preserving its order.
    featureGroups(state): { name: string; capabilities: string[] }[] {
      const order: string[] = [];
      const byGroup: Record<string, string[]> = {};
      for (const m of state.capabilityMeta) {
        if (!byGroup[m.group]) {
          byGroup[m.group] = [];
          order.push(m.group);
        }
        byGroup[m.group]!.push(m.id);
      }
      return order.map((name) => ({ name, capabilities: byGroup[name] ?? [] }));
    },
    // Human label for a capability, from the server metadata (falls back to the
    // raw id for an unknown/legacy capability).
    capabilityLabel(state): (cap: string) => string {
      const labels = new Map(state.capabilityMeta.map((m) => [m.id, m.displayName]));
      return (cap: string) => labels.get(cap) ?? cap;
    },
    // Roles partitioned by scope for the two tables. A missing scope is
    // treated as community (matches the backend's NormalizeScope default).
    communityRoles(state): RoleDef[] {
      return (state.policy?.roles ?? []).filter((r) => (r.scope ?? 'community') !== 'project');
    },
    projectRoles(state): RoleDef[] {
      return (state.policy?.roles ?? []).filter((r) => r.scope === 'project');
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
        this.capabilityOrder = resp.capabilityOrder ?? [];
        this.projectCapabilities = resp.projectCapabilities ?? [];
        this.callerCapabilities = resp.callerCapabilities ?? [];
        this.capabilityMeta = resp.capabilityMeta ?? [];
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
