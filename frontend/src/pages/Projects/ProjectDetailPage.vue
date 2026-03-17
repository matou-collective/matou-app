<template>
  <div class="project-detail-page">
    <!-- Loading -->
    <div v-if="projectsStore.isLoading && !project" class="loading-state">
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

          <!-- Sign-off banner (all confirmed, not yet signed off) -->
          <div v-if="allContributionsConfirmed && !implementationPlan.signed_off" class="sign-off-banner">
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
      @submit="handleEditSubmit"
      @link-proposal="handleLinkProposal"
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

    <!-- Add milestone dialog -->
    <AddMilestoneDialog
      v-model="showAddMilestoneDialog"
      :project-id="project?.id ?? ''"
      :implementation-plan-id="implementationPlan?.id ?? ''"
      :is-submitting="addingMilestone"
      @submit="handleAddMilestone"
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
      :all-contributions="planContributions"
      :is-plan-signed-off="implementationPlan?.signed_off ?? false"
      @update="handleContributionUpdate"
      @create-child-contribution="handleCreateChildContribution"
    />
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, watch } from 'vue';
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
} from 'lucide-vue-next';
import { useProjectsStore } from 'stores/projects';
import { useProposalsStore } from 'stores/proposals';
import { useIdentityStore } from 'stores/identity';
import { useContributionsStore } from 'stores/contributions';
import type { Contribution } from 'src/types/projects';
import type { CreateContributionRequest } from 'src/lib/api/contributions';
import type { CreateMilestoneRequest } from 'src/types/projects';
import { useProjectPermissions } from 'src/composables/useProjectPermissions';
import { useContributionWorkflow } from 'src/composables/useContributionWorkflow';
import { useAdminAccess } from 'src/composables/useAdminAccess';
import ProjectForm from 'src/components/projects/ProjectForm.vue';
import MilestoneCard from 'src/components/projects/MilestoneCard.vue';
import AddMilestoneDialog from 'src/components/projects/AddMilestoneDialog.vue';
import AssignRoleDialog from 'src/components/projects/AssignRoleDialog.vue';
import CreateContributionDialog from 'src/components/projects/CreateContributionDialog.vue';
import ContributionDetailDialog from 'src/components/projects/ContributionDetailDialog.vue';

const route = useRoute();
const router = useRouter();
const $q = useQuasar();
const projectsStore = useProjectsStore();
const proposalsStore = useProposalsStore();
const identityStore = useIdentityStore();
const contributionsStore = useContributionsStore();
const workflow = useContributionWorkflow();
const { isAdmin: isKeriAdmin, checkAdminStatus } = useAdminAccess();

// ── Current user context ─────────────────────────────────────────────────────

const currentUserId = computed(() => identityStore.aidPrefix ?? '');
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
  await checkAdminStatus();
  void loadProject(route.params.id as string);
  void loadCommunityMembers();
});

watch(
  () => route.params.id,
  (newId) => {
    if (newId) void loadProject(newId as string);
  },
);

// ── Data loading ─────────────────────────────────────────────────────────────

async function loadProject(id: string) {
  await projectsStore.fetchProject(id);
  if (projectsStore.currentProject) {
    await Promise.all([
      proposalsStore.fetchProposals(),
      projectsStore.fetchImplementationPlan(id),
    ]);
  }
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

async function handleAddMilestone(req: CreateMilestoneRequest) {
  if (!project.value) return;
  addingMilestone.value = true;
  try {
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
      title: req.title,
      duration: req.duration,
      contribution_ids: [],
    });
    showAddMilestoneDialog.value = false;
    $q.notify({ type: 'positive', message: 'Milestone added successfully!' });
  } catch (e) {
    $q.notify({ type: 'negative', message: e instanceof Error ? e.message : 'Failed to add milestone' });
  } finally {
    addingMilestone.value = false;
  }
}

async function handleSignOffPlan() {
  if (!project.value || !implementationPlan.value) return;
  signingOffPlan.value = true;
  try {
    await projectsStore.signOffPlan(implementationPlan.value.id, project.value.id);
    $q.notify({ type: 'positive', message: 'Implementation plan signed off!' });
  } catch (e) {
    $q.notify({ type: 'negative', message: e instanceof Error ? e.message : 'Failed to sign off' });
  } finally {
    signingOffPlan.value = false;
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
    await contributionsStore.createChild(createSubParentId.value, req);
    showCreateSubDialog.value = false;
    $q.notify({ type: 'positive', message: 'Sub-contribution created!' });
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

  // Refresh the implementation plan to get latest contributions state
  if (project.value) {
    await projectsStore.fetchImplementationPlan(project.value.id);
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
  background: rgba(74, 157, 156, 0.06);
  border: 1px solid var(--matou-accent);
  border-radius: var(--matou-radius-sm);
  margin-bottom: 16px;
}

.banner-icon {
  width: 20px;
  height: 20px;
  color: var(--matou-accent);
  flex-shrink: 0;
}

.banner-title {
  font-size: 0.9rem;
  font-weight: 600;
  color: var(--matou-foreground);
}

.milestones-list {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
</style>
