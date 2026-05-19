<template>
  <div class="timeline-view">
    <!-- Empty state -->
    <div v-if="!hasAnyDeadlines && overdue.length === 0 && tbc.length === 0" class="timeline-empty">
      No contributions to show — try a different filter, or add due dates so they appear on the timeline.
    </div>

    <template v-else>
      <!-- Overdue section -->
      <section v-if="overdue.length > 0" class="overdue-section">
        <div class="overdue-header">
          <h3 class="overdue-title">
            <q-icon name="warning" size="20px" />
            Overdue ({{ overdue.length }})
          </h3>
          <button
            v-if="overdue.length > 6"
            type="button"
            class="overdue-toggle"
            @click="overdueExpanded = !overdueExpanded"
          >
            {{ overdueExpanded ? 'Hide' : 'Show' }}
          </button>
        </div>
        <div v-if="overdueExpanded || overdue.length <= 6" class="overdue-grid">
          <ContributionSlimCard
            v-for="c in overdue"
            :key="c.id"
            :contribution="c"
            :show-overdue-line="true"
            @click="$emit('view-contribution', c)"
          />
        </div>
      </section>

      <!-- Timeline strip -->
      <section v-if="hasAnyDeadlines" class="strip-section">
        <div class="strip-nav">
          <q-btn
            flat
            dense
            icon="chevron_left"
            label="Prev"
            no-caps
            :disable="!canPrev"
            @click="shiftWeek(-1)"
          />
          <div class="strip-week-headers">
            <div
              v-for="week in visibleWeeks"
              :key="week.key"
              class="strip-week-header"
              :class="{ 'strip-week-header--today': week.containsToday }"
            >
              <div class="strip-week-range">
                {{ formatWeekRange(week.start) }}
              </div>
              <span v-if="week.containsToday" class="strip-today-chip">Today</span>
            </div>
          </div>
          <q-btn
            flat
            dense
            icon-right="chevron_right"
            label="Next"
            no-caps
            :disable="!canNext"
            @click="shiftWeek(1)"
          />
        </div>

        <div class="strip-columns">
          <div
            v-for="week in visibleWeeks"
            :key="week.key"
            class="strip-column"
            :class="{ 'strip-column--today': week.containsToday }"
          >
            <template v-if="(bucketed.get(week.key) ?? []).length > 0">
              <ContributionSlimCard
                v-for="c in bucketed.get(week.key)"
                :key="c.id"
                :contribution="c"
                @click="$emit('view-contribution', c)"
              />
            </template>
            <div v-else class="strip-column-empty">—</div>
          </div>
        </div>
      </section>

      <!-- Due Date TBC section -->
      <section v-if="tbc.length > 0" class="tbc-section">
        <div class="tbc-header">
          <h3 class="tbc-title">
            <q-icon name="event_busy" size="20px" />
            Due Date TBC ({{ tbc.length }})
          </h3>
          <button
            v-if="tbc.length > 6"
            type="button"
            class="tbc-toggle"
            @click="tbcExpanded = !tbcExpanded"
          >
            {{ tbcExpanded ? 'Hide' : 'Show' }}
          </button>
        </div>
        <div v-if="tbcExpanded || tbc.length <= 6" class="tbc-grid">
          <ContributionSlimCard
            v-for="c in tbc"
            :key="c.id"
            :contribution="c"
            @click="$emit('view-contribution', c)"
          />
        </div>
      </section>
    </template>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue';
import type { Contribution } from 'src/lib/api/contributions';
import { startOfWeek, addWeeks, weekKey, sameWeek } from 'src/lib/weekRange';
import ContributionSlimCard from 'src/components/contributions/ContributionSlimCard.vue';

interface Props {
  contributions: Contribution[];
}

const props = defineProps<Props>();

defineEmits<{ (e: 'view-contribution', c: Contribution): void }>();

const overdueExpanded = ref(false);
const tbcExpanded = ref(false);

const COMPLETED_STATUSES = new Set([
  'signed_off',
  'rewarded',
  'completed',
  'archived',
]);

const startOfToday = (): Date => {
  const t = new Date();
  return new Date(t.getFullYear(), t.getMonth(), t.getDate(), 0, 0, 0, 0);
};

// Overdue = active work with a past deadline. Signed-off / rewarded /
// archived items aren't "overdue" even if their deadline has passed, so
// keep the status filter here.
const overdue = computed(() => {
  const today = startOfToday().getTime();
  return [...props.contributions]
    .filter((c) => {
      if (!c.deadline) return false;
      if (COMPLETED_STATUSES.has(c.status)) return false;
      return new Date(c.deadline).getTime() < today;
    })
    .sort((a, b) => new Date(a.deadline!).getTime() - new Date(b.deadline!).getTime());
});

// Strip: trust the parent's scope filter. The only thing we route out is
// active past-deadline items, which land in the Overdue section above.
// Past-deadline completed items (signed-off etc.) keep their natural week
// position so the user can scroll Prev to see them.
const onTimelineContributions = computed(() =>
  props.contributions.filter((c) => {
    if (!c.deadline) return false;
    const past = new Date(c.deadline).getTime() < startOfToday().getTime();
    const stillActive = !COMPLETED_STATUSES.has(c.status);
    if (past && stillActive) return false;
    return true;
  }),
);

const hasAnyDeadlines = computed(() => onTimelineContributions.value.length > 0);

// Due Date TBC = contributions matching the active filter that have no
// deadline. Trust the parent's scope filter for status — if the user picked
// "Archived" or "Signed Off", they should land here too.
const tbc = computed(() =>
  [...props.contributions]
    .filter((c) => !c.deadline)
    .sort((a, b) => {
      const ca = a.created_at ? new Date(a.created_at).getTime() : 0;
      const cb = b.created_at ? new Date(b.created_at).getTime() : 0;
      return ca - cb;
    }),
);

const bucketed = computed(() => {
  const map = new Map<string, Contribution[]>();
  for (const c of onTimelineContributions.value) {
    const key = weekKey(new Date(c.deadline!));
    const list = map.get(key) ?? [];
    list.push(c);
    map.set(key, list);
  }
  for (const [, list] of map) {
    list.sort((a, b) => new Date(a.deadline!).getTime() - new Date(b.deadline!).getTime());
  }
  return map;
});

const earliestWeek = computed(() => {
  let earliest = startOfWeek(new Date());
  for (const c of props.contributions) {
    if (!c.deadline) continue;
    const w = startOfWeek(new Date(c.deadline));
    if (w.getTime() < earliest.getTime()) earliest = w;
  }
  return earliest;
});

const latestWeek = computed(() => {
  let latest = startOfWeek(new Date());
  for (const c of props.contributions) {
    if (!c.deadline) continue;
    const w = startOfWeek(new Date(c.deadline));
    if (w.getTime() > latest.getTime()) latest = w;
  }
  return latest;
});

const windowStart = ref<Date>(startOfWeek(new Date()));

const visibleWeeks = computed(() => {
  const today = new Date();
  return [0, 1, 2].map((offset) => {
    const start = addWeeks(windowStart.value, offset);
    return {
      start,
      key: weekKey(start),
      containsToday: sameWeek(start, today),
    };
  });
});

const canPrev = computed(() => windowStart.value.getTime() > earliestWeek.value.getTime());
const canNext = computed(() => windowStart.value.getTime() < latestWeek.value.getTime());

function shiftWeek(n: number) {
  windowStart.value = addWeeks(windowStart.value, n);
}

function formatWeekRange(start: Date): string {
  const end = addWeeks(start, 1);
  end.setDate(end.getDate() - 1);
  const fmt = new Intl.DateTimeFormat(undefined, { day: '2-digit', month: 'short' });
  return `${fmt.format(start)} – ${fmt.format(end)}`;
}
</script>

<style scoped lang="scss">
.timeline-view {
  display: flex;
  flex-direction: column;
  gap: 24px;
}

.timeline-empty {
  padding: 40px 20px;
  text-align: center;
  color: var(--matou-muted-foreground);
}

.overdue-section {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.overdue-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.overdue-title {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 1rem;
  font-weight: 600;
  color: var(--matou-destructive, #dc2626);
  margin: 0;
}

.overdue-toggle {
  background: transparent;
  border: 1px solid var(--matou-border);
  border-radius: 999px;
  padding: 4px 12px;
  font-size: 0.8rem;
  color: var(--matou-foreground);
  cursor: pointer;

  &:hover {
    border-color: var(--matou-accent);
  }
}

.overdue-grid {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 12px;

  @media (max-width: 999px) {
    grid-template-columns: repeat(2, 1fr);
  }
  @media (max-width: 639px) {
    grid-template-columns: 1fr;
  }
}

.tbc-section {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.tbc-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.tbc-title {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 1rem;
  font-weight: 600;
  color: var(--matou-muted-foreground);
  margin: 0;
}

.tbc-toggle {
  background: transparent;
  border: 1px solid var(--matou-border);
  border-radius: 999px;
  padding: 4px 12px;
  font-size: 0.8rem;
  color: var(--matou-foreground);
  cursor: pointer;

  &:hover {
    border-color: var(--matou-accent);
  }
}

.tbc-grid {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 12px;

  @media (max-width: 999px) {
    grid-template-columns: repeat(2, 1fr);
  }
  @media (max-width: 639px) {
    grid-template-columns: 1fr;
  }
}

.strip-section {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.strip-nav {
  display: flex;
  align-items: center;
  gap: 8px;
}

.strip-week-headers {
  flex: 1;
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 12px;
}

.strip-week-header {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 4px;
  padding: 6px 10px;
  border-bottom: 2px solid var(--matou-border);

  &--today {
    border-bottom-color: var(--matou-primary);
  }
}

.strip-week-range {
  font-size: 0.85rem;
  font-weight: 600;
  color: var(--matou-foreground);
}

.strip-today-chip {
  font-size: 0.65rem;
  font-weight: 600;
  padding: 2px 8px;
  border-radius: 999px;
  background: rgba(30, 95, 116, 0.12);
  color: var(--matou-primary, #1e5f74);
  text-transform: uppercase;
  letter-spacing: 0.05em;
}

.strip-columns {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 12px;
}

.strip-column {
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-height: 120px;
  padding: 8px;
  background: var(--matou-muted, #f3f4f6);
  border-radius: var(--matou-radius-sm);

  &--today {
    border: 1px solid var(--matou-primary);
    background: rgba(30, 95, 116, 0.04);
  }
}

.strip-column-empty {
  color: var(--matou-muted-foreground);
  text-align: center;
  padding: 24px 0;
  font-size: 1.1rem;
}
</style>
