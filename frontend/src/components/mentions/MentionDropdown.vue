<template>
  <ul class="mention-dropdown" role="listbox">
    <li
      v-for="(candidate, idx) in candidates"
      :key="candidate.type + ':' + candidate.id"
      class="mention-option"
      :class="{ active: idx === activeIndex }"
      role="option"
      :aria-selected="idx === activeIndex"
      @mousedown.prevent="$emit('select', candidate)"
      @mouseenter="$emit('hover', idx)"
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
</template>

<script setup lang="ts">
import { type Component } from 'vue';
import { Folder, Vote, Award, CalendarDays, RefreshCw } from 'lucide-vue-next';
import type { MentionCandidate } from 'src/composables/useMentionSearch';
import type { MentionType } from 'src/lib/mentions';
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

defineProps<{
  candidates: MentionCandidate[];
  activeIndex: number;
}>();

defineEmits<{
  (e: 'select', candidate: MentionCandidate): void;
  (e: 'hover', idx: number): void;
}>();
</script>

<style lang="scss" scoped>
.mention-dropdown {
  max-height: 220px;
  overflow-y: auto;
  margin: 0;
  padding: 0.25rem;
  list-style: none;
  background-color: var(--matou-card);
  border: 1px solid var(--matou-border);
  border-radius: var(--matou-radius);
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.18);
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
</style>
