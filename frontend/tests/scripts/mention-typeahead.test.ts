// @vitest-environment happy-dom
/**
 * Unit tests for the shared @-mention typeahead composable (issue #604), which
 * the chat composer and the contribution/sub-task comment composer both use.
 *
 * Covers the composer behaviour that used to live inline in the chat
 * MessageComposer: detect an in-progress `@` before the caret, live-filter the
 * community roster, insert a `@[person:AID|Name]` token on selection, and drive
 * the dropdown from the keyboard — plus the client-side AID resolution the
 * comment composer feeds to the notify-on-mention backend path.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';
import { ref } from 'vue';
import { useMentionTypeahead } from 'src/composables/useMentionTypeahead';
import { useProfilesStore } from 'src/stores/profiles';
import { parseMentions } from 'src/lib/mentions';

function seedPeople() {
  const store = useProfilesStore();
  store.communityProfiles = [
    { data: { aid: 'EAlice', displayName: 'Alice Ngata' } },
    { data: { aid: 'EBob', displayName: 'Bob Rangi' } },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ] as any;
}

// Minimal textarea stub: the composable only reads selectionStart and calls
// focus()/setSelectionRange() (inside nextTick) which we can no-op.
function fakeTextarea(caret: number): HTMLTextAreaElement {
  return {
    selectionStart: caret,
    focus() {},
    setSelectionRange() {},
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

describe('useMentionTypeahead', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  it('opens the dropdown with live-filtered people when @ is typed', () => {
    seedPeople();
    const content = ref('hey @al');
    const ta = fakeTextarea(content.value.length);
    const t = useMentionTypeahead(content, () => ta);
    t.detectMention();
    expect(t.mentionDropdownOpen.value).toBe(true);
    expect(t.mentionCandidates.value.map((c) => c.id)).toEqual(['EAlice']);
  });

  it('inserts a person mention token on selection, resolving to the AID', () => {
    seedPeople();
    const content = ref('hey @al');
    const t = useMentionTypeahead(content, () => fakeTextarea(content.value.length));
    t.detectMention();
    t.selectMention(t.mentionCandidates.value[0]!);
    expect(content.value).toBe('hey @[person:EAlice|Alice Ngata] ');
    // The comment composer parses this back into the AIDs it sends the backend.
    const aids = parseMentions(content.value)
      .filter((m) => m.type === 'person')
      .map((m) => m.id);
    expect(aids).toEqual(['EAlice']);
  });

  it('does not trigger on a mid-word @ (email addresses)', () => {
    seedPeople();
    const content = ref('mail me at bob@al');
    const t = useMentionTypeahead(content, () => fakeTextarea(content.value.length));
    t.detectMention();
    expect(t.mentionDropdownOpen.value).toBe(false);
  });

  it('navigates with the arrow keys and selects with Enter', () => {
    seedPeople();
    const content = ref('@');
    const t = useMentionTypeahead(content, () => fakeTextarea(1));
    t.detectMention();
    expect(t.mentionDropdownOpen.value).toBe(true);

    expect(t.handleMentionKeydown(new KeyboardEvent('keydown', { key: 'ArrowDown' }))).toBe(true);
    expect(t.mentionActiveIndex.value).toBe(1);
    expect(t.handleMentionKeydown(new KeyboardEvent('keydown', { key: 'Enter' }))).toBe(true);
    expect(content.value).toContain('@[person:EBob|Bob Rangi]');
  });

  it('returns false for keys it does not consume', () => {
    seedPeople();
    const content = ref('@al');
    const t = useMentionTypeahead(content, () => fakeTextarea(content.value.length));
    t.detectMention();
    expect(t.handleMentionKeydown(new KeyboardEvent('keydown', { key: 'a' }))).toBe(false);
  });
});
