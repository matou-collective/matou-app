<template>
  <div class="project-detail-page">
    <!-- Loading -->
    <div v-if="!project && !projectsStore.error" class="loading-state">
      <q-spinner-dots size="40px" color="primary" />
    </div>

    <template v-else-if="project">
      <!-- Back nav -->
      <div class="page-nav">
        <q-btn flat round icon="arrow_back" @click="router.push({ name: 'projects' })" />
        <span class="page-nav-label">Projects</span>
      </div>

      <!-- ── Project header ──────────────────────────────── -->
      <div class="project-header">
        <div class="project-header-main">
          <div class="header-badges">
            <span class="project-status-badge" :class="project.status">
              {{ formatStatus(project.status) }}
            </span>
          </div>
          <h1 class="project-title">{{ project.title }}</h1>
          <p class="project-description">{{ project.description }}</p>

          <!-- Team chips -->
          <div class="team-row">
            <div class="team-chip lead" v-if="project.project_lead_id">
              <Shield class="team-icon" />
              <span>Project Lead</span>
              <strong>{{ resolvedLeadName }}</strong>
            </div>
            <button
              v-else-if="perms.canAssignRoles.value"
              class="assign-chip"
              @click="openAssignRole('lead')"
            >
              <UserPlus class="team-icon" />
              Assign Lead
            </button>

            <div class="team-chip steward" v-if="project.project_steward_id">
              <Users class="team-icon" />
              <span>Project Steward</span>
              <strong>{{ resolvedStewardName }}</strong>
            </div>
            <button
              v-else-if="perms.canAssignRoles.value"
              class="assign-chip"
              @click="openAssignRole('steward')"
            >
              <UserPlus class="team-icon" />
              Assign Steward
            </button>
          </div>
        </div>
        <div class="project-header-actions">
          <q-btn
            v-if="perms.canEditProject.value"
            flat
            no-caps
            icon="edit"
            label="Edit"
            @click="showEditDialog = true"
          />
        </div>
      </div>

      <!-- ── Linked Proposals ───────────────────────────── -->
      <div v-if="linkedProposals.length > 0" class="content-section">
        <h3 class="section-title">
          <Vote class="section-icon" />
          Linked Proposals
        </h3>
        <div class="proposals-list">
          <div
            v-for="p in linkedProposals"
            :key="p.id"
            class="proposal-row"
            @click="router.push({ name: 'proposal-detail', params: { id: p.id } })"
          >
            <span class="proposal-title">{{ p.title }}</span>
            <span class="proposal-status-badge" :class="p.status">{{ formatStatus(p.status) }}</span>
            <ChevronRight class="row-arrow" />
          </div>
        </div>
      </div>

      <!-- ── Project Completion ────────────────────────── -->
      <ProjectCompletionSection
        v-if="project.status === 'active' || project.status === 'pending_completion' || project.status === 'completed'"
        :project="project"
        :contributions="allProjectContributions"
        :can-submit="perms.canSubmitProjectCompletion.value"
        :can-approve="perms.canApproveProjectCompletion.value"
        @submit="onSubmitCompletion"
        @approve="onApproveCompletion"
        @reject="onRejectCompletion"
      />

      <!-- ── Implementation Plan ───────────────────────── -->
      <div class="content-section">
        <div class="section-header">
          <h3 class="section-title">
            <ClipboardList class="section-icon" />
            Implementation Plan
            <span v-if="implementationPlan?.signed_off" class="signed-off-badge">
              <CheckCircle class="signed-off-icon" />
              Signed Off
            </span>
          </h3>
          <div class="section-actions">
            <q-btn
              v-if="perms.canSignOffPlan.value && implementationPlan && !implementationPlan.signed_off && canSignOffPlan"
              flat
              no-caps
              label="Sign Off Plan"
              color="positive"
              icon="check_circle"
              :loading="signingOffPlan"
              @click="handleSignOffPlan"
            />
            <q-btn
              v-if="perms.canAddMilestones.value"
              flat
              no-caps
              icon="add"
              label="Add Milestone"
              color="primary"
              @click="showAddMilestoneDialog = true"
            />
          </div>
        </div>

        <!-- No milestones yet -->
        <div v-if="milestones.length === 0" class="empty-plan">
          <Clock class="empty-icon" />
          <span>No milestones yet</span>
          <span class="empty-hint">Create your first milestone to begin planning the implementation</span>
          <q-btn
            v-if="perms.canAddMilestones.value"
            outline
            no-caps
            icon="add"
            label="Create First Milestone"
            @click="showAddMilestoneDialog = true"
          />
        </div>

        <!-- Has milestones -->
        <template v-if="implementationPlan">
          <!-- Confirmation progress bar -->
          <div v-if="!implementationPlan.signed_off && planContributions.length > 0" class="progress-section">
            <div class="progress-label">
              Confirmation Progress — {{ confirmedCount }}/{{ planContributions.length }} confirmed
            </div>
            <q-linear-progress
              :value="confirmationProgress"
              color="primary"
              class="progress-bar"
            />
          </div>

          <!-- Plan-modified banner (was signed off, then a milestone or contribution was edited/archived) -->
          <div v-if="planWasModified" class="plan-modified-banner">
            <AlertCircle class="banner-icon" />
            <div>
              <div class="banner-title">Plan modified — re-signoff required</div>
              <div class="banner-subtitle">
                A milestone or contribution was changed since the plan was last signed off.
                Contributions cannot be signed off until the plan is re-signed.
                <span v-if="implementationPlan.signed_off_by">
                  Last signed off by {{ implementationPlan.signed_off_by }}<span v-if="implementationPlan.signed_off_at"> on {{ formatDate(implementationPlan.signed_off_at) }}</span>.
                </span>
              </div>
            </div>
            <q-btn
              v-if="perms.canSignOffPlan.value"
              no-caps
              color="primary"
              label="Re-Sign Off Plan"
              class="q-ml-auto"
              :loading="signingOffPlan"
              @click="handleSignOffPlan"
            />
          </div>

          <!-- Sign-off banner (all confirmed, not yet signed off) -->
          <div v-else-if="allContributionsConfirmed && !implementationPlan.signed_off" class="sign-off-banner">
            <CheckCircle class="banner-icon" />
            <div>
              <div class="banner-title">All contributions confirmed — plan is ready for sign-off</div>
            </div>
            <q-btn
              v-if="perms.canSignOffPlan.value"
              no-caps
              color="primary"
              label="Sign Off Plan"
              class="q-ml-auto"
              :loading="signingOffPlan"
              @click="handleSignOffPlan"
            />
          </div>

          <!-- Milestones -->
          <div v-if="milestones.length === 0" class="empty-milestones">
            <Clock class="empty-icon" />
            <span>No milestones yet.</span>
          </div>

          <div v-else class="milestones-list">
            <MilestoneCard
              v-for="(milestone, idx) in milestones"
              :key="milestone.milestone_id"
              :milestone="milestone"
              :milestone-number="idx + 1"
              :project-id="project.id"
              :can-edit="perms.canAddMilestones.value"
              :can-confirm="perms.canConfirmContribution.value"
              :is-plan-signed-off="implementationPlan.signed_off"
              :user-role="currentUserRole"
              :current-user-id="currentUserId"
              :all-contributions="planContributions"
              @create-contribution="handleCreateContribution"
              @update-contribution="handleContributionUpdate"
              @view-contribution="handleViewContribution"
              @create-child-contribution="handleCreateChildContribution"
              @assign-contribution="handleAssignContribution"
              @edit-milestone="openEditMilestone"
              @archive-milestone="confirmArchiveMilestone"
              @edit-contribution="openEditContribution"
              @archive-contribution="confirmArchiveContribution"
            />
          </div>
        </template>
      </div>
    </template>

    <!-- Not found -->
    <div v-else class="empty-state">
      <h3>Project not found</h3>
      <q-btn flat no-caps label="Back to Projects" @click="router.push({ name: 'projects' })" />
    </div>

    <!-- Edit dialog -->
    <ProjectForm
      v-model="showEditDialog"
      :project="project"
      :is-submitting="isSubmitting"
      :submit-error="submitError"
      :available-proposals="proposalsStore.proposals"
      :linking="linking"
      :can-delete="perms.canArchiveProject.value"
      @submit="handleEditSubmit"
      @link-proposal="handleLinkProposal"
      @delete="onDeleteRequested"
    />

    <!-- Destroy project confirm -->
    <ConfirmDestroyDialog
      v-model="showDestroy"
      title="Delete Project"
      :entity-label="project?.title ?? ''"
      :cascade-summary="cascadeSummary"
      :loading="archivingProject"
      @confirm="confirmDestroy"
    />

    <!-- Create plan dialog -->
    <q-dialog v-model="showCreatePlanDialog">
      <q-card style="min-width: 480px">
        <q-card-section class="row items-center q-pb-none">
          <div class="text-h6">Create Implementation Plan</div>
          <q-space />
          <q-btn icon="close" flat round dense v-close-popup />
        </q-card-section>
        <q-card-section class="q-gutter-md">
          <q-input v-model="newPlan.total_budget" label="Total Budget" outlined placeholder="e.g. $50,000" />
          <q-input v-model="newPlan.project_lead" label="Project Lead ID" outlined placeholder="Lead AID" />
          <q-input v-model="newPlan.project_steward_id" label="Project Steward ID" outlined placeholder="Steward AID" />
        </q-card-section>
        <q-card-actions align="right" class="q-px-md q-pb-md">
          <q-btn flat no-caps label="Cancel" v-close-popup />
          <q-btn no-caps label="Create Plan" color="primary" :loading="creatingPlan" @click="handleCreatePlan" />
        </q-card-actions>
      </q-card>
    </q-dialog>

    <!-- Add / Edit milestone dialog -->
    <MilestoneFormDialog
      v-model="showAddMilestoneDialog"
      :project-id="project?.id ?? ''"
      :implementation-plan-id="implementationPlan?.id ?? ''"
      :milestone="editingMilestone"
      :is-submitting="addingMilestone"
      @submit="handleAddMilestone"
    />

    <!-- Archive milestone confirm -->
    <ConfirmArchiveDialog
      v-model="showArchiveMilestone"
      title="Archive Milestone"
      :message="milestoneArchiveMessage"
      :loading="archivingMilestoneLoading"
      @confirm="doArchiveMilestone"
    />

    <!-- Assign role dialog -->
    <AssignRoleDialog
      v-model="showAssignRoleDialog"
      :role="assignRoleTarget"
      :members="communityMembers"
      :is-submitting="assigningRole"
      @assign="handleAssignRole"
    />

    <!-- Create contribution dialog -->
    <CreateContributionDialog
      v-model="showCreateContributionDialog"
      :project-id="project?.id ?? ''"
      :milestone-id="createContributionMilestoneId"
      :is-submitting="creatingContribution"
      @submit="handleCreateContributionSubmit"
    />

    <!-- Create sub-contribution dialog -->
    <CreateContributionDialog
      v-model="showCreateSubDialog"
      :project-id="project?.id ?? ''"
      :parent-contribution-id="createSubParentId"
      :is-submitting="creatingContribution"
      @submit="handleCreateSubContributionSubmit"
    />

    <!-- Contribution detail dialog -->
    <ContributionDetailDialog
      v-if="viewingContribution"
      v-model="showContributionDetail"
      :contribution="viewingContribution"
      :user-role="currentUserRole"
      :current-user-id="currentUserId"
      :current-user-name="currentUserName"
      :all-contributions="allProjectContributions"
      :is-plan-signed-off="implementationPlan?.signed_off ?? false"
      @update="handleContributionUpdate"
      @create-child-contribution="handleCreateChildContribution"
      @edit-sub-contribution="openEditContribution"
      @archive-sub-contribution="confirmArchiveContribution"
    />

    <!-- Assign contribution dialog -->
    <q-dialog v-model="showAssignDialog">
      <q-card class="assign-dialog">
        <q-card-section class="row items-center q-pb-none">
          <div class="text-h6">Assign Contribution</div>
          <q-space />
          <q-btn icon="close" flat round dense v-close-popup />
        </q-card-section>

        <q-card-section v-if="assignTarget" class="assign-body">
          <!-- Registered interest members -->
          <div v-if="assignTarget.interested_contributors?.length" class="assign-section">
            <div class="assign-section-label">Registered Interest</div>
            <div
              v-for="ic in assignTarget.interested_contributors"
              :key="ic.user_id"
              class="assign-member-row"
              :class="{ selected: assignSelectedMember === ic.user_id }"
              @click="selectMember(ic.user_id, ic.user_name)"
            >
              <div>
                <div class="assign-member-name">{{ ic.user_name || ic.user_id.slice(0, 12) + '...' }}</div>
                <div v-if="ic.interest_note" class="assign-member-note">{{ ic.interest_note }}</div>
              </div>
              <q-icon v-if="assignSelectedMember === ic.user_id" name="check_circle" color="primary" size="18px" />
            </div>
          </div>

          <!-- Mode selection: Group or Member -->
          <div class="assign-section">
            <div class="assign-section-label">Assign to</div>
            <div class="assign-mode-row">
              <button
                class="assign-mode-card"
                :class="{ active: assignMode === 'group' }"
                @click="assignMode = 'group'; assignSelectedMember = null; assignSelectedMemberName = null"
              >
                <q-icon name="groups" size="20px" />
                <span>Group</span>
              </button>
              <button
                class="assign-mode-card"
                :class="{ active: assignMode === 'member' }"
                @click="assignMode = 'member'; assignSelectedGroup = null"
              >
                <q-icon name="person" size="20px" />
                <span>Member</span>
              </button>
            </div>
          </div>

          <!-- Group list -->
          <div v-if="assignMode === 'group'" class="assign-section">
            <div
              v-for="g in assignGroupOptions"
              :key="g.value"
              class="assign-member-row"
              :class="{ selected: assignSelectedGroup === g.value }"
              @click="assignSelectedGroup = g.value"
            >
              <div class="assign-member-name">{{ g.label }}</div>
              <q-icon v-if="assignSelectedGroup === g.value" name="check_circle" color="primary" size="18px" />
            </div>
          </div>

          <!-- Member search + list -->
          <div v-if="assignMode === 'member'" class="assign-section">
            <q-input
              v-model="assignMemberSearch"
              outlined
              dense
              placeholder="Search members..."
              class="q-mb-sm"
            >
              <template #prepend>
                <q-icon name="search" />
              </template>
            </q-input>
            <div class="assign-member-list">
              <div
                v-for="m in filteredAssignMembers"
                :key="m.id"
                class="assign-member-row"
                :class="{ selected: assignSelectedMember === m.id }"
                @click="selectMember(m.id, m.name)"
              >
                <div class="assign-member-name">{{ m.name }}</div>
                <q-icon v-if="assignSelectedMember === m.id" name="check_circle" color="primary" size="18px" />
              </div>
              <div v-if="filteredAssignMembers.length === 0" class="assign-empty">
                No members found
              </div>
            </div>
          </div>
        </q-card-section>

        <div class="assign-actions q-px-md q-pb-md">
          <q-btn outline no-caps label="Cancel" color="primary" class="assign-action-btn" v-close-popup />
          <q-btn
            no-caps
            label="Assign"
            color="primary"
            class="assign-action-btn"
            :disable="!canSubmitAssign"
            :loading="assigningContribution"
            @click="submitAssign"
          />
        </div>
      </q-card>
    </q-dialog>

    <!-- Edit contribution dialog -->
    <!-- eslint-disable-next-line @typescript-eslint/no-explicit-any -->
    <ContributionForm
      v-model="showContribForm"
      :contribution="(editingContribution as any)"
      :can-unassign="perms.canUnassignContributor.value"
      @submit="onContributionSave"
      @unassign="onUnassignRequested"
    />

    <!-- Archive contribution confirm -->
    <ConfirmArchiveDialog
      v-model="showArchiveContrib"
      title="Archive Contribution"
      :message="contribArchiveMessage"
      :loading="archivingContribLoading"
      @confirm="doArchiveContribution"
    />

    <!-- Unassign contributor confirm -->
    <ConfirmArchiveDialog
      v-model="showUnassignConfirm"
      title="Unassign Contributor"
      message="This will set the contribution back to 'confirmed' and clear the assigned contributor."
      confirm-label="Unassign"
      icon="person_remove"
      :loading="unassigning"
      @confirm="doUnassign"
    />
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, onBeforeUnmount, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useQuasar } from 'quasar';
import {
  Shield,
  Users,
  UserPlus,
  Vote,
  ChevronRight,
  ClipboardList,
  CheckCircle,
  Clock,
  AlertCircle,
} from 'lucide-vue-next';
import { useProjectsStore } from 'stores/projects';
import { useProposalsStore } from 'stores/proposals';
import { useIdentityStore } from 'stores/identity';
import { useContributionsStore } from 'stores/contributions';
import type { Contribution, Milestone, CreateMilestoneRequest } from 'src/types/projects';
import type { CreateContributionRequest, UpdateContributionRequest } from 'src/lib/api/contributions';
import type { UpdateMilestoneRequest } from 'src/lib/api/implementationPlans';
import { useProjectPermissions } from 'src/composables/useProjectPermissions';
import { useContributionWorkflow } from 'src/composables/useContributionWorkflow';
import { useBackendEvents } from 'src/composables/useBackendEvents';
import ProjectForm from 'src/components/projects/ProjectForm.vue';
import MilestoneCard from 'src/components/projects/MilestoneCard.vue';
import MilestoneFormDialog from 'src/components/projects/MilestoneFormDialog.vue';
import AssignRoleDialog from 'src/components/projects/AssignRoleDialog.vue';
import CreateContributionDialog from 'src/components/projects/CreateContributionDialog.vue';
import ContributionDetailDialog from 'src/components/projects/ContributionDetailDialog.vue';
import ContributionForm from 'src/components/contributions/ContributionForm.vue';
import ConfirmDestroyDialog from 'src/components/common/ConfirmDestroyDialog.vue';
import ConfirmArchiveDialog from 'src/components/common/ConfirmArchiveDialog.vue';
import ProjectCompletionSection from 'src/components/projects/ProjectCompletionSection.vue';

const route = useRoute();
const router = useRouter();
const $q = useQuasar();
const projectsStore = useProjectsStore();
const proposalsStore = useProposalsStore();
const identityStore = useIdentityStore();
const contributionsStore = useContributionsStore();
const workflow = useContributionWorkflow();
const isKeriAdmin = computed(() => identityStore.isAdmin);
const { lastEvent } = useBackendEvents();

// ── Current user context ─────────────────────────────────────────────────────

const currentUserId = computed(() => identityStore.aidPrefix ?? '');
const currentUserName = computed(() => {
  const id = currentUserId.value;
  if (!id) return '';
  const member = communityMembersList.value.find(m => m.id === id);
  return member?.name || '';
});
const currentUserRole = computed(() => {
  // KERI-verified admin (founding member, steward, etc.) gets full admin role
  if (isKeriAdmin.value) return 'community_admin';
  const p = project.value;
  if (!p) return 'member';
  if (p.project_lead_id === currentUserId.value) return 'project_lead';
  if (p.project_steward_id === currentUserId.value) return 'project_steward';
  return 'member';
});

const currentUserRef = computed(() => ({
  id: currentUserId.value,
  name: '',
  role: currentUserRole.value,
}));

const project = computed(() => projectsStore.currentProject);
const perms = useProjectPermissions(project, currentUserRef);

// ── Local state ──────────────────────────────────────────────────────────────

const isSubmitting = ref(false);
const submitError = ref<string | null>(null);
const linking = ref(false);
const creatingPlan = ref(false);
const addingMilestone = ref(false);
const signingOffPlan = ref(false);
const assigningRole = ref(false);
const creatingContribution = ref(false);

const showEditDialog = ref(false);
const showCreatePlanDialog = ref(false);
const showAddMilestoneDialog = ref(false);
const showAssignRoleDialog = ref(false);
const showCreateContributionDialog = ref(false);
const showCreateSubDialog = ref(false);
const showContributionDetail = ref(false);

const assignRoleTarget = ref<'lead' | 'steward'>('lead');
const createContributionMilestoneId = ref<string | undefined>(undefined);
const createSubParentId = ref<string | undefined>(undefined);
const viewingContribution = ref<Contribution | null>(null);

// ── Project destroy state ────────────────────────────────────────────────────

const showDestroy = ref(false);
const archivingProject = ref(false);

const cascadeSummary = computed<string[]>(() => {
  if (!project.value) return [];
  const plan = projectsStore.implementationPlans[project.value.id] ?? null;
  const contribs = planContributions.value;
  const milestoneCount = milestones.value.length;
  const subCount = contribs.filter(c => !!c.parent_contribution).length;
  const topCount = contribs.length - subCount;
  return [
    plan ? '1 implementation plan' : '0 implementation plans',
    `${milestoneCount} milestone${milestoneCount === 1 ? '' : 's'}`,
    `${topCount} contribution${topCount === 1 ? '' : 's'}`,
    `${subCount} sub-contribution${subCount === 1 ? '' : 's'}`,
  ];
});

function onDeleteRequested() {
  showEditDialog.value = false;
  showDestroy.value = true;
}

async function confirmDestroy() {
  if (!project.value) return;
  archivingProject.value = true;
  try {
    await projectsStore.archive(project.value.id);
    showDestroy.value = false;
    await router.push({ name: 'projects' });
  } finally {
    archivingProject.value = false;
  }
}

// ── Milestone edit/archive state ─────────────────────────────────────────────

const editingMilestone = ref<Milestone | null>(null);
const showArchiveMilestone = ref(false);
const archivingMilestone = ref<Milestone | null>(null);
const archivingMilestoneLoading = ref(false);

const milestoneArchiveMessage = computed(() => {
  const ms = archivingMilestone.value;
  if (!ms || !project.value) return '';
  const childContribs = planContributions.value.filter(c => c.milestone_id === ms.milestone_id);
  const subs = childContribs.filter(c => !!c.parent_contribution).length;
  const tops = childContribs.length - subs;
  return `Archiving "${ms.title}" will also archive ${tops} contribution${tops === 1 ? '' : 's'} and ${subs} sub-contribution${subs === 1 ? '' : 's'}. This cannot be undone from the UI.`;
});

function openEditMilestone(ms: Milestone) {
  editingMilestone.value = ms;
  showAddMilestoneDialog.value = true;
}

function confirmArchiveMilestone(ms: Milestone) {
  archivingMilestone.value = ms;
  showArchiveMilestone.value = true;
}

async function doArchiveMilestone() {
  if (!archivingMilestone.value || !project.value) return;
  archivingMilestoneLoading.value = true;
  try {
    await projectsStore.archiveMilestone(project.value.id, archivingMilestone.value.milestone_id);
    showArchiveMilestone.value = false;
    archivingMilestone.value = null;
    $q.notify({ type: 'positive', message: 'Milestone archived.' });
  } catch (e) {
    $q.notify({ type: 'negative', message: e instanceof Error ? e.message : 'Failed to archive milestone' });
  } finally {
    archivingMilestoneLoading.value = false;
  }
}

// ── Contribution edit/archive state ──────────────────────────────────────────

const editingContribution = ref<Contribution | null>(null);
const showContribForm = ref(false);
const showArchiveContrib = ref(false);
const archivingContribution = ref<Contribution | null>(null);
const archivingContribLoading = ref(false);
const showUnassignConfirm = ref(false);
const unassigning = ref(false);

const contribArchiveMessage = computed(() => {
  const c = archivingContribution.value;
  if (!c || !project.value) return '';
  const subs = planContributions.value.filter(x => x.parent_contribution === c.id).length;
  const subText = subs > 0 ? ` and its ${subs} sub-contribution${subs === 1 ? '' : 's'}` : '';
  return `Archiving "${c.title}"${subText} cannot be undone from the UI.`;
});

function openEditContribution(c: Contribution) {
  editingContribution.value = c;
  showContribForm.value = true;
}

function confirmArchiveContribution(c: Contribution) {
  archivingContribution.value = c;
  showArchiveContrib.value = true;
}

async function doArchiveContribution() {
  if (!archivingContribution.value || !project.value) return;
  archivingContribLoading.value = true;
  try {
    await contributionsStore.archive(archivingContribution.value.id);
    // Refresh BOTH the implementation plan (top-level contributions hydrated
    // in milestones) AND the project contributions list (which includes
    // sub-contributions). The dialog's allContributions prop reads from the
    // latter; without this, archived subs stay visible in the sub-list.
    if (project.value) {
      await Promise.all([
        projectsStore.fetchImplementationPlan(project.value.id),
        projectsStore.fetchProjectContributions(project.value.id),
      ]);
    }
    // Close the contribution detail dialog if it's showing the archived
    // contribution (so user isn't left looking at a stale view of an
    // archived item).
    if (viewingContribution.value?.id === archivingContribution.value.id) {
      showContributionDetail.value = false;
      viewingContribution.value = null;
    }
    showArchiveContrib.value = false;
    archivingContribution.value = null;
    $q.notify({ type: 'positive', message: 'Contribution archived.' });
  } catch (e) {
    $q.notify({ type: 'negative', message: e instanceof Error ? e.message : 'Failed to archive contribution' });
  } finally {
    archivingContribLoading.value = false;
  }
}

async function onContributionSave(req: UpdateContributionRequest) {
  if (!editingContribution.value || !project.value) return;
  try {
    await contributionsStore.update(editingContribution.value.id, req);
    if (project.value) await projectsStore.fetchImplementationPlan(project.value.id);
    showContribForm.value = false;
    editingContribution.value = null;
    $q.notify({ type: 'positive', message: 'Contribution updated!' });
  } catch (e) {
    $q.notify({ type: 'negative', message: e instanceof Error ? e.message : 'Failed to update contribution' });
  }
}

function onUnassignRequested() {
  showUnassignConfirm.value = true;
}

async function doUnassign() {
  if (!editingContribution.value || !project.value) return;
  unassigning.value = true;
  try {
    await contributionsStore.unassign(editingContribution.value.id);
    if (project.value) await projectsStore.fetchImplementationPlan(project.value.id);
    showUnassignConfirm.value = false;
    showContribForm.value = false;
    editingContribution.value = null;
    $q.notify({ type: 'positive', message: 'Contributor unassigned.' });
  } catch (e) {
    $q.notify({ type: 'negative', message: e instanceof Error ? e.message : 'Failed to unassign' });
  } finally {
    unassigning.value = false;
  }
}

const showAssignDialog = ref(false);
const assignTarget = ref<Contribution | null>(null);
const assignMode = ref<'group' | 'member' | null>(null);
const assignSelectedGroup = ref<string | null>(null);
const assignSelectedMember = ref<string | null>(null);
const assignSelectedMemberName = ref<string | null>(null);
const assignMemberSearch = ref('');
const assigningContribution = ref(false);

const assignGroupOptions = [
  { label: 'Stewards', value: 'steward' },
  { label: 'Members', value: 'all' },
];

const filteredAssignMembers = computed(() => {
  const q = assignMemberSearch.value.toLowerCase().trim();
  if (!q) return communityMembersList.value;
  return communityMembersList.value.filter(m => m.name.toLowerCase().includes(q));
});

const canSubmitAssign = computed(() => {
  if (assignMode.value === 'group') return !!assignSelectedGroup.value;
  if (assignMode.value === 'member') return !!assignSelectedMember.value;
  // Also allow submit if a registered member was selected directly
  return !!assignSelectedMember.value;
});

const newPlan = ref({ total_budget: '', project_lead: '', project_steward_id: '' });

// ── Derived ──────────────────────────────────────────────────────────────────

const implementationPlan = computed(() => {
  const id = project.value?.id;
  if (!id) return null;
  return projectsStore.implementationPlans[id] ?? null;
});

const milestones = computed(() => implementationPlan.value?.milestones ?? []);

const allProjectContributions = computed<Contribution[]>(() => {
  const id = project.value?.id;
  if (!id) return [];
  return projectsStore.projectContributions[id] ?? [];
});

const planContributions = computed<Contribution[]>(() => {
  // Use hydrated contributions from milestones (populated by HydratePlan in the backend)
  const hydrated = milestones.value.flatMap((m) => (m.contributions ?? []) as Contribution[]);
  if (hydrated.length > 0) return hydrated;
  // Fallback: join contribution_ids with separately-fetched project contributions
  const contribIds = new Set(milestones.value.flatMap((m) => m.contribution_ids ?? []));
  return allProjectContributions.value.filter((c) => contribIds.has(c.contribution_id ?? c.id));
});

const confirmedCount = computed(
  () => planContributions.value.filter((c) => c.status === 'confirmed').length,
);

const confirmationProgress = computed(() => {
  const total = planContributions.value.length;
  return total > 0 ? confirmedCount.value / total : 0;
});

const allContributionsConfirmed = computed(
  () =>
    planContributions.value.length > 0 &&
    planContributions.value.every((c) => c.status === 'confirmed'),
);

const canSignOffPlan = computed(
  () => allContributionsConfirmed.value && milestones.value.every((m) => (m.contribution_ids?.length ?? 0) > 0),
);

// Plan was previously signed off (signed_off_at is set as historical record)
// but is no longer signed off — meaning a milestone or contribution was edited
// or archived since the last signoff and re-signoff is required.
const planWasModified = computed(
  () =>
    !!implementationPlan.value
    && !implementationPlan.value.signed_off
    && !!implementationPlan.value.signed_off_at,
);

function formatDate(iso: string): string {
  if (!iso) return '';
  return new Date(iso).toLocaleDateString();
}

const linkedProposals = computed(() => {
  const p = project.value;
  if (!p?.proposal_ids?.length) return [];
  return proposalsStore.proposals.filter((pr) => p.proposal_ids!.includes(pr.id));
});

// Community members for AssignRoleDialog — fetched from SharedProfile API
const communityMembersList = ref<{ id: string; name: string; role: string }[]>([]);
const communityMembers = computed(() => communityMembersList.value);

// Resolve lead/steward display names from community members list
const resolvedLeadName = computed(() => {
  const id = project.value?.project_lead_id;
  if (!id) return '';
  const member = communityMembersList.value.find(m => m.id === id);
  return member?.name || project.value?.project_lead_name || id.slice(0, 12) + '...';
});

const resolvedStewardName = computed(() => {
  const id = project.value?.project_steward_id;
  if (!id) return '';
  const member = communityMembersList.value.find(m => m.id === id);
  return member?.name || project.value?.project_steward_name || id.slice(0, 12) + '...';
});

async function loadCommunityMembers() {
  try {
    const { BACKEND_URL } = await import('src/lib/api/client');
    // SharedProfiles have displayName + status; CommunityProfiles have role
    const [sharedResp, communityResp] = await Promise.all([
      fetch(`${BACKEND_URL}/api/v1/profiles/SharedProfile`),
      fetch(`${BACKEND_URL}/api/v1/profiles/CommunityProfile`),
    ]);
    const shared = sharedResp.ok ? await sharedResp.json() : { profiles: [] };
    const community = communityResp.ok ? await communityResp.json() : { profiles: [] };

    // Build a role map from CommunityProfiles (keyed by userAID)
    const roleMap = new Map<string, string>();
    for (const p of (community.profiles ?? []) as { data: Record<string, string> }[]) {
      const aid = p.data?.userAID;
      if (aid) roleMap.set(aid, p.data?.role ?? 'Member');
    }

    // Map SharedProfiles to member list, excluding pending
    communityMembersList.value = ((shared.profiles ?? []) as { id: string; data: Record<string, string> }[])
      .filter(p => p.data?.displayName && p.data?.status !== 'pending')
      .map(p => {
        const aid = p.data?.aid || p.id.replace('SharedProfile-', '');
        return {
          id: aid,
          name: p.data.displayName,
          role: roleMap.get(aid) ?? 'Member',
        };
      });
  } catch {
    communityMembersList.value = [];
  }
}

// ── Lifecycle ────────────────────────────────────────────────────────────────

onMounted(async () => {
  void loadProject(route.params.id as string);
  void loadCommunityMembers();
});

onBeforeUnmount(() => {
  projectsStore.currentProject = null;
});

watch(
  () => route.params.id,
  (newId) => {
    if (newId) void loadProject(newId as string);
  },
);

// Reset editingMilestone when the milestone dialog closes without submitting
watch(showAddMilestoneDialog, (open) => {
  if (!open) editingMilestone.value = null;
});

// Refresh implementation plan when contribution events arrive via SSE
// Includes both local API events (colon-separated) and P2P sync events (underscore-separated)
watch(lastEvent, (event) => {
  if (!event || !project.value) return;
  const refreshEvents = [
    // Local API SSE events
    'contribution:registered',
    'contribution:shared',
    'contribution:confirmed',
    'contribution:assigned',
    'contribution:needs_review',
    'contribution:approved',
    'contribution:declined',
    'contribution:accepted',
    'contribution:reviewed',
    'contribution:signed_off',
    'contribution:updated',
    'implementation_plan:signed_off',
    // P2P sync events from tree listener
    'contribution_updated',
    'plan_updated',
    'project_updated',
    'milestone_updated',
  ];
  if (refreshEvents.includes(event.type)) {
    projectsStore.fetchImplementationPlan(project.value.id).then(() => {
      // Refresh viewingContribution from the updated plan data
      if (viewingContribution.value) {
        const fresh = planContributions.value.find(c => c.id === viewingContribution.value?.id);
        if (fresh) {
          viewingContribution.value = { ...fresh };
        }
      }
    });
    // If the dialog is open, re-fetch the viewing contribution to pick up child updates
    if (viewingContribution.value && (event.type === 'contribution_updated' || event.type === 'contribution:updated')) {
      import('src/lib/api/contributions').then(({ getContribution }) => {
        getContribution(viewingContribution.value!.id).then((fresh) => {
          viewingContribution.value = { ...viewingContribution.value!, ...fresh };
        }).catch(() => {});
      });
    }
    // Also refresh the project itself for status changes
    if (event.type === 'project_updated' || event.type === 'implementation_plan:signed_off') {
      projectsStore.fetchProject(project.value.id);
    }
  }
});

// ── Data loading ─────────────────────────────────────────────────────────────

async function loadProject(id: string) {
  // Fetch project, proposals, and implementation plan in parallel.
  // fetchProject uses cached data from the projects list for instant display.
  await Promise.all([
    projectsStore.fetchProject(id),
    proposalsStore.fetchProposals(),
    projectsStore.fetchImplementationPlan(id),
  ]);
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function formatStatus(status: string): string {
  return status.replace(/_/g, ' ').replace(/\b\w/g, (l) => l.toUpperCase());
}

// ── Handlers ─────────────────────────────────────────────────────────────────

async function handleEditSubmit(data: { title: string; description: string }) {
  if (!project.value) return;
  isSubmitting.value = true;
  submitError.value = null;
  try {
    await projectsStore.update(project.value.id, data);
    showEditDialog.value = false;
    $q.notify({ type: 'positive', message: 'Project updated!' });
  } catch (e) {
    submitError.value = e instanceof Error ? e.message : 'Update failed';
  } finally {
    isSubmitting.value = false;
  }
}

async function handleLinkProposal(proposalId: string) {
  if (!project.value) return;
  linking.value = true;
  try {
    await projectsStore.linkProposal(project.value.id, proposalId);
    $q.notify({ type: 'positive', message: 'Proposal linked!' });
  } catch {
    $q.notify({ type: 'negative', message: 'Failed to link proposal' });
  } finally {
    linking.value = false;
  }
}

async function handleCreatePlan() {
  if (!project.value || !newPlan.value.total_budget.trim()) return;
  creatingPlan.value = true;
  try {
    await projectsStore.createPlan(project.value.id, {
      project_id: project.value.id,
      total_budget: newPlan.value.total_budget.trim(),
      project_lead: newPlan.value.project_lead.trim() || 'TBD',
      project_steward_id: newPlan.value.project_steward_id.trim() || 'TBD',
    });
    showCreatePlanDialog.value = false;
    newPlan.value = { total_budget: '', project_lead: '', project_steward_id: '' };
    $q.notify({ type: 'positive', message: 'Implementation plan created!' });
  } catch {
    $q.notify({ type: 'negative', message: 'Failed to create plan' });
  } finally {
    creatingPlan.value = false;
  }
}

async function handleAddMilestone(req: CreateMilestoneRequest | UpdateMilestoneRequest) {
  if (!project.value) return;
  addingMilestone.value = true;
  try {
    if (editingMilestone.value) {
      // Edit existing milestone
      await projectsStore.updateMilestone(project.value.id, editingMilestone.value.milestone_id, req as UpdateMilestoneRequest);
      $q.notify({ type: 'positive', message: 'Milestone updated!' });
    } else {
      // Auto-create implementation plan if it doesn't exist yet
      let planId = implementationPlan.value?.id;
      if (!planId) {
        const plan = await projectsStore.createPlan(project.value.id, {
          project_id: project.value.id,
          total_budget: 'TBD',
          project_lead: 'TBD',
          project_steward_id: 'TBD',
        });
        planId = plan.id;
      }
      await projectsStore.addMilestone(planId, project.value.id, {
        title: (req as CreateMilestoneRequest).title,
        duration: req.duration,
        contribution_ids: [],
      });
      $q.notify({ type: 'positive', message: 'Milestone added successfully!' });
    }
    showAddMilestoneDialog.value = false;
    editingMilestone.value = null;
  } catch (e) {
    $q.notify({ type: 'negative', message: e instanceof Error ? e.message : 'Failed to save milestone' });
  } finally {
    addingMilestone.value = false;
  }
}

async function handleSignOffPlan() {
  if (!project.value || !implementationPlan.value) return;
  signingOffPlan.value = true;
  try {
    await projectsStore.signOffPlan(implementationPlan.value.id, project.value.id);
    // Re-fetch project to pick up updated status (e.g. created → active)
    await projectsStore.fetchProject(project.value.id);
    $q.notify({ type: 'positive', message: 'Implementation plan signed off!' });
  } catch (e) {
    $q.notify({ type: 'negative', message: e instanceof Error ? e.message : 'Failed to sign off' });
  } finally {
    signingOffPlan.value = false;
  }
}

async function onSubmitCompletion() {
  if (!project.value) return;
  try {
    await projectsStore.submitCompletion(project.value.id);
    $q.notify({ type: 'positive', message: 'Project submitted for steward review!' });
  } catch (e) {
    $q.notify({ type: 'negative', message: e instanceof Error ? e.message : 'Failed to submit completion' });
  }
}

async function onApproveCompletion() {
  if (!project.value) return;
  try {
    await projectsStore.approveCompletion(project.value.id);
    $q.notify({ type: 'positive', message: 'Project marked as completed!' });
  } catch (e) {
    $q.notify({ type: 'negative', message: e instanceof Error ? e.message : 'Failed to approve completion' });
  }
}

async function onRejectCompletion(reason: string) {
  if (!project.value) return;
  try {
    await projectsStore.rejectCompletion(project.value.id, reason);
    $q.notify({ type: 'positive', message: 'Project sent back for revision.' });
  } catch (e) {
    $q.notify({ type: 'negative', message: e instanceof Error ? e.message : 'Failed to send back' });
  }
}

function openAssignRole(role: 'lead' | 'steward') {
  assignRoleTarget.value = role;
  showAssignRoleDialog.value = true;
}

async function handleAssignRole(userId: string) {
  if (!project.value) return;
  assigningRole.value = true;
  try {
    await projectsStore.assignRole(project.value.id, assignRoleTarget.value, userId);
    showAssignRoleDialog.value = false;
    $q.notify({ type: 'positive', message: `${assignRoleTarget.value === 'lead' ? 'Project Lead' : 'Project Steward'} assigned!` });
  } catch (e) {
    $q.notify({ type: 'negative', message: e instanceof Error ? e.message : 'Failed to assign role' });
  } finally {
    assigningRole.value = false;
  }
}

function handleCreateContribution(milestoneId: string) {
  createContributionMilestoneId.value = milestoneId;
  showCreateContributionDialog.value = true;
}

async function handleCreateContributionSubmit(req: CreateContributionRequest) {
  creatingContribution.value = true;
  try {
    await contributionsStore.create(req);
    showCreateContributionDialog.value = false;
    $q.notify({ type: 'positive', message: 'Contribution created!' });
    if (project.value) await projectsStore.fetchImplementationPlan(project.value.id);
  } catch (e) {
    $q.notify({ type: 'negative', message: e instanceof Error ? e.message : 'Failed to create contribution' });
  } finally {
    creatingContribution.value = false;
  }
}

function handleCreateChildContribution(parentId: string) {
  createSubParentId.value = parentId;
  showCreateSubDialog.value = true;
}

async function handleCreateSubContributionSubmit(req: CreateContributionRequest) {
  if (!createSubParentId.value) return;
  creatingContribution.value = true;
  try {
    const { parent } = await contributionsStore.createChild(createSubParentId.value, req);
    showCreateSubDialog.value = false;
    $q.notify({ type: 'positive', message: 'Sub-contribution created!' });
    // Update the viewing contribution with the refreshed parent (includes new child_contributions)
    if (viewingContribution.value?.id === createSubParentId.value && parent) {
      viewingContribution.value = { ...viewingContribution.value, ...parent } as Contribution;
    }
    if (project.value) await projectsStore.fetchImplementationPlan(project.value.id);
  } catch (e) {
    $q.notify({ type: 'negative', message: e instanceof Error ? e.message : 'Failed to create sub-contribution' });
  } finally {
    creatingContribution.value = false;
  }
}

function handleViewContribution(contribution: Contribution) {
  viewingContribution.value = contribution;
  showContributionDetail.value = true;
}

async function handleContributionUpdate(updated: Contribution & { _action?: string }) {
  // Dispatch the action if specified (e.g. confirm from ContributionCardCompact)
  if (updated._action === 'confirm') {
    try {
      await contributionsStore.confirm(updated.id);
      $q.notify({ type: 'positive', message: 'Contribution confirmed!' });
    } catch (e) {
      $q.notify({ type: 'negative', message: e instanceof Error ? e.message : 'Failed to confirm' });
    }
  }

  // Update the viewing contribution if it's the same one (keeps dialog in sync)
  if (viewingContribution.value?.id === updated.id) {
    viewingContribution.value = { ...viewingContribution.value, ...updated };
  }

  // Refresh the implementation plan to get latest contributions state
  if (project.value) {
    await projectsStore.fetchImplementationPlan(project.value.id);
  }
}

function handleAssignContribution(contribution: Contribution) {
  assignTarget.value = contribution;
  assignMode.value = null;
  assignSelectedGroup.value = null;
  assignSelectedMember.value = null;
  assignSelectedMemberName.value = null;
  assignMemberSearch.value = '';
  showAssignDialog.value = true;
}

function selectMember(id: string, name: string) {
  assignSelectedMember.value = id;
  assignSelectedMemberName.value = name;
  assignMode.value = 'member';
  assignSelectedGroup.value = null;
}

async function submitAssign() {
  if (!assignTarget.value) return;
  assigningContribution.value = true;
  try {
    if (assignMode.value === 'group' && assignSelectedGroup.value) {
      // Share with group → status becomes "shared"
      await contributionsStore.share(assignTarget.value.id, {
        shared_with_roles: [assignSelectedGroup.value],
      });
      $q.notify({ type: 'positive', message: 'Contribution shared with group!' });
    } else if (assignSelectedMember.value) {
      // Offer to member → status becomes "assigned"
      await contributionsStore.offer(assignTarget.value.id, {
        offered_to: assignSelectedMember.value,
        offered_to_name: assignSelectedMemberName.value || assignSelectedMember.value,
      });
      $q.notify({ type: 'positive', message: 'Contribution assigned to member!' });
    }
    showAssignDialog.value = false;
    if (project.value) await projectsStore.fetchImplementationPlan(project.value.id);
  } catch (e) {
    $q.notify({ type: 'negative', message: e instanceof Error ? e.message : 'Failed to assign' });
  } finally {
    assigningContribution.value = false;
  }
}
</script>

<style scoped lang="scss">
.project-detail-page {
  padding: 24px;
  max-width: 960px;
  margin: 0 auto;
}

.loading-state,
.empty-state {
  text-align: center;
  padding: 60px 20px;
  color: var(--matou-muted-foreground);
}

.page-nav {
  display: flex;
  align-items: center;
  gap: 4px;
  margin-bottom: 20px;
}

.page-nav-label {
  font-size: 0.875rem;
  color: var(--matou-muted-foreground);
}

// ── Project header ──────────────────────────────────────────────────────────

.project-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
  margin-bottom: 24px;
  padding-bottom: 20px;
  border-bottom: 1px solid var(--matou-border);
}

.project-header-main {
  flex: 1;
  min-width: 0;
}

.header-badges {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-bottom: 8px;
}

.project-status-badge {
  display: inline-block;
  font-size: 0.75rem;
  font-weight: 500;
  padding: 3px 10px;
  border-radius: 12px;
  text-transform: capitalize;
  background: var(--matou-muted);
  color: var(--matou-muted-foreground);

  &.created { background: #e0e7ff; color: #4338ca; }
  &.active { background: rgba(74, 157, 156, 0.12); color: var(--matou-accent); }
  &.pending_completion { background: #ffedd5; color: #c2410c; }
  &.completed { background: #dbeafe; color: #2563eb; }
  &.archived { background: #f3f4f6; color: #6b7280; }
}

.project-title {
  font-size: 2rem;
  font-weight: 700;
  margin: 0 0 8px;
  color: var(--matou-foreground);
  line-height: 1.2;
}

.project-description {
  color: var(--matou-muted-foreground);
  font-size: 1rem;
  margin: 0 0 16px;
  line-height: 1.6;
}

.team-row {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.team-chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 5px 12px;
  border-radius: 12px;
  font-size: 0.82rem;
  font-weight: 500;

  &.lead {
    background: rgba(74, 157, 156, 0.12);
    color: var(--matou-chart-2, #4a9d9c);
  }

  &.steward {
    background: rgba(30, 95, 116, 0.1);
    color: var(--matou-accent, #4a9d9c);
  }
}

.assign-chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 5px 12px;
  border-radius: 12px;
  font-size: 0.82rem;
  font-weight: 500;
  background: transparent;
  border: 1px dashed var(--matou-border);
  color: var(--matou-muted-foreground);
  cursor: pointer;
  transition: all 0.12s ease;

  &:hover {
    border-color: var(--matou-primary);
    color: var(--matou-primary);
  }
}

.team-icon {
  width: 14px;
  height: 14px;
}

// ── Content sections ────────────────────────────────────────────────────────

.content-section {
  background: var(--matou-card);
  border: 1px solid var(--matou-border);
  border-radius: var(--matou-radius);
  padding: 16px 20px;
  margin-bottom: 16px;
}

.section-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 14px;
}

.section-title {
  font-size: 1rem;
  font-weight: 600;
  color: var(--matou-foreground);
  margin: 0 0 14px;
  display: flex;
  align-items: center;
  gap: 8px;
}

.section-icon {
  width: 18px;
  height: 18px;
  color: var(--matou-primary);
}

.section-actions {
  display: flex;
  gap: 6px;
}

.signed-off-badge {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 0.75rem;
  padding: 2px 10px;
  border-radius: 12px;
  background: rgba(74, 157, 156, 0.12);
  color: var(--matou-accent);
}

.signed-off-icon {
  width: 12px;
  height: 12px;
}

// ── Proposals ────────────────────────────────────────────────────────────────

.proposals-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.proposal-row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 14px;
  background: var(--matou-secondary);
  border: 1px solid var(--matou-border);
  border-radius: var(--matou-radius-sm);
  cursor: pointer;
  transition: border-color 0.12s ease;

  &:hover {
    border-color: var(--matou-accent);
  }
}

.proposal-title {
  flex: 1;
  font-size: 0.9rem;
  font-weight: 500;
  color: var(--matou-foreground);
}

.proposal-status-badge {
  font-size: 0.7rem;
  padding: 2px 8px;
  border-radius: 10px;
  font-weight: 500;
  flex-shrink: 0;
  background: var(--matou-muted);
  color: var(--matou-muted-foreground);
}

.row-arrow {
  width: 14px;
  height: 14px;
  color: var(--matou-muted-foreground);
}

// ── Plan ─────────────────────────────────────────────────────────────────────

.empty-plan,
.empty-milestones {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  color: var(--matou-muted-foreground);
  font-size: 0.875rem;
  padding: 2rem 1rem;
  text-align: center;
}

.empty-hint {
  font-size: 0.8rem;
  color: var(--matou-muted-foreground);
  opacity: 0.7;
}

.empty-icon {
  width: 32px;
  height: 32px;
  opacity: 0.4;
}

.progress-section {
  margin-bottom: 14px;
}

.progress-label {
  font-size: 0.8rem;
  color: var(--matou-muted-foreground);
  margin-bottom: 6px;
}

.progress-bar {
  height: 6px;
  border-radius: 3px;
}

.sign-off-banner {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px 16px;
  background: rgba(234, 179, 8, 0.08);
  border: 1px solid #eab308;
  border-radius: var(--matou-radius-sm);
  margin-bottom: 16px;
}

.plan-modified-banner {
  display: flex;
  align-items: flex-start;
  gap: 12px;
  padding: 12px 16px;
  background: rgba(239, 68, 68, 0.08);
  border: 1px solid #ef4444;
  border-radius: var(--matou-radius-sm);
  margin-bottom: 16px;

  .banner-icon { color: #b91c1c; }
}

.banner-icon {
  width: 20px;
  height: 20px;
  color: #ca8a04;
  flex-shrink: 0;
}

.banner-title {
  font-size: 0.9rem;
  font-weight: 600;
  color: var(--matou-foreground);
}

.banner-subtitle {
  font-size: 0.8rem;
  color: var(--matou-foreground);
  opacity: 0.8;
  margin-top: 4px;
  line-height: 1.4;
}

.milestones-list {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

// ── Assign dialog ────────────────────────────────────────────────────────────

.assign-dialog {
  min-width: 460px;
  max-width: 540px;
}

.assign-body {
  display: flex;
  flex-direction: column;
  gap: 16px;
  max-height: 60vh;
  overflow-y: auto;
}

.assign-section {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.assign-section-label {
  font-size: 0.8rem;
  font-weight: 600;
  color: var(--matou-muted-foreground);
  text-transform: uppercase;
  letter-spacing: 0.03em;
}

.assign-mode-row {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 8px;
}

.assign-mode-card {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
  padding: 16px 12px;
  border: 1px solid var(--matou-border);
  border-radius: var(--matou-radius-sm, 8px);
  background: var(--matou-card);
  cursor: pointer;
  font-size: 0.85rem;
  font-weight: 500;
  color: var(--matou-muted-foreground);
  transition: all 0.12s ease;

  &:hover {
    border-color: var(--matou-accent);
    background: var(--matou-secondary);
  }

  &.active {
    border-color: var(--matou-primary);
    background: rgba(30, 95, 116, 0.06);
    color: var(--matou-primary);
  }
}

.assign-member-list {
  max-height: 240px;
  overflow-y: auto;
}

.assign-member-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 12px;
  border: 1px solid var(--matou-border);
  border-radius: var(--matou-radius-sm, 8px);
  cursor: pointer;
  transition: all 0.12s ease;

  &:hover {
    border-color: var(--matou-accent);
    background: var(--matou-secondary);
  }

  &.selected {
    border-color: var(--matou-primary);
    background: rgba(30, 95, 116, 0.06);
  }
}

.assign-member-name {
  font-size: 0.875rem;
  font-weight: 500;
  color: var(--matou-foreground);
}

.assign-member-note {
  font-size: 0.75rem;
  color: var(--matou-muted-foreground);
  margin-top: 2px;
}

.assign-empty {
  text-align: center;
  padding: 16px;
  color: var(--matou-muted-foreground);
  font-size: 0.85rem;
}

.assign-actions {
  display: flex;
  gap: 8px;
  padding-top: 8px;
}

.assign-action-btn {
  flex: 1;
}
</style>
