<template>
  <div class="message-composer">
    <!-- Reply Preview -->
    <ReplyPreview
      v-if="replyTo"
      :message="replyTo"
      @cancel="$emit('cancelReply')"
    />

    <!-- Attachment Uploader -->
    <AttachmentUploader
      v-show="showUploader"
      ref="uploaderRef"
      @change="pendingFileCount = $event"
      @error="(msg: string) => console.error('[Attachment]', msg)"
    />

    <!-- @-mention typeahead -->
    <ul v-if="mentionDropdownOpen" class="mention-dropdown" role="listbox">
      <li
        v-for="(candidate, idx) in mentionCandidates"
        :key="candidate.type + ':' + candidate.id"
        class="mention-option"
        :class="{ active: idx === mentionActiveIndex }"
        role="option"
        :aria-selected="idx === mentionActiveIndex"
        @mousedown.prevent="selectMention(candidate)"
        @mouseenter="mentionActiveIndex = idx"
      >
        <UserAvatar
          v-if="candidate.type === 'person'"
          :aid="candidate.id"
          :name="candidate.display"
          :size="24"
          :clickable="false"
        />
        <span v-else class="mention-option-icon">
          <component :is="MENTION_ICONS[candidate.type]" class="icon" />
        </span>
        <span class="mention-option-name">{{ candidate.display }}</span>
        <span v-if="candidate.type !== 'person'" class="mention-option-type">{{ candidate.type }}</span>
      </li>
    </ul>

    <!-- Input Area -->
    <div class="composer-input-area">
      <button
        class="attach-btn"
        @click="showUploader = !showUploader"
        title="Attach files"
      >
        <Paperclip class="icon" />
      </button>

      <textarea
        ref="textareaRef"
        v-model="content"
        class="message-input"
        :placeholder="placeholder"
        rows="1"
        @keydown="handleKeydown"
        @input="onInput"
        @keyup="detectMention"
        @click="detectMention"
        @blur="closeMention"
      ></textarea>

      <button
        class="send-btn"
        :disabled="!canSend || sending || uploading"
        @click="handleSend"
        :title="sending || uploading ? 'Sending...' : 'Send message'"
      >
        <Loader2 v-if="sending || uploading" class="icon spin" />
        <Send v-else class="icon" />
      </button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, nextTick, onMounted, type Component } from 'vue';
import {
  Send,
  Loader2,
  Paperclip,
  Folder,
  Vote,
  Award,
  CalendarDays,
  RefreshCw,
} from 'lucide-vue-next';
import type { ChatMessage, AttachmentRef } from 'src/lib/api/chat';
import { useProfilesStore } from 'stores/profiles';
import { useProjectsStore } from 'stores/projects';
import { useProposalsStore } from 'stores/proposals';
import { useContributionsStore } from 'stores/contributions';
import { useActivityStore } from 'stores/activity';
import { useMentionSearch, type MentionCandidate } from 'src/composables/useMentionSearch';
import { serializeMention, type MentionType } from 'src/lib/mentions';
import ReplyPreview from './ReplyPreview.vue';
import AttachmentUploader from './AttachmentUploader.vue';
import UserAvatar from 'components/profiles/UserAvatar.vue';

// Dropdown glyph per non-person type (people use their avatar). Mirrors the
// dashboard's notice iconography so events/updates read the same everywhere.
const MENTION_ICONS: Partial<Record<MentionType, Component>> = {
  project: Folder,
  proposal: Vote,
  contribution: Award,
  event: CalendarDays,
  update: RefreshCw,
};

const props = defineProps<{
  channelId: string;
  replyTo: ChatMessage | null;
  sending: boolean;
}>();

const emit = defineEmits<{
  (e: 'send', content: string, attachments: AttachmentRef[]): void;
  (e: 'cancelReply'): void;
}>();

const content = ref('');
const textareaRef = ref<HTMLTextAreaElement | null>(null);
const uploaderRef = ref<InstanceType<typeof AttachmentUploader> | null>(null);
const showUploader = ref(false);
const uploading = ref(false);
const pendingFileCount = ref(0);
const profilesStore = useProfilesStore();
const projectsStore = useProjectsStore();
const proposalsStore = useProposalsStore();
const contributionsStore = useContributionsStore();
const activityStore = useActivityStore();

// --- @-mention typeahead ---
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
  const el = textareaRef.value;
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

function onInput() {
  autoResize();
  detectMention();
}

function selectMention(candidate: MentionCandidate) {
  const el = textareaRef.value;
  const caret = el?.selectionStart ?? content.value.length;
  const end = mentionStart.value + 1 + mentionQuery.value.length;
  const token = serializeMention(candidate.type, candidate.id, candidate.display);
  const before = content.value.slice(0, mentionStart.value);
  const after = content.value.slice(Math.max(end, caret));
  content.value = `${before}${token} ${after}`;
  closeMention();
  nextTick(() => {
    if (!el) return;
    const pos = before.length + token.length + 1;
    el.focus();
    el.setSelectionRange(pos, pos);
    autoResize();
  });
}

const placeholder = computed(() => {
  if (props.replyTo) {
    const profile = profilesStore.profilesByAid[props.replyTo.senderAid];
    const name = profile?.displayName || props.replyTo.senderName;
    return `Reply to ${name}...`;
  }
  return 'Type a message...';
});

const canSend = computed(() => {
  return content.value.trim().length > 0 || pendingFileCount.value > 0;
});

function handleKeydown(e: KeyboardEvent) {
  // Mention typeahead navigation takes priority while the dropdown is open.
  if (mentionDropdownOpen.value) {
    const count = mentionCandidates.value.length;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      mentionActiveIndex.value = (mentionActiveIndex.value + 1) % count;
      return;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      mentionActiveIndex.value = (mentionActiveIndex.value - 1 + count) % count;
      return;
    }
    if (e.key === 'Enter' || e.key === 'Tab') {
      e.preventDefault();
      const candidate = mentionCandidates.value[mentionActiveIndex.value];
      if (candidate) selectMention(candidate);
      return;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      mentionDismissedStart.value = mentionStart.value;
      closeMention();
      return;
    }
  }

  // Send on Enter (without Shift)
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    if (canSend.value && !props.sending && !uploading.value) {
      handleSend();
    }
  }
}

async function handleSend() {
  if (!canSend.value || props.sending || uploading.value) return;

  let attachments: AttachmentRef[] = [];
  if (pendingFileCount.value > 0) {
    uploading.value = true;
    try {
      attachments = await uploaderRef.value!.uploadAll();
    } finally {
      uploading.value = false;
    }
  }

  emit('send', content.value.trim(), attachments);
  content.value = '';
  showUploader.value = false;
  closeMention();

  nextTick(() => {
    if (textareaRef.value) {
      textareaRef.value.style.height = 'auto';
      textareaRef.value.focus();
    }
  });
}

function autoResize() {
  if (!textareaRef.value) return;

  textareaRef.value.style.height = 'auto';
  const maxHeight = 200;
  const scrollHeight = textareaRef.value.scrollHeight;
  textareaRef.value.style.height = `${Math.min(scrollHeight, maxHeight)}px`;
}

function focus() {
  textareaRef.value?.focus();
}

onMounted(() => {
  focus();
  // Warm the local stores the @-mention typeahead searches, in case the user
  // opens chat before other views have loaded them. Each is a no-op-ish
  // refresh if already populated; failures are non-fatal (typeahead just has
  // fewer candidates until the owning view loads them).
  if (profilesStore.communityProfiles.length === 0) {
    void profilesStore.loadCommunityProfiles();
  }
  if (projectsStore.projects.length === 0) {
    void projectsStore.fetchProjects().catch(() => {});
  }
  if (proposalsStore.proposals.length === 0) {
    void proposalsStore.fetchProposals().catch(() => {});
  }
  if (contributionsStore.contributions.length === 0) {
    void contributionsStore.fetchContributions().catch(() => {});
  }
  if (activityStore.notices.length === 0) {
    void activityStore.loadNotices().catch(() => {});
  }
});

defineExpose({ focus });
</script>

<style lang="scss" scoped>
.message-composer {
  border-top: 1px solid var(--matou-border);
  background-color: var(--matou-card);
  padding: 0.75rem 1rem;
  position: relative;
}

.mention-dropdown {
  position: absolute;
  bottom: calc(100% - 0.25rem);
  left: 1rem;
  right: 1rem;
  max-height: 220px;
  overflow-y: auto;
  margin: 0 0 0.25rem;
  padding: 0.25rem;
  list-style: none;
  background-color: var(--matou-card);
  border: 1px solid var(--matou-border);
  border-radius: var(--matou-radius);
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.18);
  z-index: 20;
}

.mention-option {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.375rem 0.5rem;
  border-radius: var(--matou-radius);
  cursor: pointer;

  &.active {
    background-color: var(--matou-secondary);
  }
}

.mention-option-icon {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  border-radius: 50%;
  flex-shrink: 0;
  color: var(--matou-primary);
  background-color: color-mix(in srgb, var(--matou-primary) 12%, transparent);

  .icon {
    width: 14px;
    height: 14px;
  }
}

.mention-option-name {
  font-size: 0.875rem;
  color: var(--matou-foreground);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.mention-option-type {
  margin-left: auto;
  padding-left: 0.5rem;
  font-size: 0.6875rem;
  text-transform: capitalize;
  color: var(--matou-muted-foreground);
  flex-shrink: 0;
}

.composer-input-area {
  display: flex;
  align-items: flex-end;
  gap: 0.5rem;
}

.message-input {
  flex: 1;
  padding: 0.625rem 0.75rem;
  border: 1px solid var(--matou-border);
  border-radius: var(--matou-radius);
  background-color: var(--matou-background);
  color: var(--matou-foreground);
  font-size: 0.875rem;
  font-family: inherit;
  line-height: 1.5;
  resize: none;
  outline: none;
  transition: border-color 0.15s ease;

  &:focus {
    border-color: var(--matou-primary);
  }

  &:disabled {
    opacity: 0.6;
    cursor: not-allowed;
  }

  &::placeholder {
    color: var(--matou-muted-foreground);
  }
}

.attach-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 36px;
  height: 36px;
  border-radius: var(--matou-radius);
  background: transparent;
  border: 1px solid var(--matou-border);
  cursor: pointer;
  color: var(--matou-muted-foreground);
  transition: all 0.15s ease;
  flex-shrink: 0;

  &:hover {
    color: var(--matou-foreground);
    border-color: var(--matou-primary);
  }

  .icon {
    width: 18px;
    height: 18px;
  }
}

.send-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 36px;
  height: 36px;
  border-radius: 10px;
  background-color: var(--matou-primary);
  border: none;
  cursor: pointer;
  color: white;
  transition: all 0.15s ease;
  flex-shrink: 0;

  &:hover:not(:disabled) {
    opacity: 0.9;
  }

  &:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .icon {
    width: 18px;
    height: 18px;
  }

  .spin {
    animation: spin 1s linear infinite;
  }
}

@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}
</style>
