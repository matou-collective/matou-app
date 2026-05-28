import { computed } from 'vue';
import { useIdentityStore } from 'stores/identity';
import { useCommentCursorsStore } from 'stores/commentCursors';

type ProjectLike = {
  id: string;
  project_lead_id?: string;
  project_steward_id?: string;
  comment_count?: number;
};

type ContributionLike = {
  id: string;
  assigned_contributor_id?: string;
  assigned_contributor?: string;
  comment_count?: number;
  status?: string;
  offered_to?: string;
};

/**
 * Comment unread scope rules:
 *  - Project: current user is project lead or steward.
 *  - Contribution: current user is project lead/steward of parent project,
 *    OR is the assigned contributor.
 *  - Notice: current user is the notice author (created_by).
 */
export function useCommentScope() {
  const identityStore = useIdentityStore();
  const cursorsStore = useCommentCursorsStore();

  const currentUserId = computed(() => identityStore.currentAID?.prefix ?? null);

  function isMe(aid?: string | null): boolean {
    if (!aid || !currentUserId.value) return false;
    return aid === currentUserId.value;
  }

  function inScopeProject(p: ProjectLike): boolean {
    return isMe(p.project_lead_id) || isMe(p.project_steward_id);
  }

  function inScopeContribution(c: ContributionLike, parent?: ProjectLike | null): boolean {
    const assignee = c.assigned_contributor_id ?? c.assigned_contributor ?? null;
    if (isMe(assignee)) return true;
    if (parent && inScopeProject(parent)) return true;
    return false;
  }

  function inScopeNotice(notice: { created_by?: string; createdBy?: string }): boolean {
    return isMe(notice.created_by ?? notice.createdBy ?? null);
  }

  function projectUnread(p: ProjectLike): number {
    if (!inScopeProject(p)) return 0;
    return cursorsStore.unread('project', p.id, p.comment_count ?? 0);
  }

  function contributionUnread(c: ContributionLike, parent?: ProjectLike | null): number {
    if (!inScopeContribution(c, parent)) return 0;
    return cursorsStore.unread('contribution', c.id, c.comment_count ?? 0);
  }

  // Strict assignee-only check — used for the Contributions side menu badge
  // so leads/stewards aren't dragged into the count for contributions they
  // don't own.
  function contributionUnreadAsAssignee(c: ContributionLike): number {
    const assignee = c.assigned_contributor_id ?? c.assigned_contributor ?? null;
    if (!isMe(assignee)) return 0;
    return cursorsStore.unread('contribution', c.id, c.comment_count ?? 0);
  }

  // Returns 1 when a contribution has been offered to the current user and
  // hasn't been accepted yet, 0 otherwise. Once the user accepts, the
  // contribution transitions out of "offered" status and this drops to 0
  // automatically — no separate cursor to track.
  function contributionOfferedCount(c: ContributionLike): number {
    if (c.status !== 'offered') return 0;
    return isMe(c.offered_to ?? null) ? 1 : 0;
  }

  // Roll up project-level unread + every contribution unread inside the project,
  // but only when the current user is lead/steward of the project. The
  // contribution-side count is also visible on its own card, so this provides
  // a quick at-a-glance sum on the project surface.
  function projectRollupUnread(p: ProjectLike, contributions: ContributionLike[] = []): number {
    if (!inScopeProject(p)) return 0;
    const own = cursorsStore.unread('project', p.id, p.comment_count ?? 0);
    const child = contributions.reduce(
      (sum, c) => sum + cursorsStore.unread('contribution', c.id, c.comment_count ?? 0),
      0,
    );
    return own + child;
  }

  function noticeUnread(notice: { id: string; created_by?: string; createdBy?: string }): number {
    if (!inScopeNotice(notice)) return 0;
    return cursorsStore.unread('notice', notice.id, cursorsStore.getNoticeCount(notice.id));
  }

  return {
    currentUserId,
    isMe,
    inScopeProject,
    inScopeContribution,
    inScopeNotice,
    projectUnread,
    contributionUnread,
    contributionUnreadAsAssignee,
    contributionOfferedCount,
    projectRollupUnread,
    noticeUnread,
  };
}
