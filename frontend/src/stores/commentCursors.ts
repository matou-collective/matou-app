import { defineStore } from 'pinia';
import { ref } from 'vue';
import {
  cursorKey,
  getCommentCursors,
  updateCommentCursor,
  type CommentEntityType,
} from 'src/lib/api/commentCursors';

export const useCommentCursorsStore = defineStore('commentCursors', () => {
  const cursors = ref<Record<string, number>>({});
  const loaded = ref(false);

  // Per-notice latest comment count (notices don't carry the count on the entity,
  // so we cache it here once the user has viewed a notice or it's been refreshed).
  const noticeCounts = ref<Record<string, number>>({});

  async function fetch() {
    cursors.value = await getCommentCursors();
    loaded.value = true;
  }

  function getCursor(type: CommentEntityType, id: string): number {
    return cursors.value[cursorKey(type, id)] ?? 0;
  }

  function unread(type: CommentEntityType, id: string, count: number): number {
    if (!count || count <= 0) return 0;
    const c = getCursor(type, id);
    return Math.max(0, count - c);
  }

  async function markRead(type: CommentEntityType, id: string, count: number) {
    const key = cursorKey(type, id);
    const current = cursors.value[key] ?? 0;
    if (count <= current) return;
    cursors.value = { ...cursors.value, [key]: count };
    const updated = await updateCommentCursor(key, count);
    if (updated) cursors.value = updated;
  }

  function setNoticeCount(noticeId: string, count: number) {
    noticeCounts.value = { ...noticeCounts.value, [noticeId]: count };
  }

  function getNoticeCount(noticeId: string): number {
    return noticeCounts.value[noticeId] ?? 0;
  }

  return {
    cursors,
    loaded,
    noticeCounts,
    fetch,
    getCursor,
    unread,
    markRead,
    setNoticeCount,
    getNoticeCount,
  };
});
