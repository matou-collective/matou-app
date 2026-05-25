import { defineStore } from 'pinia';
import { ref, computed } from 'vue';
import {
  createContribution as apiCreate,
  listContributions as apiList,
  getContribution as apiGet,
  transitionContribution as apiTransition,
  updateContribution as apiUpdate,
  confirmContribution as apiConfirm,
  shareContribution as apiShare,
  offerContribution as apiOffer,
  acceptOffer as apiAcceptOffer,
  registerInterest as apiRegisterInterest,
  submitEvidence as apiSubmitEvidence,
  submitReview as apiSubmitReview,
  signOffContribution as apiSignOff,
  rewardContribution as apiReward,
  createChildContribution as apiCreateChild,
  approveSub as apiApproveSub,
  archiveContribution as apiArchiveContrib,
  unassignContribution as apiUnassign,
  addContributionComment as apiAddComment,
  listContributionComments as apiListComments,
  type Contribution,
  type ContributionComment,
  type CreateContributionRequest,
  type UpdateContributionRequest,
} from 'src/lib/api/contributions';
import type {
  ShareContributionRequest,
  OfferContributionRequest,
  RegisterInterestRequest,
  SubmitEvidenceRequest,
  SubmitReviewRequest,
} from 'src/types/projects';
import { createLogger } from 'src/lib/logging';

const log = createLogger('ContributionsStore');

export const useContributionsStore = defineStore('contributions', () => {
  const contributions = ref<Contribution[]>([]);
  const currentContribution = ref<Contribution | null>(null);
  const isLoading = ref(false);
  const error = ref<string | null>(null);

  const confirmedContributions = computed(() =>
    contributions.value.filter(c => c.status === 'confirmed'),
  );

  const assignedContributions = computed(() =>
    contributions.value.filter(c => c.status === 'assigned'),
  );

  async function fetchContributions(params?: { project_id?: string; status?: string }) {
    isLoading.value = true;
    error.value = null;
    try {
      const result = await apiList(params);
      contributions.value = result.contributions || [];
    } catch (e) {
      error.value = e instanceof Error ? e.message : 'Failed to fetch contributions';
      log.error('fetchContributions: %s', error.value);
    } finally {
      isLoading.value = false;
    }
  }

  async function fetchContribution(id: string) {
    isLoading.value = true;
    error.value = null;
    try {
      currentContribution.value = await apiGet(id);
    } catch (e) {
      error.value = e instanceof Error ? e.message : 'Failed to fetch contribution';
      log.error('fetchContribution: %s', error.value);
    } finally {
      isLoading.value = false;
    }
  }

  // Lightweight per-entity refresh — upserts the list + currentContribution
  // in place without touching loading/error state. Used by global SSE
  // watchers that need to reflect a remote status change (offered, accepted,
  // etc.) on cards and the side menu badge.
  async function refreshContribution(id: string) {
    try {
      const fresh = await apiGet(id);
      const idx = contributions.value.findIndex((c) => c.id === id);
      if (idx >= 0) {
        contributions.value[idx] = fresh;
      } else {
        contributions.value = [...contributions.value, fresh];
      }
      if (currentContribution.value?.id === id) currentContribution.value = fresh;
      return fresh;
    } catch (e) {
      log.error('refreshContribution failed: %s', e);
      return null;
    }
  }

  async function create(req: CreateContributionRequest) {
    error.value = null;
    try {
      const contribution = await apiCreate(req);
      contributions.value.push(contribution);
      log.info('Contribution created: %s', contribution.id);
      return contribution;
    } catch (e) {
      error.value = e instanceof Error ? e.message : 'Failed to create contribution';
      log.error('create failed: %s', error.value);
      throw e;
    }
  }

  async function transition(id: string, status: string) {
    error.value = null;
    try {
      const updated = await apiTransition(id, status);
      const idx = contributions.value.findIndex(c => c.id === id);
      if (idx >= 0) contributions.value[idx] = updated;
      if (currentContribution.value?.id === id) currentContribution.value = updated;
      log.info('Contribution %s → %s', id, status);
      return updated;
    } catch (e) {
      error.value = e instanceof Error ? e.message : 'Transition failed';
      log.error('transition failed: %s', error.value);
      throw e;
    }
  }

  async function update(id: string, req: UpdateContributionRequest) {
    error.value = null;
    try {
      const updated = await apiUpdate(id, req);
      const idx = contributions.value.findIndex(c => c.id === id);
      if (idx >= 0) contributions.value[idx] = updated;
      if (currentContribution.value?.id === id) currentContribution.value = updated;
      return updated;
    } catch (e) {
      error.value = e instanceof Error ? e.message : 'Update failed';
      log.error('update failed: %s', error.value);
      throw e;
    }
  }

  function _patch(updated: Contribution) {
    const idx = contributions.value.findIndex(c => c.id === updated.id);
    if (idx >= 0) contributions.value[idx] = updated;
    if (currentContribution.value?.id === updated.id) currentContribution.value = updated;
  }

  async function confirm(id: string) {
    error.value = null;
    try {
      const updated = await apiConfirm(id);
      _patch(updated);
      return updated;
    } catch (e) {
      error.value = e instanceof Error ? e.message : 'Confirm failed';
      throw e;
    }
  }

  async function share(id: string, req: ShareContributionRequest) {
    error.value = null;
    try {
      const updated = await apiShare(id, req);
      _patch(updated);
      return updated;
    } catch (e) {
      error.value = e instanceof Error ? e.message : 'Share failed';
      throw e;
    }
  }

  async function offer(id: string, req: OfferContributionRequest) {
    error.value = null;
    try {
      const updated = await apiOffer(id, req);
      _patch(updated);
      return updated;
    } catch (e) {
      error.value = e instanceof Error ? e.message : 'Offer failed';
      throw e;
    }
  }

  async function acceptOffer(id: string) {
    error.value = null;
    try {
      const updated = await apiAcceptOffer(id);
      _patch(updated);
      return updated;
    } catch (e) {
      error.value = e instanceof Error ? e.message : 'Accept offer failed';
      throw e;
    }
  }

  async function registerInterest(id: string, req: RegisterInterestRequest) {
    error.value = null;
    try {
      const updated = await apiRegisterInterest(id, req);
      _patch(updated);
      return updated;
    } catch (e) {
      error.value = e instanceof Error ? e.message : 'Register interest failed';
      throw e;
    }
  }

  async function submitEvidence(id: string, req: SubmitEvidenceRequest) {
    error.value = null;
    try {
      const updated = await apiSubmitEvidence(id, req);
      _patch(updated);
      return updated;
    } catch (e) {
      error.value = e instanceof Error ? e.message : 'Submit evidence failed';
      throw e;
    }
  }

  async function review(id: string, req: SubmitReviewRequest) {
    error.value = null;
    try {
      const updated = await apiSubmitReview(id, req);
      _patch(updated);
      return updated;
    } catch (e) {
      error.value = e instanceof Error ? e.message : 'Review failed';
      throw e;
    }
  }

  async function signOff(id: string) {
    error.value = null;
    try {
      const updated = await apiSignOff(id);
      _patch(updated);
      return updated;
    } catch (e) {
      error.value = e instanceof Error ? e.message : 'Sign off failed';
      throw e;
    }
  }

  async function reward(id: string) {
    error.value = null;
    try {
      const updated = await apiReward(id);
      _patch(updated);
      return updated;
    } catch (e) {
      error.value = e instanceof Error ? e.message : 'Mark as rewarded failed';
      throw e;
    }
  }

  async function createChild(parentId: string, req: CreateContributionRequest) {
    error.value = null;
    try {
      const result = await apiCreateChild(parentId, req);
      contributions.value.push(result.child);
      _patch(result.parent);
      return result;
    } catch (e) {
      error.value = e instanceof Error ? e.message : 'Create sub-contribution failed';
      throw e;
    }
  }

  async function approveSub(id: string) {
    error.value = null;
    try {
      const updated = await apiApproveSub(id);
      _patch(updated);
      return updated;
    } catch (e) {
      error.value = e instanceof Error ? e.message : 'Approve sub-contribution failed';
      throw e;
    }
  }

  async function archive(id: string) {
    error.value = null;
    try {
      await apiArchiveContrib(id);
      const idx = contributions.value.findIndex(c => c.id === id);
      if (idx >= 0) contributions.value[idx] = { ...contributions.value[idx], status: 'archived' };
      if (currentContribution.value?.id === id) {
        currentContribution.value = { ...currentContribution.value, status: 'archived' };
      }
    } catch (e) {
      error.value = e instanceof Error ? e.message : 'Archive failed';
      throw e;
    }
  }

  async function unassign(id: string) {
    error.value = null;
    try {
      const updated = await apiUnassign(id);
      _patch(updated);
      return updated;
    } catch (e) {
      error.value = e instanceof Error ? e.message : 'Unassign failed';
      throw e;
    }
  }

  const commentsByContribution = ref<Record<string, ContributionComment[]>>({});

  async function fetchComments(contributionId: string) {
    try {
      const result = await apiListComments(contributionId);
      commentsByContribution.value[contributionId] = result.comments || [];
    } catch (e) {
      log.error('fetchComments failed: %s', e);
    }
  }

  async function addComment(contributionId: string, userId: string, userName: string, text: string) {
    const comment = await apiAddComment(contributionId, userId, userName, text);
    const existing = commentsByContribution.value[contributionId] ?? [];
    commentsByContribution.value[contributionId] = [...existing, comment];
    bumpCommentCount(contributionId);
    return comment;
  }

  function bumpCommentCount(contributionId: string, by = 1) {
    const idx = contributions.value.findIndex((c) => c.id === contributionId);
    if (idx >= 0) {
      const current = contributions.value[idx]!.comment_count ?? 0;
      contributions.value[idx] = { ...contributions.value[idx]!, comment_count: current + by };
    }
    if (currentContribution.value?.id === contributionId) {
      const current = currentContribution.value.comment_count ?? 0;
      currentContribution.value = { ...currentContribution.value, comment_count: current + by };
    }
  }

  function setCommentCount(contributionId: string, count: number) {
    const idx = contributions.value.findIndex((c) => c.id === contributionId);
    if (idx >= 0) {
      contributions.value[idx] = { ...contributions.value[idx]!, comment_count: count };
    }
    if (currentContribution.value?.id === contributionId) {
      currentContribution.value = { ...currentContribution.value, comment_count: count };
    }
  }

  // Live read so cards that received a stale-copy of a Contribution (e.g.
  // hydrated milestone.contributions) can render the up-to-date count.
  function liveCommentCount(contributionId: string, fallback = 0): number {
    const c = contributions.value.find((x) => x.id === contributionId);
    if (c && typeof c.comment_count === 'number') return c.comment_count;
    if (currentContribution.value?.id === contributionId && typeof currentContribution.value.comment_count === 'number') {
      return currentContribution.value.comment_count;
    }
    return fallback;
  }

  return {
    contributions,
    currentContribution,
    isLoading,
    error,
    confirmedContributions,
    assignedContributions,
    fetchContributions,
    fetchContribution,
    refreshContribution,
    create,
    transition,
    update,
    confirm,
    share,
    offer,
    acceptOffer,
    registerInterest,
    submitEvidence,
    review,
    signOff,
    reward,
    createChild,
    approveSub,
    archive,
    unassign,
    commentsByContribution,
    fetchComments,
    addComment,
    bumpCommentCount,
    setCommentCount,
    liveCommentCount,
  };
});
