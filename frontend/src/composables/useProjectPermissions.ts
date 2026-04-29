/**
 * Composable for project-level permission checks.
 * Accepts reactive refs to the current project and current user.
 */
import { computed, type Ref } from 'vue';
import type { Project, CurrentUser } from 'src/types/projects';

export function useProjectPermissions(
  project: Ref<Project | null>,
  currentUser: Ref<CurrentUser | null>,
) {
  const isAdmin = computed(
    () => currentUser.value?.role === 'community_admin' || currentUser.value?.role === 'admin',
  );

  const isSteward = computed(() => {
    if (isAdmin.value) return true;
    return (
      currentUser.value?.role === 'project_steward' ||
      project.value?.project_steward_id === currentUser.value?.id
    );
  });

  const isLead = computed(() => {
    if (isAdmin.value) return true;
    return (
      currentUser.value?.role === 'project_lead' ||
      project.value?.project_lead_id === currentUser.value?.id
    );
  });

  const canCreateProject = computed(() => isAdmin.value);

  const canEditProject = computed(() => isAdmin.value || isLead.value);

  const canDeleteProject = computed(() => isAdmin.value);

  const canAssignRoles = computed(() => isAdmin.value);

  const canAddMilestones = computed(
    () => (isAdmin.value || isLead.value) && project.value?.status !== 'archived',
  );

  const canSignOffPlan = computed(() => isAdmin.value || isSteward.value);

  const canCreateContribution = computed(() => isAdmin.value || isLead.value);

  const canConfirmContribution = computed(() => isAdmin.value || isSteward.value);

  const canArchiveProject = computed(() => isAdmin.value || isLead.value || isSteward.value);
  const canArchiveMilestone = computed(() => isAdmin.value || isLead.value || isSteward.value);
  const canArchiveContribution = computed(() => isAdmin.value || isLead.value || isSteward.value);
  const canUnassignContributor = computed(() => isAdmin.value || isLead.value || isSteward.value);
  const canEditMilestone = computed(() => isAdmin.value || isLead.value || isSteward.value);
  const canSubmitProjectCompletion = computed(() => isAdmin.value || isLead.value);
  const canApproveProjectCompletion = computed(() => isAdmin.value || isSteward.value);
  const canRejectProjectCompletion = computed(() => isAdmin.value || isSteward.value);

  const canReviewContribution = computed(() => isAdmin.value || isLead.value);

  const canSignOffContribution = computed(() => isAdmin.value || isSteward.value);

  const canShareContribution = computed(
    () => isAdmin.value || isSteward.value || isLead.value,
  );

  const canOfferContribution = computed(
    () => isAdmin.value || isSteward.value || isLead.value,
  );

  return {
    isAdmin,
    isSteward,
    isLead,
    canCreateProject,
    canEditProject,
    canDeleteProject,
    canAssignRoles,
    canAddMilestones,
    canSignOffPlan,
    canCreateContribution,
    canConfirmContribution,
    canArchiveProject,
    canArchiveMilestone,
    canArchiveContribution,
    canUnassignContributor,
    canEditMilestone,
    canSubmitProjectCompletion,
    canApproveProjectCompletion,
    canRejectProjectCompletion,
    canReviewContribution,
    canSignOffContribution,
    canShareContribution,
    canOfferContribution,
  };
}
