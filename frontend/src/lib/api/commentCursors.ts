import { BACKEND_URL } from 'src/lib/api/client';

export type CommentEntityType = 'project' | 'contribution' | 'notice';

export function cursorKey(type: CommentEntityType, id: string): string {
  return `${type}:${id}`;
}

export async function getCommentCursors(): Promise<Record<string, number>> {
  try {
    const r = await fetch(`${BACKEND_URL}/api/v1/comment-cursors`);
    if (!r.ok) return {};
    const data = await r.json();
    return (data.cursors ?? {}) as Record<string, number>;
  } catch {
    return {};
  }
}

export async function updateCommentCursor(
  key: string,
  count: number,
): Promise<Record<string, number> | null> {
  try {
    const r = await fetch(`${BACKEND_URL}/api/v1/comment-cursors`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key, count }),
    });
    if (!r.ok) return null;
    const data = await r.json();
    return (data.cursors ?? null) as Record<string, number> | null;
  } catch {
    return null;
  }
}
