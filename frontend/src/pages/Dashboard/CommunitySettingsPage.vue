<!-- frontend/src/pages/Dashboard/CommunitySettingsPage.vue -->
<!--
  Community Settings (#318). The single home for community-wide administration:
  every per-feature permission table (moved here from the former Roles &
  Permissions page), plus the org settings. The Community table leads — it
  replaced the read-only Roles overview (#319) when the pages merged. Access is
  gated by `open_community_settings` BOTH in the nav (the sidebar gear only
  shows for holders) AND server-side: the page verifies access against
  /api/v1/community-settings/access on mount and refuses to render its contents
  on a 403, so a member who navigates here by URL still can't see it. Editing
  any permission table additionally requires manage_roles (read-only banner
  otherwise); org details require manage_community_settings server-side.
-->
<template>
  <div class="community-settings-page">
    <div class="cs-header">
      <div>
        <h2 class="cs-title">Community Settings</h2>
        <p class="cs-subtitle">
          Community-wide administration — roles, permissions and org details
        </p>
      </div>
      <!-- Save changes belongs to the Roles section only (#398). Hidden on Data. -->
      <div class="cs-actions" v-if="accessAllowed && section === 'roles'">
        <button
          class="cs-btn primary"
          :disabled="!dirty || !store.canManageRoles || saving"
          @click="save"
        >
          {{ saving ? "Saving…" : "Save changes" }}
        </button>
      </div>
    </div>

    <!-- Nested sub-nav (#398): Roles | Data, active section carried in the URL
         (?section=) so reload and deep links keep the section. Fronted by the
         same #318 access gate as the page body below. -->
    <q-btn-toggle
      v-if="accessAllowed"
      :model-value="section"
      no-caps
      toggle-color="primary"
      color="white"
      text-color="primary"
      class="cs-subnav"
      :options="[
        { label: 'Roles', value: 'roles' },
        { label: 'Data', value: 'data' },
      ]"
      @update:model-value="selectSection"
    />

    <div v-if="checkingAccess" class="cs-loading">Checking access…</div>

    <q-banner
      v-else-if="!accessAllowed"
      class="bg-negative text-white access-denied"
    >
      You don't have permission to open Community Settings.
    </q-banner>

    <template v-else>
      <!-- Roles section (#398): the permission tables + org details. Kept
           mounted (v-show) so switching tabs never drops unsaved edits. -->
      <div v-show="section === 'roles'" class="cs-roles">
      <q-banner
        v-if="!store.canManageRoles && !store.loading"
        class="bg-warning text-dark q-mb-md"
      >
        You don't have permission to manage roles. The permission tables are
        read-only for you.
      </q-banner>
      <q-banner v-if="store.error" class="bg-negative text-white q-mb-md">
        {{ store.error }}
      </q-banner>
      <q-banner
        v-if="store.source === 'default'"
        class="bg-info text-white q-mb-md"
      >
        Showing the built-in default policy — it has never been customized.
        Saving creates the community's first policy version.
      </q-banner>

      <!-- Community permission table: community-scoped roles × the four
           Community-group capabilities (incl. Manage roles, which still gates
           edits of every table). These four capabilities are edited here only —
           they are excluded from the generic tables below. -->
      <section
        v-if="editableGrants"
        class="cs-section community-permissions-section"
      >
        <div class="section-header">
          <div>
            <h3 class="section-title">Community</h3>
            <p class="section-subtitle">
              Who may open and change community settings, manage members, and
              manage roles. Community roles only.
            </p>
          </div>
        </div>
        <q-markup-table
          flat
          bordered
          dense
          class="roles-matrix community-permissions-table"
        >
          <thead>
            <tr>
              <th class="text-left">Role</th>
              <th
                v-for="col in COMMUNITY_CAPS"
                :key="col.id"
                class="text-center"
              >
                {{ col.label }}
                <q-tooltip>{{ capabilityTooltip(col.id) }}</q-tooltip>
              </th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="role in communityRoles" :key="role.id">
              <td class="text-left">
                {{ role.displayName }}
                <q-badge v-if="!role.builtin" color="secondary" class="q-ml-xs"
                  >custom</q-badge
                >
              </td>
              <td
                v-for="col in COMMUNITY_CAPS"
                :key="col.id"
                class="text-center"
              >
                <q-toggle
                  :model-value="hasGrant(role.id, col.id)"
                  :disable="
                    !store.canManageRoles || isLockedCell(role.id, col.id)
                  "
                  dense
                  @update:model-value="
                    (v: boolean) => setGrant(role.id, col.id, v)
                  "
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

      <!-- Projects & Contributions feature table (#314): every project-and-
           contribution capability, one column each. Uniquely, its rows include
           the project-scoped roles (contributor / lead / steward) alongside the
           community roles — it is the only table that lists them. Reward is a
           community-only capability (it appears in this feature area but a project
           role cannot hold it), so it is disabled on the project rows. -->
      <section
        v-if="editableGrants"
        class="cs-section projects-section"
        data-feature="projects"
      >
        <div class="section-header">
          <div>
            <h3 class="section-title">Projects &amp; Contributions</h3>
            <p class="section-subtitle">
              Who can contribute, manage projects, review and sign off work,
              reward, and assign the per-project lead and steward — and who may
              see contribution budgets and actual costs. Community and project
              roles both appear here.
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
                  {{ capabilityTooltip(cap)
                  }}<template v-if="!isProjectCap(cap)">
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
                  >{{
                    role.scope === "project" ? "project" : "community"
                  }}</q-badge
                >
                <q-badge v-if="!role.builtin" color="secondary" class="q-ml-xs"
                  >custom</q-badge
                >
              </td>
              <td
                v-for="cap in projectsCapabilityIds"
                :key="cap"
                class="text-center"
                :data-cap="cap"
                :class="{
                  'community-only-cell':
                    role.scope === 'project' && !isProjectCap(cap),
                }"
              >
                <q-toggle
                  :model-value="hasGrant(role.id, cap)"
                  :disable="
                    !store.canManageRoles ||
                    (role.scope === 'project' &&
                      !isProjectCap(cap) &&
                      !hasGrant(role.id, cap))
                  "
                  dense
                  @update:model-value="
                    (v: boolean) => setGrant(role.id, cap, v)
                  "
                >
                  <q-tooltip
                    v-if="role.scope === 'project' && !isProjectCap(cap)"
                  >
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

      <!-- Community roles: who you are (membership credential). Every capability
           without its own feature table (the Community table above owns the four
           community-administration capabilities). -->
      <section v-if="editableGrants" class="cs-section community-section">
        <div class="section-header">
          <div>
            <h3 class="section-title">Community roles</h3>
            <p class="section-subtitle">
              Who you are in the community, issued as a membership credential.
              May hold any capability.
            </p>
          </div>
          <button
            class="cs-btn create"
            :disabled="!store.canManageRoles"
            @click="openNewRoleDialog('community')"
          >
            + New role
          </button>
        </div>
        <q-markup-table
          flat
          bordered
          dense
          class="roles-matrix community-roles"
        >
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
                <q-badge v-if="!role.builtin" color="secondary" class="q-ml-xs"
                  >custom</q-badge
                >
              </td>
              <td v-for="cap in capabilityIds" :key="cap" class="text-center">
                <q-toggle
                  :model-value="hasGrant(role.id, cap)"
                  :disable="!store.canManageRoles || isLockedCell(role.id, cap)"
                  dense
                  @update:model-value="
                    (v: boolean) => setGrant(role.id, cap, v)
                  "
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
      <section v-if="editableGrants" class="cs-section project-section">
        <div class="section-header">
          <div>
            <h3 class="section-title">Project roles</h3>
            <p class="section-subtitle">
              What you hold on a single project, assigned per project. Limited
              to project-scoped capabilities — community-only capabilities
              cannot be granted here (an existing legacy grant can only be
              switched off).
            </p>
          </div>
          <button
            class="cs-btn create"
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
                  {{ capabilityTooltip(cap)
                  }}<template v-if="!isProjectCap(cap)">
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
                <q-badge v-if="!role.builtin" color="secondary" class="q-ml-xs"
                  >custom</q-badge
                >
              </td>
              <td
                v-for="cap in capabilityIds"
                :key="cap"
                class="text-center"
                :class="{ 'community-only-cell': !isProjectCap(cap) }"
              >
                <q-toggle
                  :model-value="hasGrant(role.id, cap)"
                  :disable="
                    !store.canManageRoles ||
                    (!isProjectCap(cap) && !hasGrant(role.id, cap))
                  "
                  dense
                  @update:model-value="
                    (v: boolean) => setGrant(role.id, cap, v)
                  "
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
      <section v-if="editableGrants" class="cs-section proposals-section">
        <div class="section-header">
          <div>
            <h3 class="section-title">Proposals</h3>
            <p class="section-subtitle">
              Who may create and submit proposals, and who governs them (sign
              off, reject, edit, withdraw). Community roles; a project role
              shows here only for a grandfathered governance grant that can be
              removed but not re-added.
            </p>
          </div>
        </div>
        <q-markup-table
          flat
          bordered
          dense
          class="roles-matrix proposals-table"
        >
          <thead>
            <tr>
              <th class="text-left">Role</th>
              <th
                v-for="cap in proposalCapabilityIds"
                :key="cap"
                class="text-center"
              >
                {{ capabilityLabel(cap) }}
                <q-tooltip>{{ capabilityTooltip(cap) }}</q-tooltip>
              </th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="role in proposalRoles" :key="role.id">
              <td class="text-left">
                {{ role.displayName }}
                <q-badge
                  v-if="role.scope === 'project'"
                  color="primary"
                  class="q-ml-xs"
                  >project</q-badge
                >
                <q-badge v-if="!role.builtin" color="secondary" class="q-ml-xs"
                  >custom</q-badge
                >
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
                  @update:model-value="
                    (v: boolean) => setGrant(role.id, cap, v)
                  "
                >
                  <q-tooltip v-if="role.scope === 'project'">
                    Community-only capability — a project role cannot gain it.
                    <template v-if="hasGrant(role.id, cap)">
                      This grandfathered grant can be switched off, but not back
                      on.
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
      <section
        v-if="editableGrants"
        class="cs-section chat-section"
        data-feature="chat"
      >
        <div class="section-header">
          <div>
            <h3 class="section-title">Chat</h3>
            <p class="section-subtitle">
              Who can post messages, manage channels, and moderate others’
              messages. Sending is granted to every member role by default;
              managing and moderating default to stewards and the founder.
            </p>
          </div>
        </div>
        <q-markup-table flat bordered dense class="roles-matrix chat-roles">
          <thead>
            <tr>
              <th class="text-left">Role</th>
              <th
                v-for="cap in chatCapabilityIds"
                :key="cap"
                class="text-center"
                :data-cap="cap"
              >
                {{ capabilityLabel(cap) }}
                <q-tooltip>{{ capabilityTooltip(cap) }}</q-tooltip>
              </th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="role in communityRoles"
              :key="role.id"
              :data-role="role.id"
            >
              <td class="text-left">
                {{ role.displayName }}
                <q-badge v-if="!role.builtin" color="secondary" class="q-ml-xs"
                  >custom</q-badge
                >
              </td>
              <td
                v-for="cap in chatCapabilityIds"
                :key="cap"
                class="text-center"
                :data-cap="cap"
              >
                <q-toggle
                  :model-value="hasGrant(role.id, cap)"
                  :disable="!store.canManageRoles"
                  dense
                  @update:model-value="
                    (v: boolean) => setGrant(role.id, cap, v)
                  "
                />
              </td>
            </tr>
          </tbody>
        </q-markup-table>
      </section>

      <!-- Notices feature table (#317): the community-scoped notice-board
           capabilities (post notices, manage notices) per community role. Notice
           capabilities are community-only, so project roles are not listed. -->
      <section
        v-if="editableGrants"
        class="cs-section notices-section"
        data-feature="notices"
      >
        <div class="section-header">
          <div>
            <h3 class="section-title">Notices</h3>
            <p class="section-subtitle">
              Who can post notices (announcements, updates, events) and who can
              moderate them (pin, archive, edit others’). Posting is granted to
              every member role by default; managing defaults to stewards and
              the founder.
            </p>
          </div>
        </div>
        <q-markup-table flat bordered dense class="roles-matrix notices-roles">
          <thead>
            <tr>
              <th class="text-left">Role</th>
              <th
                v-for="cap in noticesCapabilityIds"
                :key="cap"
                class="text-center"
                :data-cap="cap"
              >
                {{ capabilityLabel(cap) }}
                <q-tooltip>{{ capabilityTooltip(cap) }}</q-tooltip>
              </th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="role in communityRoles"
              :key="role.id"
              :data-role="role.id"
            >
              <td class="text-left">
                {{ role.displayName }}
                <q-badge v-if="!role.builtin" color="secondary" class="q-ml-xs"
                  >custom</q-badge
                >
              </td>
              <td
                v-for="cap in noticesCapabilityIds"
                :key="cap"
                class="text-center"
                :data-cap="cap"
              >
                <q-toggle
                  :model-value="hasGrant(role.id, cap)"
                  :disable="!store.canManageRoles"
                  dense
                  @update:model-value="
                    (v: boolean) => setGrant(role.id, cap, v)
                  "
                />
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
            <p class="section-subtitle">
              The community's name, as shown across the app.
            </p>
          </div>
          <button
            class="cs-btn primary"
            :disabled="!orgDirty || !canManageOrg || savingOrg || !orgConfig"
            @click="saveOrg"
          >
            {{ savingOrg ? "Saving…" : "Save org details" }}
          </button>
        </div>

        <q-banner v-if="!canManageOrg" class="bg-warning text-dark q-mb-md">
          You don't have permission to change org details. This section is
          read-only for you.
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
      </div>

      <!-- Data section (#398): placeholder home for the schema editor (slice 4,
           #396). Until it lands, list the type definitions read-only from the
           types store — name, field count, and the core/custom split — so the
           tab is useful immediately. -->
      <div v-show="section === 'data'" class="cs-data">
        <section class="cs-section data-types-section">
          <div class="section-header">
            <div>
              <h3 class="section-title">Data types</h3>
              <p class="section-subtitle">
                The object types defined for this community. Editing schemas
                arrives in a later release — this is a read-only overview for
                now.
              </p>
            </div>
          </div>

          <div v-if="typesStore.loading" class="cs-loading">
            Loading type definitions…
          </div>
          <q-banner
            v-else-if="dataTypes.length === 0"
            class="bg-info text-white q-mb-md"
          >
            No type definitions are available.
          </q-banner>
          <q-markup-table
            v-else
            flat
            bordered
            dense
            class="roles-matrix data-types-table"
          >
            <thead>
              <tr>
                <th class="text-left">Type</th>
                <th class="text-center">Fields</th>
                <th class="text-center">Core</th>
                <th class="text-center">Custom</th>
              </tr>
            </thead>
            <tbody>
              <tr
                v-for="t in dataTypes"
                :key="t.name"
                :data-type="t.name"
              >
                <td class="text-left">{{ t.name }}</td>
                <td class="text-center">{{ t.total }}</td>
                <td class="text-center">{{ t.core }}</td>
                <td class="text-center">{{ t.custom }}</td>
              </tr>
            </tbody>
          </q-markup-table>
        </section>
      </div>
    </template>

    <q-dialog v-model="newRoleDialog">
      <q-card style="min-width: 360px">
        <q-card-section class="text-h6">
          New {{ newRoleScope === "project" ? "project" : "community" }} role
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
import { computed, onMounted, ref, watch } from "vue";
import { useQuasar } from "quasar";
import { useRoute, useRouter } from "vue-router";
import { useRolePolicyStore } from "src/stores/rolePolicy";
import { useTypesStore } from "src/stores/types";
import type { RoleDef, RoleScope } from "src/lib/api/rolePolicy";
import { checkCommunitySettingsAccess } from "src/lib/api/communitySettings";
import { fetchOrgConfig, saveOrgConfig, type OrgConfig } from "src/api/config";

const $q = useQuasar();
const route = useRoute();
const router = useRouter();
const store = useRolePolicyStore();
const typesStore = useTypesStore();

const checkingAccess = ref(true);
const accessAllowed = ref(false);

// --- Nested sub-nav (#398) --------------------------------------------------
// Two sections, Roles (default) and Data, carried in the URL (?section=) so a
// reload or deep link lands on the same tab.
type Section = "roles" | "data";
function normalizeSection(v: unknown): Section {
  return v === "data" ? "data" : "roles";
}
const section = ref<Section>(normalizeSection(route.query.section));

function selectSection(next: Section) {
  const value = normalizeSection(next);
  section.value = value;
  // Keep the URL in sync without stacking history entries.
  void router.replace({ query: { ...route.query, section: value } });
}

// Follow external URL changes (back/forward, deep links) into the active tab.
watch(
  () => route.query.section,
  (v) => {
    section.value = normalizeSection(v);
  },
);

// The four Community-group capability columns (backend group "Community",
// display order). Held here rather than derived from the server so the table is
// self-contained; manage_roles gates edits of every permission table. These are
// edited in the Community table only and excluded from the generic tables.
const COMMUNITY_CAPS = [
  { id: "open_community_settings", label: "Open settings" },
  { id: "manage_community_settings", label: "Manage settings" },
  { id: "manage_members", label: "Manage members" },
  { id: "manage_roles", label: "Manage roles" },
] as const;

// --- Role-policy state ------------------------------------------------------
const roles = ref<RoleDef[]>([]);
const editableGrants = ref<Record<string, string[]> | null>(null);
const saving = ref(false);
const newRoleDialog = ref(false);
const newRoleName = ref("");
const newRoleScope = ref<RoleScope>("community");
const copyFromRole = ref<string | null>(null);

// Proposals has its own per-feature permission table (#315/#312). Its two
// capabilities are therefore removed from the Community/Project tables below so
// each capability has exactly one editing surface.
const PROPOSAL_CAPABILITY_IDS = ["create_proposals", "manage_governance"];

// Defensive: only show a proposal column the backend actually advertises.
const proposalCapabilityIds = computed(() =>
  PROPOSAL_CAPABILITY_IDS.filter((c) => store.capabilityColumns.includes(c)),
);

// The Projects & Contributions feature has its own permission table (#314). Its
// capability IDs come from the server group metadata, with a fallback to the
// known IDs so the table still renders against an older backend.
const PROJECTS_CAPABILITY_IDS = [
  "contribute",
  "manage_projects",
  "review_work",
  "sign_off",
  "reward",
  "submit_completion",
  "approve_completion",
  "archive_work",
  "view_contribution_amounts",
  "assign_project_steward",
  "assign_project_lead",
];
const projectsCapabilityIds = computed(() => {
  const fromMeta = store.capabilitiesInGroup("Projects & Contributions");
  return fromMeta.length ? fromMeta : PROJECTS_CAPABILITY_IDS;
});

// The Chat feature has its own permission table (#316). Its capability IDs come
// from the server group metadata, with a fallback to the known IDs so the table
// still renders against an older backend.
const CHAT_CAPABILITY_IDS = [
  "send_messages",
  "manage_channels",
  "moderate_messages",
];
const chatCapabilityIds = computed(() => {
  const fromMeta = store.capabilitiesInGroup("Chat");
  return fromMeta.length ? fromMeta : CHAT_CAPABILITY_IDS;
});

// The Notices feature has its own permission table (#317). Its capability IDs
// come from the server group metadata, with a fallback to the known IDs so the
// table still renders against an older backend.
const NOTICES_CAPABILITY_IDS = ["post_notices", "manage_notices"];
const noticesCapabilityIds = computed(() => {
  const fromMeta = store.capabilitiesInGroup("Notices");
  return fromMeta.length ? fromMeta : NOTICES_CAPABILITY_IDS;
});

// Capabilities owned by a dedicated table above (the Community table's four
// included); the generic community/project matrices show every capability that
// does NOT yet have its own feature table.
const featureOwnedCapabilityIds = computed(
  () =>
    new Set([
      ...COMMUNITY_CAPS.map((c) => c.id),
      ...projectsCapabilityIds.value,
      ...PROPOSAL_CAPABILITY_IDS,
      ...chatCapabilityIds.value,
      ...noticesCapabilityIds.value,
    ]),
);
const capabilityIds = computed(() =>
  store.capabilityColumns.filter(
    (cap) => !featureOwnedCapabilityIds.value.has(cap),
  ),
);

// Local scope partitions so freshly-added (unsaved) roles show immediately.
const communityRoles = computed(() =>
  roles.value.filter((r) => (r.scope ?? "community") !== "project"),
);
const projectRoles = computed(() =>
  roles.value.filter((r) => r.scope === "project"),
);

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
const allRoles = computed(() => [
  ...communityRoles.value,
  ...projectRoles.value,
]);

function isProjectCap(cap: string): boolean {
  return store.isProjectCapability(cap);
}

// A proposal cell is disabled when the caller can't manage roles, or when a
// project-scoped role would be gaining a community-only capability it does not
// already hold (the #201 grandfather: keep/remove, never re-add).
function isProposalCellDisabled(role: RoleDef, cap: string): boolean {
  if (!store.canManageRoles) return true;
  const isProjectRole = role.scope === "project";
  return isProjectRole && !isProjectCap(cap) && !hasGrant(role.id, cap);
}

const CAPABILITY_LABELS: Record<string, string> = {
  contribute: "Contribute",
  manage_projects: "Manage projects",
  assign_work: "Assign work",
  review_work: "Review work",
  sign_off: "Sign off",
  reward: "Reward",
  submit_completion: "Submit completion",
  approve_completion: "Approve completion",
  archive_work: "Archive",
  manage_members: "Manage members",
  create_proposals: "Create proposals",
  manage_governance: "Governance",
  // Chat feature (#316).
  send_messages: "Send messages",
  manage_channels: "Manage channels",
  moderate_messages: "Moderate messages",
  // Notices feature (#317).
  post_notices: "Post notices",
  manage_notices: "Manage notices",
  manage_communications: "Communications",
  manage_roles: "Manage roles",
  // Projects & Contributions feature (#314).
  view_contribution_amounts: "View amounts",
  assign_project_steward: "Assign steward",
  assign_project_lead: "Assign lead",
};

function capabilityLabel(cap: string): string {
  // Prefer the curated short column label; fall back to the server-provided
  // display name (so a capability this build does not know still gets a
  // readable header), then the raw ID.
  return CAPABILITY_LABELS[cap] || store.capabilityDisplayName(cap) || cap;
}

function capabilityTooltip(cap: string): string {
  const actions = store.capabilities[cap] ?? [];
  return actions.length
    ? `Actions: ${actions.join(", ")}`
    : "No enforced actions yet";
}

function resetFromStore() {
  roles.value = (store.policy?.roles ?? []).map((r) => ({ ...r }));
  editableGrants.value = Object.fromEntries(
    Object.entries(store.policy?.grants ?? {}).map(([k, v]) => [k, [...v]]),
  );
}

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

// The last remaining manage_roles toggle is locked ON (spec §6) — a policy
// nobody can edit via roles is almost certainly a mistake (mirrors the backend
// invariant).
function isLockedCell(roleId: string, cap: string): boolean {
  if (cap !== "manage_roles" || !hasGrant(roleId, cap)) return false;
  const holders = Object.entries(editableGrants.value ?? {}).filter(
    ([, caps]) => caps.includes("manage_roles"),
  );
  return holders.length === 1 && holders[0]?.[0] === roleId;
}

function roleScopeOf(roleId: string): RoleScope {
  const r = roles.value.find((x) => x.id === roleId);
  return r?.scope === "project" ? "project" : "community";
}

function setGrant(roleId: string, cap: string, value: boolean) {
  if (!editableGrants.value) return;
  // A project role may never hold a community-only capability.
  if (value && roleScopeOf(roleId) === "project" && !isProjectCap(cap)) return;
  const caps = editableGrants.value[roleId] ?? [];
  if (value && !caps.includes(cap)) {
    editableGrants.value[roleId] = [...caps, cap];
  } else if (!value) {
    editableGrants.value[roleId] = caps.filter((c) => c !== cap);
  }
}

const newRoleId = computed(() =>
  newRoleName.value.trim().toLowerCase().replace(/\s+/g, "_"),
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
  newRoleName.value = "";
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
  let caps = copyFromRole.value
    ? [...(editableGrants.value[copyFromRole.value] ?? [])]
    : [];
  // Defensive: a project role only keeps project-scoped capabilities.
  if (scope === "project") caps = caps.filter((c) => isProjectCap(c));
  editableGrants.value[newRoleId.value] = caps;
  newRoleName.value = "";
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
    // save() only refreshes policy/source on success, so callerCapabilities
    // (and the nav gate) can go stale when an admin edits their own role's
    // grants. Reload so canManageRoles reflects the just-saved policy.
    void store.load();
    $q.notify({ type: "positive", message: "Role policy saved" });
  } else if (store.error) {
    $q.notify({ type: "negative", message: store.error });
    resetFromStore();
  }
}

// --- Data section state (#398) ---------------------------------------------
// Read-only overview of the type definitions: name, field count, and the
// core/custom split (core = structural fields the backend depends on).
const dataTypes = computed(() =>
  [...typesStore.definitions.values()]
    .map((def) => {
      const total = def.fields?.length ?? 0;
      const core = (def.fields ?? []).filter((f) => f.core).length;
      return { name: def.name, total, core, custom: total - core };
    })
    .sort((a, b) => a.name.localeCompare(b.name)),
);

// --- Org settings state ----------------------------------------------------
const orgConfig = ref<OrgConfig | null>(null);
const orgName = ref("");
const savingOrg = ref(false);

const canManageOrg = computed(() => store.can("manage_community_settings"));
const orgDirty = computed(
  () =>
    orgConfig.value !== null &&
    orgName.value !== orgConfig.value.organization.name,
);

async function loadOrg() {
  const result = await fetchOrgConfig();
  if (result.status === "configured") {
    orgConfig.value = result.config;
    orgName.value = result.config.organization.name;
  } else if (result.status === "server_unreachable" && result.cached) {
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
      organization: {
        ...orgConfig.value.organization,
        name: orgName.value.trim(),
      },
    };
    await saveOrgConfig(updated);
    orgConfig.value = updated;
    $q.notify({ type: "positive", message: "Org details saved" });
  } catch (e) {
    $q.notify({
      type: "negative",
      message: e instanceof Error ? e.message : String(e),
    });
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
  // Feed the Data tab's read-only type overview (idempotent load).
  if (!typesStore.loaded) void typesStore.loadDefinitions();
});
watch(() => store.policy?.version, resetFromStore);
</script>

<style scoped>
.community-settings-page {
  padding: 24px;
}

.cs-header {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 16px;
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

.cs-actions {
  display: flex;
  gap: 8px;
  flex-shrink: 0;
}

.cs-subnav {
  margin-bottom: 20px;
  border: 1px solid var(--matou-border, rgba(0, 0, 0, 0.12));
  border-radius: 10px;
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

.cs-btn.create {
  background: transparent;
  color: var(--matou-teal, #0d9488);
}

.cs-btn:disabled {
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

.org-name-input {
  max-width: 420px;
}
</style>
