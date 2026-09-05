import { describe, it, expect } from 'vitest';
import { eventsEnabled, defaultNoticeType, noticeFilters } from '../../src/composables/noticeTypes';

const on = { events: true, notices: true } as never;
const off = { events: false, notices: true } as never;

describe('noticeTypes (coa phase 4, spec §3.3)', () => {
  it('events require both the events and notices toggles', () => {
    expect(eventsEnabled(on)).toBe(true);
    expect(eventsEnabled(off)).toBe(false);
    expect(eventsEnabled({ events: true, notices: false } as never)).toBe(false);
  });

  it('the create dialog defaults to announcement when events are off', () => {
    expect(defaultNoticeType(on)).toBe('event');
    expect(defaultNoticeType(off)).toBe('announcement');
  });

  it('the feed filters drop Events when disabled', () => {
    expect(noticeFilters(on).map((f) => f.value)).toEqual(['all', 'event', 'announcement', 'update']);
    expect(noticeFilters(off).map((f) => f.value)).toEqual(['all', 'announcement', 'update']);
  });
});
