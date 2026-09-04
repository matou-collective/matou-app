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

    <!-- Projects & Contributions feature table (#314): every project-and-
         contribution capability, one column each. Uniquely, its rows include
         the project-scoped roles (contributor / lead / steward) alongside the
         community roles — it is the only table that lists them. Reward is a
         community-only capability (it appears in this feature area but a project
         role cannot hold it), so it is disabled on the project rows. -->
    <section v-if="editableGrants" class="roles-section projects-section" data-feature="projects">
      <div class="section-header">
        <div>
          <h3 class="section-title">Projects &amp; Contributions</h3>
          <p class="section-subtitle">
            Who can contribute, manage projects, review and sign off work, reward, and assign the
            per-project lead and steward — and who may see contribution budgets and actual costs.
            Community and project roles both appear here.
          </p>
        </div>
      </div>
      <q-markup-table flat bordered dense class="roles-matrix projects-roles">
        <thead>
          <tr>
            <th class="text-left">Role</th>
            <th
              v-for="cap in projectsCapabilityIds"
              :key="cap"
              class="text-center"
              :data-cap="cap"
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
          <tr v-for="role in allRoles" :key="role.id" :data-role="role.id">
            <td class="text-left">
              {{ role.displayName }}
              <q-badge
                :color="role.scope === 'project' ? 'primary' : 'grey-6'"
                class="q-ml-xs"
                >{{ role.scope === 'project' ? 'project' : 'community' }}</q-badge
              >
              <q-badge v-if="!role.builtin" color="secondary" class="q-ml-xs">custom</q-badge>
            </td>
            <td
              v-for="cap in projectsCapabilityIds"
              :key="cap"
              class="text-center"
              :data-cap="cap"
              :class="{ 'community-only-cell': role.scope === 'project' && !isProjectCap(cap) }"
            >
              <q-toggle
                :model-value="hasGrant(role.id, cap)"
                :disable="
                  !store.canManageRoles ||
                  (role.scope === 'project' && !isProjectCap(cap) && !hasGrant(role.id, cap))
                "
                dense
                @update:model-value="(v: boolean) => setGrant(role.id, cap, v)"
              >
                <q-tooltip v-if="role.scope === 'project' && !isProjectCap(cap)">
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

    <!-- Proposals: the proposal feature's own permission table (#315). Both
         capabilities are community-scoped, so community roles hold them freely;
         a project role appears only when it grandfather-holds one (per #201,
         project_steward's manage_governance) — that grant can be switched off
         but not re-added. -->
    <section v-if="editableGrants" class="roles-section proposals-section">
      <div class="section-header">
        <div>
          <h3 class="section-title">Proposals</h3>
          <p class="section-subtitle">
            Who may create and submit proposals, and who governs them (sign off, reject, edit,
            withdraw). Community roles; a project role shows here only for a grandfathered
            governance grant that can be removed but not re-added.
          </p>
        </div>
      </div>
      <q-markup-table flat bordered dense class="roles-matrix proposals-table">
        <thead>
          <tr>
            <th class="text-left">Role</th>
            <th v-for="cap in proposalCapabilityIds" :key="cap" class="text-center">
              {{ capabilityLabel(cap) }}
              <q-tooltip>{{ capabilityTooltip(cap) }}</q-tooltip>
            </th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="role in proposalRoles" :key="role.id">
            <td class="text-left">
              {{ role.displayName }}
              <q-badge v-if="role.scope === 'project'" color="primary" class="q-ml-xs"
                >project</q-badge
              >
              <q-badge v-if="!role.builtin" color="secondary" class="q-ml-xs">custom</q-badge>
            </td>
            <td
              v-for="cap in proposalCapabilityIds"
              :key="cap"
              class="text-center"
              :class="{ 'community-only-cell': role.scope === 'project' }"
              :data-role="role.id"
              :data-cap="cap"
            >
              <q-toggle
                :model-value="hasGrant(role.id, cap)"
                :disable="isProposalCellDisabled(role, cap)"
                dense
                @update:model-value="(v: boolean) => setGrant(role.id, cap, v)"
              >
                <q-tooltip v-if="role.scope === 'project'">
                  Community-only capability — a project role cannot gain it.
                  <template v-if="hasGrant(role.id, cap)">
                    This grandfathered grant can be switched off, but not back on.
                  </template>
                </q-tooltip>
              </q-toggle>
            </td>
          </tr>
        </tbody>
      </q-markup-table>
    </section>

    <!-- Chat feature table (#316): the community-scoped chat capabilities
         (send messages, manage channels, moderate messages) per community role.
         Chat capabilities are community-only, so project roles are not listed. -->
    <section v-if="editableGrants" class="roles-section chat-section" data-feature="chat">
      <div class="section-header">
        <div>
          <h3 class="section-title">Chat</h3>
          <p class="section-subtitle">
            Who can post messages, manage channels, and moderate others’ messages. Sending is
            granted to every member role by default; managing and moderating default to stewards
            and the founder.
          </p>
        </div>
      </div>
      <q-markup-table flat bordered dense class="roles-matrix chat-roles">
        <thead>
          <tr>
            <th class="text-left">Role</th>
            <th v-for="cap in chatCapabilityIds" :key="cap" class="text-center" :data-cap="cap">
              {{ capabilityLabel(cap) }}
              <q-tooltip>{{ capabilityTooltip(cap) }}</q-tooltip>
            </th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="role in communityRoles" :key="role.id" :data-role="role.id">
            <td class="text-left">
              {{ role.displayName }}
              <q-badge v-if="!role.builtin" color="secondary" class="q-ml-xs">custom</q-badge>
            </td>
            <td v-for="cap in chatCapabilityIds" :key="cap" class="text-center" :data-cap="cap">
              <q-toggle
                :model-value="hasGrant(role.id, cap)"
                :disable="!store.canManageRoles"
                dense
                @update:model-value="(v: boolean) => setGrant(role.id, cap, v)"
              />
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

// Proposals has its own per-feature permission table (#315/#312). Its two
// capabilities are therefore removed from the Community/Project tables below so
// each capability has exactly one editing surface.
const PROPOSAL_CAPABILITY_IDS = ['create_proposals', 'manage_governance'];

// Defensive: only show a proposal column the backend actually advertises.
const proposalCapabilityIds = computed(() =>
  PROPOSAL_CAPABILITY_IDS.filter((c) => store.capabilityColumns.includes(c)),
);

// The Projects & Contributions feature has its own permission table (#314). Its
// capability IDs come from the server group metadata, with a fallback to the
// known IDs so the table still renders against an older backend.
const PROJECTS_CAPABILITY_IDS = [
  'contribute',
  'manage_projects',
  'review_work',
  'sign_off',
  'reward',
  'submit_completion',
  'approve_completion',
  'archive_work',
  'view_contribution_amounts',
  'assign_project_steward',
  'assign_project_lead',
];
const projectsCapabilityIds = computed(() => {
  const fromMeta = store.capabilitiesInGroup('Projects & Contributions');
  return fromMeta.length ? fromMeta : PROJECTS_CAPABILITY_IDS;
});

// The Chat feature has its own permission table (#316). Its capability IDs come
// from the server group metadata, with a fallback to the known IDs so the table
// still renders against an older backend.
const CHAT_CAPABILITY_IDS = ['send_messages', 'manage_channels', 'moderate_messages'];
const chatCapabilityIds = computed(() => {
  const fromMeta = store.capabilitiesInGroup('Chat');
  return fromMeta.length ? fromMeta : CHAT_CAPABILITY_IDS;
});

// Capabilities owned by a per-feature table above; the generic community/project
// matrices show every capability that does NOT yet have its own feature table.
const featureOwnedCapabilityIds = computed(
  () =>
    new Set([
      ...projectsCapabilityIds.value,
      ...PROPOSAL_CAPABILITY_IDS,
      ...chatCapabilityIds.value,
    ]),
);
const capabilityIds = computed(() =>
  store.capabilityColumns.filter((cap) => !featureOwnedCapabilityIds.value.has(cap)),
);

// Local scope partitions so freshly-added (unsaved) roles show immediately.
const communityRoles = computed(() =>
  roles.value.filter((r) => (r.scope ?? 'community') !== 'project'),
);
const projectRoles = computed(() => roles.value.filter((r) => r.scope === 'project'));

// The Proposals table lists every community role, plus any project role that
// grandfather-holds a proposal capability (per #201 that is project_steward's
// manage_governance). A grandfathered grant may be switched off but not re-added
// — the same rule the Project table applies to community-only capabilities.
const proposalGrandfatheredRoles = computed(() =>
  projectRoles.value.filter((r) =>
    proposalCapabilityIds.value.some((c) => hasGrant(r.id, c)),
  ),
);
const proposalRoles = computed(() => [
  ...communityRoles.value,
  ...proposalGrandfatheredRoles.value,
]);

// The Projects & Contributions table lists every role, community rows first then
// project rows — it is the only table that includes the project-scoped roles.
const allRoles = computed(() => [...communityRoles.value, ...projectRoles.value]);

function isProjectCap(cap: string): boolean {
  return store.isProjectCapability(cap);
}

// A proposal cell is disabled when the caller can't manage roles, or when a
// project-scoped role would be gaining a community-only capability it does not
// already hold (the #201 grandfather: keep/remove, never re-add).
function isProposalCellDisabled(role: RoleDef, cap: string): boolean {
  if (!store.canManageRoles) return true;
  const isProjectRole = role.scope === 'project';
  return isProjectRole && !isProjectCap(cap) && !hasGrant(role.id, cap);
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
  create_proposals: 'Create proposals',
  manage_governance: 'Governance',
  // Chat feature (#316).
  send_messages: 'Send messages',
  manage_channels: 'Manage channels',
  moderate_messages: 'Moderate messages',
  manage_communications: 'Communications',
  manage_roles: 'Manage roles',
  // Projects & Contributions feature (#314).
  view_contribution_amounts: 'View amounts',
  assign_project_steward: 'Assign steward',
  assign_project_lead: 'Assign lead',
};

function capabilityLabel(cap: string): string {
  // Prefer the curated short column label; fall back to the server-provided
  // display name (so a capability this build does not know still gets a
  // readable header), then the raw ID.
  return CAPABILITY_LABELS[cap] || store.capabilityDisplayName(cap) || cap;
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

.roles-matrix.project-roles td.community-only-cell,
.roles-matrix.proposals-table td.community-only-cell {
  background: var(--matou-muted, rgba(0, 0, 0, 0.03));
}

/* The Projects & Contributions table (#314): a community-only capability
   (Reward) is italicised in the header and its project-role cells are shaded,
   matching the project-table treatment. */
.roles-matrix.projects-roles th.community-only-col {
  opacity: 0.5;
  font-style: italic;
}

.roles-matrix.projects-roles td.community-only-cell {
  background: var(--matou-muted, rgba(0, 0, 0, 0.03));
}
</style>
