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
   * Admin or steward can confirm a contribution:
   * - created → confirmed (only before plan sign-off)
   * - changed → assigned (allowed even after plan sign-off, re-confirmation after lead edit)
   */
  function canConfirm(
    contribution: Contribution,
    isPlanSignedOff: boolean,
    role: ProjectRole | string,
  ): boolean {
    if (!_isRole(role, CONFIRM_ROLES)) return false;
    if (contribution.status === 'changed') return true;
    if (contribution.status === 'created' && !isPlanSignedOff) return true;
    return false;
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
    if (assignedId === currentUserId) return false;
    // Already registered interest
    if (contribution.interested_contributors?.some(ic => ic.user_id === currentUserId)) return false;
    return true;
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
   * Can submit evidence when:
   * - status is `assigned`
   * - user is the assigned contributor, or is lead/steward/admin
   * - all child contributions are signed off / rewarded / archived
   */
  function canSubmitEvidence(
    contribution: Contribution,
    currentUserId: string,
    allChildrenSignedOff: boolean,
    role?: ProjectRole | string,
  ): boolean {
    if (contribution.status !== 'assigned') return false;
    const assignedId =
      contribution.assigned_contributor ?? contribution.assigned_contributor_id;
    const isAssigned = assignedId === currentUserId;
    const isPrivileged = role ? _isRole(role, SHARE_OFFER_ROLES) : false;
    if (!isAssigned && !isPrivileged) return false;
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
   * Project lead, steward, admin, or assigned member can add sub-contributions
   * at any stage except completed (signed_off, rewarded, archived).
   * No nested subs (flat hierarchy only).
   */
  function canAddSubContribution(
    contribution: Contribution,
    currentUserId: string,
    role: ProjectRole | string,
  ): boolean {
    if (contribution.parent_contribution) return false; // no nested subs
    const completedStatuses = ['signed_off', 'rewarded', 'archived'];
    if (completedStatuses.includes(contribution.status)) return false;
    const assignedId =
      contribution.assigned_contributor ?? contribution.assigned_contributor_id;
    if (assignedId === currentUserId) return true;
    return _isRole(role, SHARE_OFFER_ROLES);
  }

  /**
   * Lead or admin can approve a sub-contribution that is in `created` or `changed`
   * status. An assignee is not required — the sub may be approved while unassigned and
   * later inherit the parent's assignee or be assigned directly.
   */
  function canApproveSub(contribution: Contribution, role: ProjectRole | string): boolean {
    if (!contribution.parent_contribution) return false;
    if (contribution.status !== 'created' && contribution.status !== 'changed') return false;
    return _isRole(role, LEAD_ROLES);
  }

  /**
   * Lead, steward, or admin can edit an assigned contribution.
   * - Project lead edits require re-confirmation (status → changed)
   * - Steward/admin edits stay assigned
   */
  function canChange(
    contribution: Contribution,
    currentUserId: string,
    role: ProjectRole | string,
  ): boolean {
    if (contribution.status !== 'assigned') return false;
    return _isRole(role, SHARE_OFFER_ROLES);
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
    canChange,
    canAddSubContribution,
    canApproveSub,
    canAssignProjectRole,
    canSignOffPlan,
  };
}
