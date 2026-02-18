import { defineStore } from 'pinia';
import { ref, computed } from 'vue';
import {
  getNotices,
  createNotice,
  publishNotice,
  archiveNotice,
  submitRsvp,
  getRsvps,
  submitAck,
  getAcks,
  toggleNoticeSave,
  getSavedNotices,
  getComments,
  createComment,
  getReactions,
  toggleReaction,
  toggleNoticePin,
  type Notice,
  type NoticeRSVP,
  type NoticeAck,
  type NoticeSave,
  type NoticeComment,
  type NoticeReaction,
  type ReactionSummary,
  type CreateNoticeRequest,
} from 'src/lib/api/client';

export const useActivityStore = defineStore('activity', () => {
  // State
  const notices = ref<Notice[]>([]);
  const loading = ref(false);
  const error = ref<string | null>(null);
  const rsvpsByNotice = ref<Record<string, { rsvps: NoticeRSVP[]; counts: Record<string, number> }>>({});
  const acksByNotice = ref<Record<string, NoticeAck[]>>({});
  const savedNotices = ref<NoticeSave[]>([]);
  const commentsByNotice = ref<Record<string, NoticeComment[]>>({});
  const reactionsByNotice = ref<Record<string, NoticeReaction[]>>({});
  const activeFilter = ref<'all' | 'event' | 'announcement' | 'update'>('all');

  // Computed: Filtered feed (pinned first, then by date desc)
  const filteredFeed = computed(() => {
    let filtered = notices.value.filter(n => n.state === 'published');
    if (activeFilter.value !== 'all') {
      filtered = filtered.filter(n => n.type === activeFilter.value);
    }
    return filtered.sort((a, b) => {
      // Pinned first
      if (a.pinned && !b.pinned) return -1;
      if (!a.pinned && b.pinned) return 1;
      // Then by date desc
      return (b.publishedAt ?? b.createdAt).localeCompare(a.publishedAt ?? a.createdAt);
    });
  });

  // Computed: Board views (kept for backwards compatibility)
  const upcomingEvents = computed(() => {
    const now = new Date().toISOString();
    return notices.value
      .filter(n => n.type === 'event' && n.state === 'published' && (!n.eventStart || n.eventStart >= now))
      .sort((a, b) => (a.eventStart ?? '').localeCompare(b.eventStart ?? ''));
  });

  const currentUpdates = computed(() => {
    const now = new Date().toISOString();
    return notices.value
      .filter(n => n.type === 'update' && n.state === 'published' && (!n.activeUntil || n.activeUntil >= now))
      .sort((a, b) => (b.publishAt ?? b.createdAt).localeCompare(a.publishAt ?? a.createdAt));
  });

  const pastNotices = computed(() => {
    const now = new Date().toISOString();
    return notices.value
      .filter(n => n.state === 'archived' || (n.activeUntil && n.activeUntil < now))
      .sort((a, b) => (b.publishAt ?? b.createdAt).localeCompare(a.publishAt ?? a.createdAt));
  });

  const draftNotices = computed(() => {
    return notices.value.filter(n => n.state === 'draft');
  });

  const savedNoticeIds = computed(() => {
    return new Set(savedNotices.value.filter(s => s.pinned).map(s => s.noticeId));
  });

  // Actions
  async function loadNotices(): Promise<void> {
    loading.value = true;
    error.value = null;
    try {
      notices.value = await getNotices();
    } catch (err) {
      error.value = err instanceof Error ? err.message : String(err);
    } finally {
      loading.value = false;
    }
  }

  async function handleCreateNotice(req: CreateNoticeRequest): Promise<{ success: boolean; noticeId?: string; error?: string }> {
    const result = await createNotice(req);
    if (result.success) {
      await loadNotices();
    }
    return result;
  }

  async function handlePublish(noticeId: string): Promise<{ success: boolean; error?: string }> {
    const result = await publishNotice(noticeId);
    if (result.success) {
      await loadNotices();
    }
    return result;
  }

  async function handleArchive(noticeId: string): Promise<{ success: boolean; error?: string }> {
    const result = await archiveNotice(noticeId);
    if (result.success) {
      await loadNotices();
    }
    return result;
  }

  async function handleRsvp(noticeId: string, status: 'going' | 'maybe' | 'not_going'): Promise<{ success: boolean; error?: string }> {
    const result = await submitRsvp(noticeId, status);
    if (result.success) {
      await loadRsvps(noticeId);
    }
    return result;
  }

  async function loadRsvps(noticeId: string): Promise<void> {
    const data = await getRsvps(noticeId);
    rsvpsByNotice.value[noticeId] = data;
  }

  async function handleAck(noticeId: string): Promise<{ success: boolean; error?: string }> {
    const result = await submitAck(noticeId);
    if (result.success) {
      await loadAcks(noticeId);
    }
    return result;
  }

  async function loadAcks(noticeId: string): Promise<void> {
    const data = await getAcks(noticeId);
    acksByNotice.value[noticeId] = data.acks;
  }

  async function handleToggleSave(noticeId: string): Promise<{ success: boolean; error?: string }> {
    const result = await toggleNoticeSave(noticeId);
    if (result.success) {
      await loadSavedNotices();
    }
    return result;
  }

  async function loadSavedNotices(): Promise<void> {
    savedNotices.value = await getSavedNotices();
  }

  function getRsvpCounts(noticeId: string): Record<string, number> {
    return rsvpsByNotice.value[noticeId]?.counts ?? { going: 0, maybe: 0, not_going: 0 };
  }

  function hasAcked(noticeId: string, userId: string): boolean {
    const acks = acksByNotice.value[noticeId] ?? [];
    return acks.some(a => a.userId === userId);
  }

  function isSaved(noticeId: string): boolean {
    return savedNoticeIds.value.has(noticeId);
  }

  async function refreshAll(): Promise<void> {
    await Promise.all([
      loadNotices(),
      loadSavedNotices(),
    ]);
  }

  // Comments actions
  async function loadComments(noticeId: string): Promise<void> {
    const data = await getComments(noticeId);
    commentsByNotice.value[noticeId] = data.comments;
  }

  async function handleAddComment(noticeId: string, text: string): Promise<{ success: boolean; error?: string }> {
    const result = await createComment(noticeId, text);
    if (result.success) {
      await loadComments(noticeId);
    }
    return result;
  }

  function getCommentCount(noticeId: string): number {
    return commentsByNotice.value[noticeId]?.length ?? 0;
  }

  // Reactions actions
  async function loadReactions(noticeId: string): Promise<void> {
    const data = await getReactions(noticeId);
    reactionsByNotice.value[noticeId] = data.reactions;
  }

  async function handleToggleReaction(noticeId: string, emoji: string): Promise<{ success: boolean; error?: string }> {
    const result = await toggleReaction(noticeId, emoji);
    if (result.success) {
      await loadReactions(noticeId);
    }
    return result;
  }

  function getReactionSummaries(noticeId: string): ReactionSummary[] {
    const reactions = reactionsByNotice.value[noticeId] ?? [];
    const summaryMap = new Map<string, ReactionSummary>();
    for (const r of reactions) {
      if (!r.active) continue;
      const existing = summaryMap.get(r.emoji);
      if (existing) {
        existing.count++;
        // userReacted stays true once set
      } else {
        summaryMap.set(r.emoji, { emoji: r.emoji, count: 1, userReacted: false });
      }
    }
    return Array.from(summaryMap.values());
  }

  // Pin action
  async function handleTogglePin(noticeId: string): Promise<{ success: boolean; error?: string }> {
    const result = await toggleNoticePin(noticeId);
    if (result.success) {
      await loadNotices();
    }
    return result;
  }

  // Filter action
  function setFilter(filter: 'all' | 'event' | 'announcement' | 'update') {
    activeFilter.value = filter;
  }

  let pollInterval: ReturnType<typeof setInterval> | null = null;

  function startPolling(intervalMs = 15_000) {
    stopPolling();
    pollInterval = setInterval(() => { loadNotices().catch(() => {}); }, intervalMs);
  }

  function stopPolling() {
    if (pollInterval) { clearInterval(pollInterval); pollInterval = null; }
  }

  return {
    // State
    notices,
    loading,
    error,
    rsvpsByNotice,
    acksByNotice,
    savedNotices,
    commentsByNotice,
    reactionsByNotice,
    activeFilter,

    // Computed
    filteredFeed,
    upcomingEvents,
    currentUpdates,
    pastNotices,
    draftNotices,
    savedNoticeIds,

    // Actions
    loadNotices,
    handleCreateNotice,
    handlePublish,
    handleArchive,
    handleRsvp,
    loadRsvps,
    handleAck,
    loadAcks,
    handleToggleSave,
    loadSavedNotices,
    loadComments,
    handleAddComment,
    getCommentCount,
    loadReactions,
    handleToggleReaction,
    getReactionSummaries,
    handleTogglePin,
    setFilter,
    getRsvpCounts,
    hasAcked,
    isSaved,
    refreshAll,
    startPolling,
    stopPolling,
  };
});
