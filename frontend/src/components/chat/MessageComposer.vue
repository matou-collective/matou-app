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
    <div v-if="mentionDropdownOpen" class="mention-dropdown-anchor">
      <MentionDropdown
        :candidates="mentionCandidates"
        :active-index="mentionActiveIndex"
        @select="selectMention"
        @hover="mentionActiveIndex = $event"
      />
    </div>

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
import { ref, computed, nextTick, onMounted } from 'vue';
import { Send, Loader2, Paperclip } from 'lucide-vue-next';
import type { ChatMessage, AttachmentRef } from 'src/lib/api/chat';
import { useProfilesStore } from 'stores/profiles';
import { useProjectsStore } from 'stores/projects';
import { useProposalsStore } from 'stores/proposals';
import { useContributionsStore } from 'stores/contributions';
import { useActivityStore } from 'stores/activity';
import { useMentionTypeahead } from 'src/composables/useMentionTypeahead';
import ReplyPreview from './ReplyPreview.vue';
import AttachmentUploader from './AttachmentUploader.vue';
import MentionDropdown from 'components/mentions/MentionDropdown.vue';

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

// --- @-mention typeahead (shared with the contribution comment composer) ---
const {
  mentionActiveIndex,
  mentionCandidates,
  mentionDropdownOpen,
  closeMention,
  detectMention,
  selectMention,
  handleMentionKeydown,
} = useMentionTypeahead(content, () => textareaRef.value, { onChange: autoResize });

function onInput() {
  autoResize();
  detectMention();
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
  if (handleMentionKeydown(e)) return;

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

.mention-dropdown-anchor {
  position: absolute;
  bottom: calc(100% - 0.25rem);
  left: 1rem;
  right: 1rem;
  margin-bottom: 0.25rem;
  z-index: 20;
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
