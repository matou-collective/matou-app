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
  type Notice,
  type NoticeRSVP,
  type NoticeAck,
  type NoticeSave,
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

  // Computed: Board views
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

  return {
    // State
    notices,
    loading,
    error,
    rsvpsByNotice,
    acksByNotice,
    savedNotices,

    // Computed
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
    getRsvpCounts,
    hasAcked,
    isSaved,
    refreshAll,
  };
});
