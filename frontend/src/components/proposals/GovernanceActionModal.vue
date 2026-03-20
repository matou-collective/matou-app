<template>
  <q-dialog :model-value="modelValue" @update:model-value="$emit('update:modelValue', $event)">
    <q-card style="min-width: 500px; max-width: 600px">
      <q-card-section class="row items-center q-pb-none">
        <div class="row items-center q-gutter-sm">
          <q-icon :name="getActionIcon(action.action_type)" size="22px" color="primary" />
          <span class="text-h6">
            {{ formatLabel(action.action_type) }} &mdash; {{ formatHouse(action.house) }}
          </span>
        </div>
        <q-space />
        <q-btn icon="close" flat round dense v-close-popup />
      </q-card-section>

      <q-card-section class="q-pt-md">
        <p class="text-body1 q-mb-md">{{ action.description }}</p>

        <!-- ── Meeting / Discussion ───────────────────────────────────────── -->
        <template v-if="action.action_type === 'meeting' || action.action_type === 'discussion'">
          <div v-if="action.meeting_date" class="detail-card">
            <div class="detail-row">
              <q-icon name="event" size="16px" color="primary" />
              <span>
                {{ action.meeting_date }}{{ action.meeting_time ? ' at ' + action.meeting_time : '' }}
              </span>
            </div>
            <div v-if="action.meeting_location" class="detail-row">
              <q-icon name="location_on" size="16px" color="primary" />
              <span>{{ action.meeting_location }}</span>
            </div>
          </div>

          <div v-if="action.status === 'completed'" class="completed-badge completed-badge--positive q-mt-md">
            <q-icon name="check_circle" />
            <span>Completed</span>
          </div>
          <div v-else class="q-mt-lg">
            <q-btn
              flat
              no-caps
              label="Mark as Complete"
              color="positive"
              icon="check_circle"
              @click="handleComplete()"
            />
          </div>
        </template>

        <!-- ── Decision / Vote ───────────────────────────────────────────── -->
        <template v-if="action.action_type === 'decision'">
          <!-- Linked action info -->
          <div v-if="linkedAction" class="detail-card q-mb-md">
            <div class="text-caption text-weight-bold q-mb-xs text-grey">Linked to:</div>
            <div class="detail-row">
              <q-icon :name="getActionIcon(linkedAction.action_type)" size="16px" color="primary" />
              <span class="ellipsis">{{ linkedAction.description }}</span>
              <span class="status-badge" :class="`status-badge--${linkedAction.status}`">
                {{ linkedAction.status }}
              </span>
            </div>
          </div>

          <!-- Voting not yet open (proposal not in voting process) -->
          <div v-if="votingNotOpen" class="voting-locked">
            <q-icon name="schedule" size="20px" />
            <div>
              <div class="text-weight-bold">Voting Not Yet Open</div>
              <div class="text-caption">
                Voting begins when the proposal moves to the voting process.
              </div>
            </div>
          </div>

          <!-- Voting locked (linked meeting not complete) -->
          <div v-else-if="votingLocked" class="voting-locked">
            <q-icon name="lock" size="20px" />
            <div>
              <div class="text-weight-bold">Voting Locked</div>
              <div class="text-caption">
                The linked meeting must be completed before voting can begin.
              </div>
            </div>
          </div>

          <!-- Vote buttons -->
          <template v-else-if="action.status !== 'completed'">
            <div class="text-subtitle2 q-mb-sm">Cast Your Vote</div>
            <div class="vote-buttons">
              <template v-if="action.house === 'elders_council'">
                <q-btn
                  outline
                  no-caps
                  label="No Veto"
                  color="positive"
                  icon="thumb_up"
                  @click="handleVote('no_veto')"
                />
                <q-btn
                  outline
                  no-caps
                  label="Veto"
                  color="negative"
                  icon="block"
                  @click="handleVote('veto')"
                />
              </template>
              <template v-else>
                <q-btn
                  outline
                  no-caps
                  label="Approve"
                  color="positive"
                  icon="thumb_up"
                  @click="handleVote('approved')"
                />
                <q-btn
                  outline
                  no-caps
                  label="Reject"
                  color="negative"
                  icon="thumb_down"
                  @click="handleVote('rejected')"
                />
              </template>
            </div>
          </template>

          <!-- Completed outcome -->
          <div
            v-else
            class="completed-badge q-mt-md"
            :class="outcomePositive ? 'completed-badge--positive' : 'completed-badge--negative'"
          >
            <q-icon :name="outcomePositive ? 'check_circle' : 'cancel'" />
            <span>{{ action.outcome ? formatOutcome(action.outcome) : 'Decided' }}</span>
          </div>
        </template>
      </q-card-section>

      <div class="dialog-footer">
        <q-btn outline no-caps label="Close" color="primary" class="dialog-footer-btn" v-close-popup />
      </div>
    </q-card>
  </q-dialog>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import type { GovernanceAction } from 'src/lib/api/decisionPlans';

// ── Component interface ──────────────────────────────────────────────────────

const props = defineProps<{
  modelValue: boolean;
  action: GovernanceAction;
  allActions: GovernanceAction[];
  proposalStatus?: string;
}>();

const emit = defineEmits<{
  'update:modelValue': [value: boolean];
  /** Emitted when a meeting/discussion is marked complete, or a vote is cast. */
  complete: [actionId: string, outcome?: string];
}>();

// ── Computed ─────────────────────────────────────────────────────────────────

const linkedAction = computed<GovernanceAction | null>(() => {
  if (!props.action.linked_action_id) return null;
  return props.allActions.find((a) => a.id === props.action.linked_action_id) ?? null;
});

const votingLocked = computed<boolean>(() => {
  if (!linkedAction.value) return false;
  return linkedAction.value.status !== 'completed';
});

const votingNotOpen = computed<boolean>(() => {
  if (props.action.action_type !== 'decision') return false;
  return props.proposalStatus !== 'voting_process';
});

const outcomePositive = computed<boolean>(() => {
  const o = props.action.outcome;
  return o === 'approved' || o === 'no_veto';
});

// ── Helpers ───────────────────────────────────────────────────────────────────

function getActionIcon(type: GovernanceAction['action_type']): string {
  switch (type) {
    case 'discussion':
      return 'chat';
    case 'meeting':
      return 'event';
    case 'decision':
      return 'how_to_vote';
  }
}

function formatLabel(raw: string): string {
  return raw.charAt(0).toUpperCase() + raw.slice(1);
}

function formatHouse(house: string): string {
  return house
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (l) => l.toUpperCase());
}

function formatOutcome(outcome: string): string {
  return outcome
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (l) => l.toUpperCase());
}

// ── Handlers ─────────────────────────────────────────────────────────────────

function handleComplete() {
  emit('complete', props.action.id);
}

function handleVote(outcome: string) {
  emit('complete', props.action.id, outcome);
}
</script>

<style scoped lang="scss">
.dialog-footer {
  display: flex;
  gap: 8px;
  padding: 12px 20px 16px;
  border-top: 1px solid var(--matou-border);
}

.dialog-footer-btn {
  flex: 1;
  border-radius: 10px;
}

.detail-card {
  background: var(--matou-secondary);
  border: 1px solid var(--matou-border);
  border-radius: var(--matou-radius-sm);
  padding: 12px 14px;
}

.detail-row {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 6px;
  font-size: 0.9rem;

  &:last-child {
    margin-bottom: 0;
  }

  .ellipsis {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    flex: 1;
  }
}

// ── Status badge ─────────────────────────────────────────────────────────────

.status-badge {
  font-size: 0.7rem;
  padding: 2px 8px;
  border-radius: 10px;
  flex-shrink: 0;
  text-transform: capitalize;
  background: var(--matou-muted);
  color: var(--matou-muted-foreground);

  &--completed {
    background: #d1fae5;
    color: #059669;
  }

  &--planned {
    background: var(--matou-muted);
    color: var(--matou-muted-foreground);
  }
}

// ── Voting locked ─────────────────────────────────────────────────────────────

.voting-locked {
  display: flex;
  align-items: flex-start;
  gap: 12px;
  padding: 14px 16px;
  background: #fef3c7;
  border-radius: var(--matou-radius-sm);
  color: #92400e;
}

// ── Vote buttons ──────────────────────────────────────────────────────────────

.vote-buttons {
  display: flex;
  gap: 10px;
}

// ── Outcome badge ─────────────────────────────────────────────────────────────

.completed-badge {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 8px 16px;
  border-radius: var(--matou-radius-sm);
  font-weight: 500;
  font-size: 0.9rem;

  &--positive {
    background: #d1fae5;
    color: #059669;
  }

  &--negative {
    background: #fee2e2;
    color: #dc2626;
  }
}
</style>
