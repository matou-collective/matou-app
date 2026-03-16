/**
 * Composable that encodes the contribution status-transition permission matrix.
 * Pure functions — no reactive state — so they can be called in computed props.
 */
import type { Contribution, ProjectRole } from 'src/types/projects';

export function useContributionWorkflow() {
  const ADMIN_ROLES: ProjectRole[] = ['community_admin'];
  const STEWARD_ROLES: ProjectRole[] = ['community_admin', 'project_steward'];
  const LEAD_ROLES: ProjectRole[] = ['community_admin', 'project_lead'];
  const CONFIRM_ROLES: ProjectRole[] = ['community_admin', 'project_steward'];
  const SHARE_OFFER_ROLES: ProjectRole[] = ['community_admin', 'project_steward', 'project_lead'];
  const REVIEW_SIGN_OFF_PLAN_ROLES: ProjectRole[] = ['community_admin', 'project_lead'];

  function _isRole(role: ProjectRole | string, allowed: ProjectRole[]): boolean {
    return allowed.includes(role as ProjectRole);
  }

  /**
   * Admin or steward can confirm a contribution that is in `created` status,
   * but only while the plan is NOT yet signed off.
   */
  function canConfirm(
    contribution: Contribution,
    isPlanSignedOff: boolean,
    role: ProjectRole | string,
  ): boolean {
    if (isPlanSignedOff) return false;
    return contribution.status === 'created' && _isRole(role, CONFIRM_ROLES);
  }

  /**
   * Lead/steward/admin can share a confirmed or previously-shared contribution.
   */
  function canShare(contribution: Contribution, role: ProjectRole | string): boolean {
    return (
      (contribution.status === 'confirmed' || contribution.status === 'shared') &&
      _isRole(role, SHARE_OFFER_ROLES)
    );
  }

  /**
   * Lead/steward/admin can offer a confirmed or shared contribution.
   */
  function canOffer(contribution: Contribution, role: ProjectRole | string): boolean {
    return (
      (contribution.status === 'confirmed' ||
        contribution.status === 'shared') &&
      _isRole(role, SHARE_OFFER_ROLES)
    );
  }

  /**
   * Contributor/member can register interest when the contribution is shared,
   * and they are not already the assigned contributor.
   */
  function canRegisterInterest(
    contribution: Contribution,
    role: ProjectRole | string,
    currentUserId: string,
  ): boolean {
    const eligibleRoles: ProjectRole[] = ['contributor', 'member'];
    if (!_isRole(role, eligibleRoles)) return false;
    if (contribution.status !== 'shared') return false;
    const assignedId =
      contribution.assigned_contributor ?? contribution.assigned_contributor_id;
    return assignedId !== currentUserId;
  }

  /**
   * The user the contribution was offered to can accept it.
   */
  function canAccept(contribution: Contribution, currentUserId: string): boolean {
    return (
      contribution.status === 'offered' && contribution.offered_to === currentUserId
    );
  }

  /**
   * The assigned contributor can submit evidence when:
   * - status is `assigned` or `changed`
   * - all child contributions are signed off / rewarded / archived
   */
  function canSubmitEvidence(
    contribution: Contribution,
    currentUserId: string,
    allChildrenSignedOff: boolean,
  ): boolean {
    const assignedId =
      contribution.assigned_contributor ?? contribution.assigned_contributor_id;
    if (assignedId !== currentUserId) return false;
    if (
      contribution.status !== 'assigned' &&
      contribution.status !== 'changed'
    ) {
      return false;
    }
    return allChildrenSignedOff;
  }

  /**
   * Lead or admin can review a contribution that is in `needs_review` status.
   */
  function canReview(contribution: Contribution, role: ProjectRole | string): boolean {
    return (
      contribution.status === 'needs_review' &&
      _isRole(role, REVIEW_SIGN_OFF_PLAN_ROLES)
    );
  }

  /**
   * Steward or admin can sign off an approved contribution.
   */
  function canSignOff(contribution: Contribution, role: ProjectRole | string): boolean {
    return contribution.status === 'approved' && _isRole(role, STEWARD_ROLES);
  }

  /**
   * The assigned contributor (or lead/admin) can add a sub-contribution when:
   * - the parent is assigned
   * - the parent is not itself a sub-contribution (flat hierarchy only)
   */
  function canAddSubContribution(
    contribution: Contribution,
    currentUserId: string,
    role: ProjectRole | string,
  ): boolean {
    if (contribution.parent_contribution) return false; // no nested subs
    if (contribution.status !== 'assigned') return false;
    const assignedId =
      contribution.assigned_contributor ?? contribution.assigned_contributor_id;
    if (assignedId === currentUserId) return true;
    return _isRole(role, LEAD_ROLES);
  }

  /**
   * Lead or admin can approve a sub-contribution that is in `created` status.
   */
  function canApproveSub(contribution: Contribution, role: ProjectRole | string): boolean {
    return (
      !!contribution.parent_contribution &&
      contribution.status === 'created' &&
      _isRole(role, LEAD_ROLES)
    );
  }

  /**
   * Admin can assign roles to projects.
   */
  function canAssignProjectRole(role: ProjectRole | string): boolean {
    return _isRole(role, ADMIN_ROLES);
  }

  /**
   * Admin or steward can sign off a plan.
   */
  function canSignOffPlan(role: ProjectRole | string): boolean {
    return _isRole(role, STEWARD_ROLES);
  }

  return {
    canConfirm,
    canShare,
    canOffer,
    canRegisterInterest,
    canAccept,
    canSubmitEvidence,
    canReview,
    canSignOff,
    canAddSubContribution,
    canApproveSub,
    canAssignProjectRole,
    canSignOffPlan,
  };
}
