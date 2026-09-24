/**
 * Shared @-mention typeahead behaviour for a plain-textarea composer
 * (issues #12, #37, #604).
 *
 * This lifts the inline typeahead that used to live inside the chat
 * `MessageComposer.vue` — detect an in-progress `@mention` before the caret,
 * drive a live-filtering dropdown over {@link useMentionSearch}, and insert a
 * `@[type:id|Display]` token on selection — into one composable so the chat
 * composer and the contribution/sub-task comment composer share a single
 * implementation instead of duplicating it.
 *
 * The caller owns the content string and provides a getter for the underlying
 * `<textarea>` element (a raw ref for chat; the native node inside a Quasar
 * `q-input` for comments). A getter avoids the readonly/writable ref-variance
 * friction of passing a computed ref, and is resolved lazily so it works
 * whether or not the textarea is mounted when the composable is created.
 */
import { ref, computed, nextTick, type Ref } from 'vue';
import { useMentionSearch, type MentionCandidate } from './useMentionSearch';
import { serializeMention } from 'src/lib/mentions';

export interface MentionTypeahead {
  mentionQuery: Ref<string>;
  mentionActiveIndex: Ref<number>;
  mentionCandidates: Ref<MentionCandidate[]>;
  mentionDropdownOpen: Ref<boolean>;
  closeMention: () => void;
  detectMention: () => void;
  selectMention: (candidate: MentionCandidate) => void;
  /** Handle a keydown while the dropdown is open; returns true when consumed. */
  handleMentionKeydown: (e: KeyboardEvent) => boolean;
}

export function useMentionTypeahead(
  content: Ref<string>,
  getTextarea: () => HTMLTextAreaElement | null,
  opts: { onChange?: () => void } = {},
): MentionTypeahead {
  const { search: searchMentions } = useMentionSearch();
  const mentionActive = ref(false);
  const mentionQuery = ref('');
  // Index of the triggering '@' within `content`.
  const mentionStart = ref(0);
  const mentionActiveIndex = ref(0);
  // '@' index dismissed via Escape: detectMention (which also runs on keyup,
  // including Escape's own keyup) must not reopen for the same token.
  const mentionDismissedStart = ref<number | null>(null);

  const mentionCandidates = computed<MentionCandidate[]>(() =>
    mentionActive.value ? searchMentions(mentionQuery.value) : [],
  );
  const mentionDropdownOpen = computed(
    () => mentionActive.value && mentionCandidates.value.length > 0,
  );

  function closeMention() {
    mentionActive.value = false;
    mentionQuery.value = '';
  }

  // Detect an in-progress `@mention` immediately before the caret and open the
  // typeahead. Triggers only when the `@` starts a word (line start or after
  // whitespace), so email addresses and mid-word `@` don't fire it. The query
  // may span spaces (Slack-style) so multi-word titles — "Fix login flow" — and
  // "@Andrew W" keep matching; a runaway tail (long, or many words with no hit)
  // simply yields no candidates and the dropdown stays hidden.
  function detectMention() {
    const el = getTextarea();
    if (!el) return closeMention();
    const caret = el.selectionStart ?? content.value.length;
    const before = content.value.slice(0, caret);
    // Capture everything after the triggering `@` up to the caret, excluding a
    // later `@` (that starts a fresh mention) and newlines. Bounded so an `@`
    // early in a long message doesn't turn the whole line into a query.
    const match = /(?:^|\s)@([^@\n]{0,60})$/.exec(before);
    if (!match || match[1].split(/\s+/).filter(Boolean).length > 6) {
      mentionDismissedStart.value = null;
      return closeMention();
    }
    const start = caret - match[1].length - 1;
    if (mentionDismissedStart.value === start) return closeMention();
    mentionDismissedStart.value = null;
    mentionQuery.value = match[1];
    mentionStart.value = start;
    if (!mentionActive.value) mentionActiveIndex.value = 0;
    mentionActive.value = true;
    if (mentionActiveIndex.value >= mentionCandidates.value.length) {
      mentionActiveIndex.value = 0;
    }
  }

  function selectMention(candidate: MentionCandidate) {
    const el = getTextarea();
    const caret = el?.selectionStart ?? content.value.length;
    const end = mentionStart.value + 1 + mentionQuery.value.length;
    const token = serializeMention(candidate.type, candidate.id, candidate.display);
    const before = content.value.slice(0, mentionStart.value);
    const after = content.value.slice(Math.max(end, caret));
    content.value = `${before}${token} ${after}`;
    closeMention();
    opts.onChange?.();
    nextTick(() => {
      if (!el) return;
      const pos = before.length + token.length + 1;
      el.focus();
      el.setSelectionRange(pos, pos);
      opts.onChange?.();
    });
  }

  function handleMentionKeydown(e: KeyboardEvent): boolean {
    if (!mentionDropdownOpen.value) return false;
    const count = mentionCandidates.value.length;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      mentionActiveIndex.value = (mentionActiveIndex.value + 1) % count;
      return true;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      mentionActiveIndex.value = (mentionActiveIndex.value - 1 + count) % count;
      return true;
    }
    if (e.key === 'Enter' || e.key === 'Tab') {
      e.preventDefault();
      const candidate = mentionCandidates.value[mentionActiveIndex.value];
      if (candidate) selectMention(candidate);
      return true;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      mentionDismissedStart.value = mentionStart.value;
      closeMention();
      return true;
    }
    return false;
  }

  return {
    mentionQuery,
    mentionActiveIndex,
    mentionCandidates,
    mentionDropdownOpen,
    closeMention,
    detectMention,
    selectMention,
    handleMentionKeydown,
  };
}
