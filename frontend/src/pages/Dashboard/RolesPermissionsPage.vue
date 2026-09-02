<!-- frontend/src/pages/Dashboard/RolesPermissionsPage.vue -->
<template>
  <div class="roles-page">
    <div class="roles-header">
      <div class="roles-header-text">
        <h2 class="roles-title">Roles &amp; Permissions</h2>
        <p class="roles-subtitle">Which roles exist and what each one may do</p>
      </div>
      <div class="roles-actions">
        <button
          class="save-btn"
          :disabled="!dirty || !store.canManageRoles || saving"
          @click="save"
        >
          {{ saving ? 'Saving…' : 'Save changes' }}
        </button>
      </div>
    </div>

    <q-banner v-if="!store.canManageRoles && !store.loading" class="bg-warning text-dark q-mb-md">
      You don't have permission to manage roles. This page is read-only for you.
    </q-banner>
    <q-banner v-if="store.error" class="bg-negative text-white q-mb-md">
      {{ store.error }}
    </q-banner>
    <q-banner v-if="store.source === 'default'" class="bg-info text-white q-mb-md">
      Showing the built-in default policy — it has never been customized. Saving creates the
      community's first policy version.
    </q-banner>

    <!-- Community roles: who you are (membership credential). Full capability set. -->
    <section v-if="editableGrants" class="roles-section community-section">
      <div class="section-header">
        <div>
          <h3 class="section-title">Community roles</h3>
          <p class="section-subtitle">
            Who you are in the community, issued as a membership credential. May hold any capability.
          </p>
        </div>
        <button
          class="create-btn"
          :disabled="!store.canManageRoles"
          @click="openNewRoleDialog('community')"
        >
          + New role
        </button>
      </div>
      <q-markup-table flat bordered dense class="roles-matrix community-roles">
        <thead>
          <tr>
            <th class="text-left">Role</th>
            <th v-for="cap in capabilityIds" :key="cap" class="text-center">
              {{ capabilityLabel(cap) }}
              <q-tooltip>{{ capabilityTooltip(cap) }}</q-tooltip>
            </th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="role in communityRoles" :key="role.id">
            <td class="text-left">
              {{ role.displayName }}
              <q-badge v-if="!role.builtin" color="secondary" class="q-ml-xs">custom</q-badge>
            </td>
            <td v-for="cap in capabilityIds" :key="cap" class="text-center">
              <q-toggle
                :model-value="hasGrant(role.id, cap)"
                :disable="!store.canManageRoles || isLockedCell(role.id, cap)"
                dense
                @update:model-value="(v: boolean) => setGrant(role.id, cap, v)"
              >
                <q-tooltip v-if="isLockedCell(role.id, cap)">
                  At least one role must keep “Manage roles”.
                </q-tooltip>
              </q-toggle>
            </td>
          </tr>
        </tbody>
      </q-markup-table>
    </section>

    <!-- Project roles: what you hold on one project. Project-scoped capabilities only. -->
    <section v-if="editableGrants" class="roles-section project-section">
      <div class="section-header">
        <div>
          <h3 class="section-title">Project roles</h3>
          <p class="section-subtitle">
            What you hold on a single project, assigned per project. Limited to project-scoped
            capabilities — community-only capabilities cannot be granted here
            (an existing legacy grant can only be switched off).
          </p>
        </div>
        <button
          class="create-btn"
          :disabled="!store.canManageRoles"
          @click="openNewRoleDialog('project')"
        >
          + New role
        </button>
      </div>
      <q-markup-table flat bordered dense class="roles-matrix project-roles">
        <thead>
          <tr>
            <th class="text-left">Role</th>
            <th
              v-for="cap in capabilityIds"
              :key="cap"
              class="text-center"
              :class="{ 'community-only-col': !isProjectCap(cap) }"
            >
              {{ capabilityLabel(cap) }}
              <q-tooltip>
                {{ capabilityTooltip(cap) }}<template v-if="!isProjectCap(cap)">
                  — community-only</template
                >
              </q-tooltip>
            </th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="role in projectRoles" :key="role.id">
            <td class="text-left">
              {{ role.displayName }}
              <q-badge v-if="!role.builtin" color="secondary" class="q-ml-xs">custom</q-badge>
            </td>
            <td
              v-for="cap in capabilityIds"
              :key="cap"
              class="text-center"
              :class="{ 'community-only-cell': !isProjectCap(cap) }"
            >
              <q-toggle
                :model-value="hasGrant(role.id, cap)"
                :disable="!store.canManageRoles || (!isProjectCap(cap) && !hasGrant(role.id, cap))"
                dense
                @update:model-value="(v: boolean) => setGrant(role.id, cap, v)"
              >
                <q-tooltip v-if="!isProjectCap(cap)">
                  Community-only capability — a project role cannot gain it.
                  <template v-if="hasGrant(role.id, cap)">
                    This legacy grant can be switched off, but not back on.
                  </template>
                </q-tooltip>
              </q-toggle>
            </td>
          </tr>
        </tbody>
      </q-markup-table>
    </section>

    <q-dialog v-model="newRoleDialog">
      <q-card style="min-width: 360px">
        <q-card-section class="text-h6">
          New {{ newRoleScope === 'project' ? 'project' : 'community' }} role
        </q-card-section>
        <q-card-section>
          <q-input
            v-model="newRoleName"
            label="Role name"
            hint="e.g. Kaitiaki — the ID becomes lowercase with underscores"
            :error="newRoleName.length > 0 && !newRoleIdValid"
            error-message="Letters, numbers and underscores only; must start with a letter"
          />
          <q-select
            v-model="copyFromRole"
            :options="roleSelectOptions"
            label="Copy permissions from (optional)"
            clearable
            emit-value
            map-options
            class="q-mt-sm"
          />
        </q-card-section>
        <q-card-actions align="right">
          <q-btn flat label="Cancel" v-close-popup />
          <q-btn
            color="primary"
            label="Add role"
            :disable="!newRoleIdValid"
            @click="addRole"
            v-close-popup
          />
        </q-card-actions>
      </q-card>
    </q-dialog>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { useQuasar } from 'quasar';
import { useRolePolicyStore } from 'src/stores/rolePolicy';
import type { RoleDef, RoleScope } from 'src/lib/api/rolePolicy';

const $q = useQuasar();
const store = useRolePolicyStore();

const roles = ref<RoleDef[]>([]);
const editableGrants = ref<Record<string, string[]> | null>(null);
const saving = ref(false);
const newRoleDialog = ref(false);
const newRoleName = ref('');
const newRoleScope = ref<RoleScope>('community');
const copyFromRole = ref<string | null>(null);

const capabilityIds = computed(() => store.capabilityColumns);

// Local scope partitions so freshly-added (unsaved) roles show immediately.
const communityRoles = computed(() =>
  roles.value.filter((r) => (r.scope ?? 'community') !== 'project'),
);
const projectRoles = computed(() => roles.value.filter((r) => r.scope === 'project'));

function isProjectCap(cap: string): boolean {
  return store.isProjectCapability(cap);
}

const CAPABILITY_LABELS: Record<string, string> = {
  contribute: 'Contribute',
  manage_projects: 'Manage projects',
  assign_work: 'Assign work',
  review_work: 'Review work',
  sign_off: 'Sign off',
  reward: 'Reward',
  submit_completion: 'Submit completion',
  approve_completion: 'Approve completion',
  archive_work: 'Archive',
  manage_members: 'Manage members',
  manage_governance: 'Governance',
  manage_communications: 'Communications',
  manage_roles: 'Manage roles',
};

function capabilityLabel(cap: string): string {
  return CAPABILITY_LABELS[cap] ?? cap;
}

function capabilityTooltip(cap: string): string {
  const actions = store.capabilities[cap] ?? [];
  return actions.length ? `Actions: ${actions.join(', ')}` : 'No enforced actions yet';
}

function resetFromStore() {
  roles.value = (store.policy?.roles ?? []).map((r) => ({ ...r }));
  editableGrants.value = Object.fromEntries(
    Object.entries(store.policy?.grants ?? {}).map(([k, v]) => [k, [...v]]),
  );
}

onMounted(async () => {
  await store.load();
  resetFromStore();
});
watch(() => store.policy?.version, resetFromStore);

const dirty = computed(() => {
  if (!store.policy || !editableGrants.value) return false;
  return (
    JSON.stringify({ r: roles.value, g: editableGrants.value }) !==
    JSON.stringify({ r: store.policy.roles, g: store.policy.grants })
  );
});

function hasGrant(roleId: string, cap: string): boolean {
  return editableGrants.value?.[roleId]?.includes(cap) ?? false;
}

// The last remaining manage_roles toggle is locked ON (spec §6).
function isLockedCell(roleId: string, cap: string): boolean {
  if (cap !== 'manage_roles' || !hasGrant(roleId, cap)) return false;
  const holders = Object.entries(editableGrants.value ?? {}).filter(([, caps]) =>
    caps.includes('manage_roles'),
  );
  return holders.length === 1 && holders[0]?.[0] === roleId;
}

function roleScopeOf(roleId: string): RoleScope {
  const r = roles.value.find((x) => x.id === roleId);
  return r?.scope === 'project' ? 'project' : 'community';
}

function setGrant(roleId: string, cap: string, value: boolean) {
  if (!editableGrants.value) return;
  // A project role may never hold a community-only capability.
  if (value && roleScopeOf(roleId) === 'project' && !isProjectCap(cap)) return;
  const caps = editableGrants.value[roleId] ?? [];
  if (value && !caps.includes(cap)) {
    editableGrants.value[roleId] = [...caps, cap];
  } else if (!value) {
    editableGrants.value[roleId] = caps.filter((c) => c !== cap);
  }
}

const newRoleId = computed(() =>
  newRoleName.value.trim().toLowerCase().replace(/\s+/g, '_'),
);
const newRoleIdValid = computed(
  () =>
    /^[a-z][a-z0-9_]{1,39}$/.test(newRoleId.value) &&
    !roles.value.some((r) => r.id === newRoleId.value),
);
// Only offer same-scope roles to copy from, so a project role can't inherit
// community-only grants.
const roleSelectOptions = computed(() =>
  roles.value
    .filter((r) => roleScopeOf(r.id) === newRoleScope.value)
    .map((r) => ({ label: r.displayName, value: r.id })),
);

function openNewRoleDialog(scope: RoleScope) {
  newRoleScope.value = scope;
  newRoleName.value = '';
  copyFromRole.value = null;
  newRoleDialog.value = true;
}

function addRole() {
  if (!editableGrants.value) return;
  const scope = newRoleScope.value;
  roles.value.push({
    id: newRoleId.value,
    displayName: newRoleName.value.trim(),
    builtin: false,
    scope,
  });
  let caps = copyFromRole.value ? [...(editableGrants.value[copyFromRole.value] ?? [])] : [];
  // Defensive: a project role only keeps project-scoped capabilities.
  if (scope === 'project') caps = caps.filter((c) => isProjectCap(c));
  editableGrants.value[newRoleId.value] = caps;
  newRoleName.value = '';
  copyFromRole.value = null;
}

async function save() {
  if (!store.policy || !editableGrants.value) return;
  saving.value = true;
  const ok = await store.save({
    version: store.policy.version,
    roles: roles.value,
    grants: editableGrants.value,
  });
  saving.value = false;
  if (ok) {
    resetFromStore();
    // Deviation from the Task 7 brief (intentional, per Task 6 review):
    // save() only refreshes policy/source on success, so callerCapabilities
    // (and the nav gate) can go stale when an admin edits their own role's
    // grants. Reload so canManageRoles reflects the just-saved policy.
    void store.load();
    $q.notify({ type: 'positive', message: 'Role policy saved' });
  } else if (store.error) {
    $q.notify({ type: 'negative', message: store.error });
    resetFromStore();
  }
}
</script>

<style scoped>
.roles-page {
  padding: 24px;
}

.roles-header {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 16px;
  margin-bottom: 16px;
}

.roles-title {
  font-size: 1.5rem;
  font-weight: 600;
  margin: 0;
  color: var(--matou-foreground);
}

.roles-subtitle {
  color: var(--matou-muted-foreground);
  margin: 4px 0 0;
}

.roles-actions {
  display: flex;
  gap: 8px;
  flex-shrink: 0;
}

.roles-section {
  margin-bottom: 32px;
}

.section-header {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 16px;
  margin-bottom: 8px;
}

.section-title {
  font-size: 1.15rem;
  font-weight: 600;
  margin: 0;
  color: var(--matou-foreground);
}

.section-subtitle {
  color: var(--matou-muted-foreground);
  margin: 2px 0 0;
  max-width: 640px;
}

.create-btn,
.save-btn {
  border-radius: 10px;
  padding: 8px 16px;
  font-weight: 500;
  cursor: pointer;
  white-space: nowrap;
  border: 2px solid var(--matou-teal, #0d9488);
}

.create-btn {
  background: transparent;
  color: var(--matou-teal, #0d9488);
}

.save-btn {
  background: var(--matou-teal, #0d9488);
  color: white;
}

.create-btn:disabled,
.save-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.roles-matrix th {
  white-space: nowrap;
}

/* Community-only columns in the project table are visually de-emphasised. */
.roles-matrix.project-roles th.community-only-col {
  opacity: 0.5;
  font-style: italic;
}

.roles-matrix.project-roles td.community-only-cell {
  background: var(--matou-muted, rgba(0, 0, 0, 0.03));
}
</style>
