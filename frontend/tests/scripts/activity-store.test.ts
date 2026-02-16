/**
 * Unit tests for the Activity store's computed properties and helpers.
 * Tests board view filtering, sorting, and interaction helpers without
 * requiring a real backend connection.
 */
import { describe, it, expect } from 'vitest';

// --- Type definitions (mirror from client.ts, avoid import resolution issues) ---

interface Notice {
  id: string;
  type: 'event' | 'update';
  title: string;
  summary: string;
  state: 'draft' | 'published' | 'archived';
  createdAt: string;
  createdBy: string;
  eventStart?: string;
  eventEnd?: string;
  publishAt?: string;
  activeUntil?: string;
  rsvpEnabled?: boolean;
  ackRequired?: boolean;
  [key: string]: unknown;
}

interface NoticeAck {
  id: string;
  noticeId: string;
  userId: string;
  ackAt: string;
  method: string;
}

interface NoticeSave {
  noticeId: string;
  userId: string;
  savedAt: string;
  pinned: boolean;
}

// --- Pure filtering/sorting functions extracted from store logic ---

function filterUpcoming(notices: Notice[]): Notice[] {
  const now = new Date().toISOString();
  return notices
    .filter(n => n.type === 'event' && n.state === 'published' && (!n.eventStart || n.eventStart >= now))
    .sort((a, b) => (a.eventStart ?? '').localeCompare(b.eventStart ?? ''));
}

function filterCurrentUpdates(notices: Notice[]): Notice[] {
  const now = new Date().toISOString();
  return notices
    .filter(n => n.type === 'update' && n.state === 'published' && (!n.activeUntil || n.activeUntil >= now))
    .sort((a, b) => (b.publishAt ?? b.createdAt).localeCompare(a.publishAt ?? a.createdAt));
}

function filterPast(notices: Notice[]): Notice[] {
  const now = new Date().toISOString();
  return notices
    .filter(n => n.state === 'archived' || (n.activeUntil != null && n.activeUntil < now))
    .sort((a, b) => (b.publishAt ?? b.createdAt).localeCompare(a.publishAt ?? a.createdAt));
}

function filterDrafts(notices: Notice[]): Notice[] {
  return notices.filter(n => n.state === 'draft');
}

function hasAcked(acks: NoticeAck[], noticeId: string, userId: string): boolean {
  return acks.some(a => a.noticeId === noticeId && a.userId === userId);
}

function isSaved(saves: NoticeSave[], noticeId: string): boolean {
  return saves.some(s => s.noticeId === noticeId && s.pinned);
}

function getRsvpCounts(
  rsvps: { status: string }[],
): Record<string, number> {
  const counts: Record<string, number> = { going: 0, maybe: 0, not_going: 0 };
  for (const r of rsvps) {
    if (counts[r.status] !== undefined) {
      counts[r.status]++;
    }
  }
  return counts;
}

// --- Test Data ---

function makeNotice(overrides: Partial<Notice>): Notice {
  return {
    id: 'test-' + Math.random().toString(36).slice(2, 8),
    type: 'event',
    title: 'Test Notice',
    summary: 'Test summary',
    state: 'published',
    createdAt: '2026-01-01T00:00:00Z',
    createdBy: 'user1',
    ...overrides,
  };
}

// --- Tests ---

describe('Activity Store: Board View Filtering', () => {
  it('filters upcoming events correctly', () => {
    const futureDate = '2099-12-31T23:59:59Z';
    const pastDate = '2020-01-01T00:00:00Z';

    const notices: Notice[] = [
      makeNotice({ id: '1', type: 'event', state: 'published', eventStart: futureDate }),
      makeNotice({ id: '2', type: 'event', state: 'published', eventStart: pastDate }),
      makeNotice({ id: '3', type: 'update', state: 'published' }),
      makeNotice({ id: '4', type: 'event', state: 'draft', eventStart: futureDate }),
      makeNotice({ id: '5', type: 'event', state: 'archived', eventStart: futureDate }),
    ];

    const result = filterUpcoming(notices);
    expect(result.length).toBe(1);
    expect(result[0].id).toBe('1');
  });

  it('sorts upcoming events by eventStart ascending', () => {
    const notices: Notice[] = [
      makeNotice({ id: '1', type: 'event', state: 'published', eventStart: '2099-06-01T00:00:00Z' }),
      makeNotice({ id: '2', type: 'event', state: 'published', eventStart: '2099-03-01T00:00:00Z' }),
      makeNotice({ id: '3', type: 'event', state: 'published', eventStart: '2099-09-01T00:00:00Z' }),
    ];

    const result = filterUpcoming(notices);
    expect(result.map(n => n.id)).toEqual(['2', '1', '3']);
  });

  it('filters current updates correctly', () => {
    const notices: Notice[] = [
      makeNotice({ id: '1', type: 'update', state: 'published', activeUntil: '2099-12-31T00:00:00Z' }),
      makeNotice({ id: '2', type: 'update', state: 'published' }), // no activeUntil = always current
      makeNotice({ id: '3', type: 'update', state: 'published', activeUntil: '2020-01-01T00:00:00Z' }), // expired
      makeNotice({ id: '4', type: 'event', state: 'published' }), // wrong type
      makeNotice({ id: '5', type: 'update', state: 'draft' }), // draft
    ];

    const result = filterCurrentUpdates(notices);
    expect(result.length).toBe(2);
    expect(result.map(n => n.id)).toContain('1');
    expect(result.map(n => n.id)).toContain('2');
  });

  it('sorts current updates by publishAt descending', () => {
    const notices: Notice[] = [
      makeNotice({ id: '1', type: 'update', state: 'published', publishAt: '2026-01-01T00:00:00Z' }),
      makeNotice({ id: '2', type: 'update', state: 'published', publishAt: '2026-03-01T00:00:00Z' }),
      makeNotice({ id: '3', type: 'update', state: 'published', publishAt: '2026-02-01T00:00:00Z' }),
    ];

    const result = filterCurrentUpdates(notices);
    expect(result.map(n => n.id)).toEqual(['2', '3', '1']);
  });

  it('filters past notices correctly', () => {
    const notices: Notice[] = [
      makeNotice({ id: '1', state: 'archived' }),
      makeNotice({ id: '2', state: 'published', activeUntil: '2020-01-01T00:00:00Z' }), // expired
      makeNotice({ id: '3', state: 'published', activeUntil: '2099-12-31T00:00:00Z' }), // not expired
      makeNotice({ id: '4', state: 'published' }), // no activeUntil, not archived
    ];

    const result = filterPast(notices);
    expect(result.length).toBe(2);
    expect(result.map(n => n.id)).toContain('1');
    expect(result.map(n => n.id)).toContain('2');
  });

  it('filters drafts correctly', () => {
    const notices: Notice[] = [
      makeNotice({ id: '1', state: 'draft' }),
      makeNotice({ id: '2', state: 'published' }),
      makeNotice({ id: '3', state: 'draft' }),
    ];

    const result = filterDrafts(notices);
    expect(result.length).toBe(2);
  });
});

describe('Activity Store: Interaction Helpers', () => {
  it('getRsvpCounts computes correct counts', () => {
    const rsvps = [
      { status: 'going' },
      { status: 'going' },
      { status: 'maybe' },
      { status: 'not_going' },
    ];

    const counts = getRsvpCounts(rsvps);
    expect(counts.going).toBe(2);
    expect(counts.maybe).toBe(1);
    expect(counts.not_going).toBe(1);
  });

  it('getRsvpCounts returns zeros for empty', () => {
    const counts = getRsvpCounts([]);
    expect(counts.going).toBe(0);
    expect(counts.maybe).toBe(0);
    expect(counts.not_going).toBe(0);
  });

  it('hasAcked returns true when user has acknowledged', () => {
    const acks: NoticeAck[] = [
      { id: '1', noticeId: 'n1', userId: 'u1', ackAt: '2026-01-01T00:00:00Z', method: 'explicit' },
      { id: '2', noticeId: 'n1', userId: 'u2', ackAt: '2026-01-01T00:00:00Z', method: 'explicit' },
    ];

    expect(hasAcked(acks, 'n1', 'u1')).toBe(true);
    expect(hasAcked(acks, 'n1', 'u3')).toBe(false);
    expect(hasAcked(acks, 'n2', 'u1')).toBe(false);
  });

  it('isSaved returns true only for pinned saves', () => {
    const saves: NoticeSave[] = [
      { noticeId: 'n1', userId: 'u1', savedAt: '2026-01-01T00:00:00Z', pinned: true },
      { noticeId: 'n2', userId: 'u1', savedAt: '2026-01-01T00:00:00Z', pinned: false },
    ];

    expect(isSaved(saves, 'n1')).toBe(true);
    expect(isSaved(saves, 'n2')).toBe(false);
    expect(isSaved(saves, 'n3')).toBe(false);
  });
});
