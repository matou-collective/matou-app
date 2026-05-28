<template>
  <q-dialog
    :model-value="modelValue"
    @update:model-value="$emit('update:modelValue', $event)"
  >
    <q-card style="min-width: 500px; max-width: 600px">
      <q-card-section>
        <div class="text-h6 row items-center q-gutter-sm">
          <q-icon name="history" />
          <span>Proposal History</span>
        </div>
      </q-card-section>

      <q-card-section style="max-height: 60vh; overflow-y: auto">
        <div v-if="history.length === 0" class="text-center text-grey q-pa-lg">
          No history entries yet
        </div>

        <div v-else class="timeline">
          <div v-for="entry in history" :key="entry.id" class="timeline-item">
            <div
              class="timeline-dot"
              :class="entry.user_id === 'system' ? 'system' : 'user'"
            />
            <div class="timeline-content">
              <div class="timeline-action">{{ entry.action }}</div>
              <div class="timeline-meta">
                <span class="timeline-user">{{ entry.user_id }}</span>
                <span class="timeline-sep">&middot;</span>
                <span class="timeline-time">{{ formatTime(entry.created_at) }}</span>
              </div>
              <div v-if="entry.changes?.length" class="timeline-changes">
                <div v-for="(change, i) in entry.changes" :key="i" class="change-item">
                  <span class="change-field">{{ change.field }}:</span>
                  <span class="change-old">{{ change.old_value }}</span>
                  <span class="change-arrow">&rarr;</span>
                  <span class="change-new">{{ change.new_value }}</span>
                </div>
              </div>
            </div>
          </div>
        </div>
      </q-card-section>

      <q-card-actions align="right">
        <q-btn flat label="Close" v-close-popup />
      </q-card-actions>
    </q-card>
  </q-dialog>
</template>

<script setup lang="ts">
import type { ProposalHistoryEntry } from 'src/lib/api/proposals';

defineProps<{
  modelValue: boolean;
  history: ProposalHistoryEntry[];
}>();

defineEmits<{
  'update:modelValue': [value: boolean];
}>();

function formatTime(dateStr: string): string {
  if (!dateStr) return '';
  return new Date(dateStr).toLocaleString(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  });
}
</script>

<style scoped lang="scss">
.timeline {
  position: relative;
  padding-left: 24px;

  &::before {
    content: '';
    position: absolute;
    left: 8px;
    top: 0;
    bottom: 0;
    width: 2px;
    background: var(--border-color, #e5e7eb);
  }
}

.timeline-item {
  position: relative;
  padding-bottom: 20px;

  &:last-child {
    padding-bottom: 0;
  }
}

.timeline-dot {
  position: absolute;
  left: -20px;
  top: 4px;
  width: 12px;
  height: 12px;
  border-radius: 50%;
  background: var(--matou-teal, #0d9488);

  &.system {
    background: #9ca3af;
  }
}

.timeline-action {
  font-weight: 500;
  margin-bottom: 4px;
}

.timeline-meta {
  font-size: 0.8rem;
  color: var(--text-tertiary, #9ca3af);
}

.timeline-sep {
  margin: 0 4px;
}

.timeline-changes {
  margin-top: 8px;
  padding: 8px;
  background: var(--matou-teal-light, #f0f9ff);
  border-radius: 6px;
  font-size: 0.8rem;
}

.change-field {
  font-weight: 500;
  margin-right: 4px;
}

.change-old {
  color: #dc2626;
  text-decoration: line-through;
}

.change-arrow {
  margin: 0 4px;
  color: #9ca3af;
}

.change-new {
  color: #059669;
}
</style>
