<!-- frontend/src/pages/Dashboard/CommunitySettingsPage.vue -->
<!--
  Community Settings (#318). The home for community-wide administration: the
  per-feature permission tables (this slice ships the Community table; the other
  feature tables and the read-only Roles overview land in the sibling slices of
  #312) plus the org settings. Access is gated by `open_community_settings`
  BOTH in the nav (the sidebar gear only shows for holders) AND server-side:
  the page verifies access against /api/v1/community-settings/access on mount
  and refuses to render its contents on a 403, so a member who navigates here by
  URL still can't see it.
-->
<template>
  <div class="community-settings-page">
    <div class="cs-header">
      <div>
        <h2 class="cs-title">Community Settings</h2>
        <p class="cs-subtitle">Community-wide administration — roles, permissions and org details</p>
      </div>
    </div>

    <div v-if="checkingAccess" class="cs-loading">Checking access…</div>

    <q-banner v-else-if="!accessAllowed" class="bg-negative text-white access-denied">
      You don't have permission to open Community Settings.
    </q-banner>

    <template v-else>
      <q-banner v-if="store.error" class="bg-negative text-white q-mb-md">
        {{ store.error }}
      </q-banner>
      <q-banner v-if="store.source === 'default'" class="bg-info text-white q-mb-md">
        Showing the built-in default policy — it has never been customized. Saving creates the
        community's first policy version.
      </q-banner>

      <!-- Community permission table: community-scoped roles × the four
           Community-group capabilities (incl. Manage roles, which still gates
           edits of every table). -->
      <section class="cs-section community-section">
        <div class="section-header">
          <div>
            <h3 class="section-title">Community</h3>
            <p class="section-subtitle">
              Who may open and change community settings, manage members, and manage roles.
              Community roles only.
            </p>
          </div>
          <button
            class="cs-btn primary"
            :disabled="!dirty || !store.canManageRoles || saving"
            @click="savePolicy"
          >
            {{ saving ? 'Saving…' : 'Save changes' }}
          </button>
        </div>

        <q-banner v-if="!store.canManageRoles && !store.loading" class="bg-warning text-dark q-mb-md">
          You don't have permission to manage roles. This table is read-only for you.
        </q-banner>

        <q-markup-table v-if="editableGrants" flat bordered dense class="roles-matrix community-permissions-table">
          <thead>
            <tr>
              <th class="text-left">Role</th>
              <th v-for="col in COMMUNITY_CAPS" :key="col.id" class="text-center">
                {{ col.label }}
                <q-tooltip>{{ capabilityTooltip(col.id) }}</q-tooltip>
              </th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="role in communityRoles" :key="role.id">
              <td class="text-left">
                {{ role.displayName }}
                <q-badge v-if="!role.builtin" color="secondary" class="q-ml-xs">custom</q-badge>
              </td>
              <td v-for="col in COMMUNITY_CAPS" :key="col.id" class="text-center">
                <q-toggle
                  :model-value="hasGrant(role.id, col.id)"
                  :disable="!store.canManageRoles || isLockedCell(role.id, col.id)"
                  dense
                  @update:model-value="(v: boolean) => setGrant(role.id, col.id, v)"
                >
                  <q-tooltip v-if="isLockedCell(role.id, col.id)">
                    At least one role must keep “Manage roles”.
                  </q-tooltip>
                </q-toggle>
              </td>
            </tr>
          </tbody>
        </q-markup-table>
      </section>

      <!-- Org settings: the org profile. Saving requires
           manage_community_settings server-side (the backend 403s otherwise). -->
      <section class="cs-section org-section">
        <div class="section-header">
          <div>
            <h3 class="section-title">Org details</h3>
            <p class="section-subtitle">The community's name, as shown across the app.</p>
          </div>
          <button
            class="cs-btn primary"
            :disabled="!orgDirty || !canManageOrg || savingOrg || !orgConfig"
            @click="saveOrg"
          >
            {{ savingOrg ? 'Saving…' : 'Save org details' }}
          </button>
        </div>

        <q-banner v-if="!canManageOrg" class="bg-warning text-dark q-mb-md">
          You don't have permission to change org details. This section is read-only for you.
        </q-banner>

        <div class="org-fields">
          <q-input
            v-model="orgName"
            label="Community name"
            :disable="!canManageOrg || !orgConfig"
            outlined
            dense
            class="org-name-input"
          />
        </div>
      </section>
    </template>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { useQuasar } from 'quasar';
import { useRolePolicyStore } from 'src/stores/rolePolicy';
import { checkCommunitySettingsAccess } from 'src/lib/api/communitySettings';
import { fetchOrgConfig, saveOrgConfig, type OrgConfig } from 'src/api/config';

const $q = useQuasar();
const store = useRolePolicyStore();

// The four Community-group capability columns (backend group "Community",
// display order). Held here rather than derived from the server so the table is
// self-contained; manage_roles gates edits of every permission table.
const COMMUNITY_CAPS = [
  { id: 'open_community_settings', label: 'Open settings' },
  { id: 'manage_community_settings', label: 'Manage settings' },
  { id: 'manage_members', label: 'Manage members' },
  { id: 'manage_roles', label: 'Manage roles' },
] as const;

const checkingAccess = ref(true);
const accessAllowed = ref(false);

// --- Community permission table state -------------------------------------
const editableGrants = ref<Record<string, string[]> | null>(null);
const saving = ref(false);

const communityRoles = computed(() => store.communityRoles);

function capabilityTooltip(cap: string): string {
  const actions = store.capabilities[cap] ?? [];
  return actions.length ? `Actions: ${actions.join(', ')}` : 'No enforced actions yet';
}

function resetFromStore() {
  editableGrants.value = Object.fromEntries(
    Object.entries(store.policy?.grants ?? {}).map(([k, v]) => [k, [...v]]),
  );
}

const dirty = computed(() => {
  if (!store.policy || !editableGrants.value) return false;
  return JSON.stringify(editableGrants.value) !== JSON.stringify(store.policy.grants);
});

function hasGrant(roleId: string, cap: string): boolean {
  return editableGrants.value?.[roleId]?.includes(cap) ?? false;
}

// The last remaining manage_roles toggle is locked ON — a policy nobody can
// edit via roles is almost certainly a mistake (mirrors the backend invariant).
function isLockedCell(roleId: string, cap: string): boolean {
  if (cap !== 'manage_roles' || !hasGrant(roleId, cap)) return false;
  const holders = Object.entries(editableGrants.value ?? {}).filter(([, caps]) =>
    caps.includes('manage_roles'),
  );
  return holders.length === 1 && holders[0]?.[0] === roleId;
}

function setGrant(roleId: string, cap: string, value: boolean) {
  if (!editableGrants.value) return;
  const caps = editableGrants.value[roleId] ?? [];
  if (value && !caps.includes(cap)) {
    editableGrants.value[roleId] = [...caps, cap];
  } else if (!value) {
    editableGrants.value[roleId] = caps.filter((c) => c !== cap);
  }
}

async function savePolicy() {
  if (!store.policy || !editableGrants.value) return;
  saving.value = true;
  // Send the full policy back — we only mutated the Community columns, so every
  // other capability grant is preserved verbatim.
  const ok = await store.save({
    version: store.policy.version,
    roles: store.policy.roles,
    grants: editableGrants.value,
  });
  saving.value = false;
  if (ok) {
    resetFromStore();
    void store.load(); // refresh callerCapabilities / nav gate after a self-edit
    $q.notify({ type: 'positive', message: 'Community roles saved' });
  } else if (store.error) {
    $q.notify({ type: 'negative', message: store.error });
    resetFromStore();
  }
}

// --- Org settings state ----------------------------------------------------
const orgConfig = ref<OrgConfig | null>(null);
const orgName = ref('');
const savingOrg = ref(false);

const canManageOrg = computed(() => store.can('manage_community_settings'));
const orgDirty = computed(
  () => orgConfig.value !== null && orgName.value !== orgConfig.value.organization.name,
);

async function loadOrg() {
  const result = await fetchOrgConfig();
  if (result.status === 'configured') {
    orgConfig.value = result.config;
    orgName.value = result.config.organization.name;
  } else if (result.status === 'server_unreachable' && result.cached) {
    orgConfig.value = result.cached;
    orgName.value = result.cached.organization.name;
  }
}

async function saveOrg() {
  if (!orgConfig.value) return;
  savingOrg.value = true;
  try {
    const updated: OrgConfig = {
      ...orgConfig.value,
      organization: { ...orgConfig.value.organization, name: orgName.value.trim() },
    };
    await saveOrgConfig(updated);
    orgConfig.value = updated;
    $q.notify({ type: 'positive', message: 'Org details saved' });
  } catch (e) {
    $q.notify({ type: 'negative', message: e instanceof Error ? e.message : String(e) });
  } finally {
    savingOrg.value = false;
  }
}

onMounted(async () => {
  accessAllowed.value = await checkCommunitySettingsAccess();
  checkingAccess.value = false;
  if (!accessAllowed.value) return;
  await store.load();
  resetFromStore();
  await loadOrg();
});
watch(() => store.policy?.version, resetFromStore);
</script>

<style scoped>
.community-settings-page {
  padding: 24px;
}

.cs-header {
  margin-bottom: 16px;
}

.cs-title {
  font-size: 1.5rem;
  font-weight: 600;
  margin: 0;
  color: var(--matou-foreground);
}

.cs-subtitle {
  color: var(--matou-muted-foreground);
  margin: 4px 0 0;
}

.cs-loading {
  color: var(--matou-muted-foreground);
  padding: 16px 0;
}

.cs-section {
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

.cs-btn {
  border-radius: 10px;
  padding: 8px 16px;
  font-weight: 500;
  cursor: pointer;
  white-space: nowrap;
  border: 2px solid var(--matou-teal, #0d9488);
}

.cs-btn.primary {
  background: var(--matou-teal, #0d9488);
  color: white;
}

.cs-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.roles-matrix th {
  white-space: nowrap;
}

.org-name-input {
  max-width: 420px;
}
</style>
