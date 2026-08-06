<template>
  <div class="plan-changes-redline">
    <div
      v-for="group in groups"
      :key="group.key"
      class="redline-card"
      :class="{ 'is-added': group.isAdded, 'is-archived': group.isArchived }"
    >
      <div class="redline-header">
        <div class="redline-title-row">
          <h4 class="redline-title">{{ group.title }}</h4>
          <span v-if="group.isAdded" class="tag tag-added">Added</span>
          <span v-if="group.isArchived" class="tag tag-removed">Removed</span>
        </div>
        <div v-if="group.isAdded && group.addedEvent" class="redline-meta">
          {{ changedByLabel(group.addedEvent.changedBy) }} &middot; {{ formatRelative(group.addedEvent.changedAt) }}
        </div>
        <div v-else-if="group.isArchived && group.archivedEvent" class="redline-meta">
          {{ changedByLabel(group.archivedEvent.changedBy) }} &middot; {{ formatRelative(group.archivedEvent.changedAt) }}
        </div>
      </div>

      <!-- Field edits, most recent first -->
      <div v-if="group.fieldChangeEvents.length" class="redline-field-events">
        <div v-for="event in group.fieldChangeEvents" :key="event.entryId" class="redline-field-event">
          <div v-for="change in event.changes" :key="change.field" class="redline-field">
            <span class="field-label">{{ change.label }}:</span>
            <span class="old-value">{{ change.old_value }}</span>
            <span class="new-value">{{ change.new_value }}</span>
          </div>
          <div class="redline-meta">
            {{ changedByLabel(event.changedBy) }} &middot; {{ formatRelative(event.changedAt) }}
          </div>
        </div>
      </div>

      <!-- Contribution changes -->
      <div v-if="group.contributionChanges.length" class="redline-contributions">
        <div
          v-for="c in group.contributionChanges"
          :key="c.entryId"
          class="redline-contribution-row"
          :class="{ 'is-added': c.kind === 'contribution_added', 'is-removed': c.kind === 'contribution_removed' }"
        >
          <div class="redline-contribution-main">
            <span class="contribution-title">{{ c.title }}</span>
            <span class="tag" :class="contributionTagClass(c.kind)">{{ contributionTagLabel(c.kind) }}</span>
          </div>
          <div v-if="c.changes?.length" class="redline-contribution-fields">
            <div v-for="change in c.changes" :key="change.field" class="redline-field">
              <span class="field-label">{{ change.label }}:</span>
              <span class="old-value">{{ change.old_value }}</span>
              <span class="new-value">{{ change.new_value }}</span>
            </div>
          </div>
          <div class="redline-meta">
            {{ changedByLabel(c.changedBy) }} &middot; {{ formatRelative(c.changedAt) }}
          </div>
        </div>
      </div>
    </div>

    <div v-if="groups.length === 0" class="redline-empty">No changes recorded since the last sign-off.</div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { useProfilesStore } from 'stores/profiles';
import { useAppStore } from 'stores/app';
import { formatRelative } from 'src/lib/formatDate';
import { resolveAidDisplay } from 'src/lib/aidDisplay';
import { buildPlanChangeGroups } from 'src/lib/planChanges';
import type { Milestone, PlanChangeEntry } from 'src/types/projects';

interface Props {
  milestones: Milestone[];
  changeLog?: PlanChangeEntry[];
}

const props = defineProps<Props>();

const profilesStore = useProfilesStore();
const appStore = useAppStore();

const groups = computed(() => buildPlanChangeGroups(props.milestones, props.changeLog));

function changedByLabel(aid: string): string {
  return resolveAidDisplay(aid, profilesStore.profilesByAid, {
    aid: appStore.orgAid,
    name: appStore.orgName,
  });
}

function contributionTagLabel(kind: 'contribution_added' | 'contribution_edited' | 'contribution_removed'): string {
  if (kind === 'contribution_added') return 'Added';
  if (kind === 'contribution_removed') return 'Removed';
  return 'Edited';
}

function contributionTagClass(kind: 'contribution_added' | 'contribution_edited' | 'contribution_removed'): string {
  if (kind === 'contribution_added') return 'tag-added';
  if (kind === 'contribution_removed') return 'tag-removed';
  return 'tag-edited';
}
</script>

<style scoped lang="scss">
.plan-changes-redline {
  display: flex;
  flex-direction: column;
  gap: 10px;
  margin-bottom: 16px;
}

.redline-card {
  border: 1px solid var(--matou-border);
  border-radius: var(--matou-radius);
  padding: 14px 18px;
  background: var(--matou-card);

  &.is-added {
    border-color: var(--matou-accent);
    background: rgba(74, 157, 156, 0.06);
  }

  &.is-archived {
    border-color: var(--matou-destructive);
    background: rgba(200, 70, 58, 0.05);
    opacity: 0.7;
  }
}

.redline-title-row {
  display: flex;
  align-items: center;
  gap: 8px;
}

.redline-title {
  font-size: 1rem;
  font-weight: 600;
  margin: 0;
  color: var(--matou-foreground);
}

.redline-meta {
  margin-top: 4px;
  font-size: 0.75rem;
  color: var(--matou-muted-foreground);
}

.redline-field-events {
  margin-top: 10px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.redline-field-event {
  padding-top: 8px;
  border-top: 1px solid var(--matou-border);

  &:first-child {
    padding-top: 0;
    border-top: none;
  }
}

.redline-field {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
  font-size: 0.85rem;
  margin-top: 4px;

  &:first-child {
    margin-top: 0;
  }
}

.field-label {
  color: var(--matou-muted-foreground);
}

.old-value {
  text-decoration: line-through;
  color: var(--matou-destructive);
  opacity: 0.75;
}

.new-value {
  color: var(--matou-accent);
  font-weight: 500;
}

.redline-contributions {
  margin-top: 10px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.redline-contribution-row {
  padding: 8px 10px;
  border-radius: var(--matou-radius-sm);
  background: var(--matou-secondary);

  &.is-added {
    background: rgba(74, 157, 156, 0.1);
  }

  &.is-removed {
    background: rgba(200, 70, 58, 0.06);
    opacity: 0.7;
  }
}

.redline-contribution-main {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  font-size: 0.82rem;
}

.contribution-title {
  color: var(--matou-foreground);
}

.redline-contribution-row.is-removed .contribution-title {
  text-decoration: line-through;
}

.redline-contribution-fields {
  margin-top: 6px;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.tag {
  font-size: 0.68rem;
  font-weight: 600;
  padding: 2px 8px;
  border-radius: 10px;
  white-space: nowrap;
  flex-shrink: 0;
}

.tag-added {
  background: rgba(74, 157, 156, 0.18);
  color: var(--matou-accent);
}

.tag-removed {
  background: rgba(200, 70, 58, 0.15);
  color: var(--matou-destructive);
}

.tag-edited {
  background: var(--matou-muted);
  color: var(--matou-muted-foreground);
}

.redline-empty {
  padding: 24px;
  text-align: center;
  color: var(--matou-muted-foreground);
  font-size: 0.9rem;
}
</style>
