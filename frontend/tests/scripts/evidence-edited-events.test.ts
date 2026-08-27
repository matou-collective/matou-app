import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// SSE delivers NAMED events via addEventListener — an event name that is not
// registered on the receiving side is dropped entirely. These checks pin the
// registration of `contribution:evidence_edited` in every list that has to
// know about it (issue #9 review, blocking item 2).
const src = (rel: string) => readFileSync(resolve(__dirname, '../../src', rel), 'utf8');

describe('contribution:evidence_edited is wired end-to-end on the client', () => {
  it('is a listened-for BackendEventType', () => {
    const s = src('composables/useBackendEvents.ts');
    expect(s).toMatch(/\|\s*'contribution:evidence_edited'/);
    expect(s).toMatch(/'contribution:evidence_edited',/);
  });

  it('is surfaced as an in-app notification with a title', () => {
    const s = src('composables/useNotifications.ts');
    expect(s).toMatch(/NOTIFICATION_EVENTS = \[[^\]]*'contribution:evidence_edited'/s);
    expect(s).toMatch(/'contribution:evidence_edited': 'Submission Edited'/);
  });

  it('refreshes the open project view', () => {
    const s = src('pages/Projects/ProjectDetailPage.vue');
    expect(s).toMatch(/refreshEvents = \[[^\]]*'contribution:evidence_edited'/s);
  });

  it('renders evidence_edited_at in the detail body', () => {
    const s = src('components/contributions/ContributionDetailBody.vue');
    expect(s).toContain('contribution.evidence_edited_at');
  });
});
