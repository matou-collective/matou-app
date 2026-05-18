# Contributions Timeline View Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a List | Timeline view-mode toggle to `/contributions` and implement the Timeline view — an Overdue card grid above a horizontally-scrolling, three-column weekly strip.

**Architecture:** Pure date helpers in `src/lib/weekRange.ts` (Vitest tested). One new shared slim card component reused by both the overdue grid and the weekly columns. A new `ContributionsTimelineView.vue` owns the timeline body and consumes the existing `contributionsStore` for live updates. `ContributionsPage.vue` adds a segmented toggle that persists to `localStorage` and swaps between the existing list body and the new timeline body.

**Tech Stack:** Vue 3 (Composition API, `<script setup lang="ts">`), Quasar UI components (`q-btn`, `q-btn-toggle`, `q-icon`, `q-tooltip`), Pinia stores already in place (`contributionsStore`, `projectsStore`, `profilesStore`), Vitest for unit tests.

**Spec:** `docs/superpowers/specs/2026-05-18-contributions-timeline-view-design.md`

---

## File Structure

| Path | Status | Responsibility |
|------|--------|----------------|
| `frontend/src/lib/weekRange.ts` | Create | Pure helpers: `startOfWeek` (Mon-start), `endOfWeek`, `addWeeks`, `sameWeek`, `weekKey`. |
| `frontend/tests/scripts/week-range.test.ts` | Create | Vitest unit tests for the helpers above. |
| `frontend/src/components/contributions/ContributionSlimCard.vue` | Create | Slim card (title, status pill, assignee avatar, project name). Used by overdue grid and timeline columns. Click opens `ContributionDetailDialog` via emit. |
| `frontend/src/pages/Contributions/ContributionsTimelineView.vue` | Create | Receives `{ contributions: Contribution[] }`. Renders overdue grid + 3-week timeline strip with prev/next nav. |
| `frontend/src/pages/Contributions/ContributionsPage.vue` | Modify | Add `viewMode: 'list' \| 'timeline'` state (persisted), segmented control, conditional render of list (existing markup) vs `<ContributionsTimelineView>`. Hide status/type filter chips when timeline. |

No backend changes. No new store methods.

---

## Task 1: Pure week-range helpers (TDD)

**Files:**
- Create: `frontend/src/lib/weekRange.ts`
- Test: `frontend/tests/scripts/week-range.test.ts`

The timeline view bucket-sorts contributions into Monday-aligned weeks and shifts a 3-week visible window. The math is small but it's easy to be off-by-one on locale/DST, so we TDD it.

- [ ] **Step 1: Write failing tests**

Create `frontend/tests/scripts/week-range.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import {
  startOfWeek,
  endOfWeek,
  addWeeks,
  sameWeek,
  weekKey,
} from '../../src/lib/weekRange';

describe('weekRange', () => {
  describe('startOfWeek', () => {
    it('returns Monday 00:00 for a Wednesday', () => {
      // Wednesday 20 May 2026
      const d = new Date(2026, 4, 20, 14, 30, 15);
      const r = startOfWeek(d);
      expect(r.getFullYear()).toBe(2026);
      expect(r.getMonth()).toBe(4);
      expect(r.getDate()).toBe(18); // Mon 18 May
      expect(r.getHours()).toBe(0);
      expect(r.getMinutes()).toBe(0);
      expect(r.getSeconds()).toBe(0);
      expect(r.getMilliseconds()).toBe(0);
    });

    it('returns the same Monday for a Monday at 00:00', () => {
      const d = new Date(2026, 4, 18, 0, 0, 0);
      const r = startOfWeek(d);
      expect(r.getDate()).toBe(18);
      expect(r.getHours()).toBe(0);
    });

    it('rolls Sunday back to the preceding Monday', () => {
      // Sunday 24 May 2026
      const d = new Date(2026, 4, 24, 23, 59);
      const r = startOfWeek(d);
      expect(r.getDate()).toBe(18); // Mon 18 May
    });

    it('crosses month boundary', () => {
      // Thursday 30 April 2026
      const d = new Date(2026, 3, 30, 12);
      const r = startOfWeek(d);
      expect(r.getMonth()).toBe(3); // April
      expect(r.getDate()).toBe(27); // Mon 27 Apr
    });
  });

  describe('endOfWeek', () => {
    it('returns Sunday 23:59:59.999 for a Wednesday', () => {
      const d = new Date(2026, 4, 20, 14, 30);
      const r = endOfWeek(d);
      expect(r.getDate()).toBe(24); // Sun 24 May
      expect(r.getHours()).toBe(23);
      expect(r.getMinutes()).toBe(59);
      expect(r.getSeconds()).toBe(59);
      expect(r.getMilliseconds()).toBe(999);
    });
  });

  describe('addWeeks', () => {
    it('adds 1 week', () => {
      const d = new Date(2026, 4, 18); // Mon 18 May
      const r = addWeeks(d, 1);
      expect(r.getDate()).toBe(25); // Mon 25 May
    });

    it('subtracts via negative input', () => {
      const d = new Date(2026, 4, 18);
      const r = addWeeks(d, -2);
      expect(r.getMonth()).toBe(4);
      expect(r.getDate()).toBe(4); // Mon 4 May
    });

    it('does not mutate the input', () => {
      const d = new Date(2026, 4, 18);
      addWeeks(d, 5);
      expect(d.getDate()).toBe(18);
    });
  });

  describe('sameWeek', () => {
    it('returns true for two dates in the same Mon-Sun week', () => {
      const a = new Date(2026, 4, 19, 9); // Tue
      const b = new Date(2026, 4, 24, 23); // Sun
      expect(sameWeek(a, b)).toBe(true);
    });

    it('returns false for dates one day apart but in different weeks', () => {
      const a = new Date(2026, 4, 24, 23); // Sun
      const b = new Date(2026, 4, 25, 0);  // Mon
      expect(sameWeek(a, b)).toBe(false);
    });
  });

  describe('weekKey', () => {
    it('returns YYYY-MM-DD of the Monday', () => {
      const d = new Date(2026, 4, 22); // Fri
      expect(weekKey(d)).toBe('2026-05-18');
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd frontend && npm run test:script -- week-range
```

Expected: All tests FAIL with module-not-found errors.

- [ ] **Step 3: Write the helpers**

Create `frontend/src/lib/weekRange.ts`:

```ts
// Week boundaries follow Mon-start (NZ/most-of-world). All functions
// operate on local time so they line up with what the user sees in their
// browser's locale formatting.

/** Returns a new Date at the Monday 00:00:00.000 of the input's week. */
export function startOfWeek(d: Date): Date {
  const r = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0, 0);
  // getDay(): 0=Sun, 1=Mon, ..., 6=Sat. Mon-start means shift by (getDay+6)%7.
  const dayOffset = (r.getDay() + 6) % 7;
  r.setDate(r.getDate() - dayOffset);
  return r;
}

/** Returns a new Date at the Sunday 23:59:59.999 of the input's week. */
export function endOfWeek(d: Date): Date {
  const start = startOfWeek(d);
  const r = new Date(start);
  r.setDate(r.getDate() + 6);
  r.setHours(23, 59, 59, 999);
  return r;
}

/** Returns a new Date n weeks after d (n may be negative). Does not mutate d. */
export function addWeeks(d: Date, n: number): Date {
  const r = new Date(d);
  r.setDate(r.getDate() + n * 7);
  return r;
}

/** True iff both dates fall in the same Mon-Sun week. */
export function sameWeek(a: Date, b: Date): boolean {
  return startOfWeek(a).getTime() === startOfWeek(b).getTime();
}

/** Stable string key for the week that contains d. Format: YYYY-MM-DD of the Monday. */
export function weekKey(d: Date): string {
  const s = startOfWeek(d);
  const yyyy = s.getFullYear();
  const mm = String(s.getMonth() + 1).padStart(2, '0');
  const dd = String(s.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd frontend && npm run test:script -- week-range
```

Expected: All 11 tests pass.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/lib/weekRange.ts frontend/tests/scripts/week-range.test.ts
git commit -m "feat(contributions): week-range helpers for timeline view"
```

---

## Task 2: ContributionSlimCard component

**Files:**
- Create: `frontend/src/components/contributions/ContributionSlimCard.vue`

Slim card — title (1-line), status pill, assignee avatar, project name. Optional `showOverdueLine` prop adds the red `Due dd/mm/yyyy · overdue` row for the overdue grid.

- [ ] **Step 1: Create the component**

Create `frontend/src/components/contributions/ContributionSlimCard.vue`:

```vue
<template>
  <div class="slim-card" :class="{ 'slim-card--overdue': showOverdueLine }" @click="$emit('click')">
    <div class="slim-card-row top">
      <span class="slim-card-title">{{ contribution.title }}</span>
      <ContributionStatusBadge :status="contribution.status" />
      <div v-if="assignedAid" class="slim-card-avatar">
        <q-tooltip>Assigned to {{ assignedName }}</q-tooltip>
        <img v-if="assignedAvatar" :src="assignedAvatar" class="slim-card-avatar-img" />
        <span v-else class="slim-card-avatar-initials">{{ assignedInitials }}</span>
      </div>
    </div>
    <div v-if="projectName" class="slim-card-project">{{ projectName }}</div>
    <div v-if="showOverdueLine && contribution.deadline" class="slim-card-overdue-line">
      <q-icon name="warning" size="14px" />
      Due {{ formatDate(contribution.deadline) }} · overdue
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import type { Contribution } from 'src/lib/api/contributions';
import { useProfilesStore } from 'stores/profiles';
import { useProjectsStore } from 'stores/projects';
import { getFileUrl } from 'src/lib/api/client';
import { formatDate } from 'src/lib/formatDate';
import ContributionStatusBadge from './ContributionStatusBadge.vue';

interface Props {
  contribution: Contribution;
  showOverdueLine?: boolean;
}

const props = withDefaults(defineProps<Props>(), {
  showOverdueLine: false,
});

defineEmits<{ (e: 'click'): void }>();

const profilesStore = useProfilesStore();
const projectsStore = useProjectsStore();

const assignedAid = computed(() => {
  const c = props.contribution as typeof props.contribution & { assigned_contributor?: string };
  return c.assigned_contributor_id ?? c.assigned_contributor ?? null;
});

const assignedProfile = computed(() =>
  assignedAid.value ? profilesStore.profilesByAid[assignedAid.value] : null,
);

const assignedName = computed(() => {
  if (!assignedAid.value) return null;
  const c = props.contribution as typeof props.contribution & { assigned_contributor_name?: string };
  return (
    assignedProfile.value?.displayName
    ?? c.assigned_contributor_name
    ?? assignedAid.value.slice(0, 12) + '...'
  );
});

const assignedAvatar = computed(() => {
  const avatar = assignedProfile.value?.avatar;
  if (!avatar) return null;
  return avatar.startsWith('http') ? avatar : getFileUrl(avatar);
});

const assignedInitials = computed(() => {
  const name = assignedName.value;
  if (!name) return '?';
  return name.split(' ').map(w => w[0]).slice(0, 2).join('').toUpperCase();
});

const projectName = computed(() => {
  if (!props.contribution.project_id) return '';
  const p = projectsStore.projects.find((x) => x.id === props.contribution.project_id);
  return p?.title ?? '';
});
</script>

<style scoped lang="scss">
.slim-card {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 10px 12px;
  background: var(--matou-card);
  border: 1px solid var(--matou-border);
  border-radius: var(--matou-radius-sm);
  cursor: pointer;
  transition: border-color 0.12s ease, box-shadow 0.12s ease;

  &:hover {
    border-color: var(--matou-accent);
    box-shadow: 0 1px 6px rgba(0, 0, 0, 0.05);
  }

  &--overdue {
    border-color: var(--matou-destructive, #dc2626);
  }
}

.slim-card-row.top {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.slim-card-title {
  flex: 1;
  font-size: 0.9rem;
  font-weight: 500;
  color: var(--matou-foreground);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  min-width: 0;
}

.slim-card-avatar {
  width: 24px;
  height: 24px;
  border-radius: 50%;
  overflow: hidden;
  flex-shrink: 0;
  background: var(--matou-primary);
  display: flex;
  align-items: center;
  justify-content: center;
}

.slim-card-avatar-img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.slim-card-avatar-initials {
  font-size: 0.65rem;
  font-weight: 600;
  color: white;
}

.slim-card-project {
  font-size: 0.75rem;
  color: var(--matou-muted-foreground);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.slim-card-overdue-line {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: 0.75rem;
  color: var(--matou-destructive, #dc2626);
}
</style>
```

- [ ] **Step 2: Type-check**

```bash
cd frontend && npx vue-tsc --noEmit 2>&1 | grep "error TS" | wc -l
```

Expected: 22 (the pre-existing baseline). If higher, fix the new errors before continuing.

- [ ] **Step 3: Commit**

```bash
git add frontend/src/components/contributions/ContributionSlimCard.vue
git commit -m "feat(contributions): slim card component for timeline view"
```

---

## Task 3: ContributionsTimelineView component

**Files:**
- Create: `frontend/src/pages/Contributions/ContributionsTimelineView.vue`

Owns the timeline body. Receives `contributions: Contribution[]` (already filtered by Mine/All upstream) and renders:

1. Overdue grid (collapsed by default when N > 6).
2. Header row with three week labels + prev/next buttons.
3. Three columns of slim cards.

Emits `view-contribution` when a card is clicked.

- [ ] **Step 1: Create the component**

Create `frontend/src/pages/Contributions/ContributionsTimelineView.vue`:

```vue
<template>
  <div class="timeline-view">
    <!-- Empty state -->
    <div v-if="!hasAnyDeadlines && overdue.length === 0" class="timeline-empty">
      No timeline yet — add due dates to your contributions to see them here.
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

const onTimelineContributions = computed(() =>
  props.contributions.filter((c) => {
    if (!c.deadline) return false;
    if (COMPLETED_STATUSES.has(c.status)) return false;
    // Overdue contributions live in the overdue section, not the strip.
    return new Date(c.deadline).getTime() >= startOfToday().getTime();
  }),
);

const hasAnyDeadlines = computed(() => onTimelineContributions.value.length > 0);

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
```

- [ ] **Step 2: Type-check**

```bash
cd frontend && npx vue-tsc --noEmit 2>&1 | grep "error TS" | wc -l
```

Expected: 22 (the pre-existing baseline). If higher, fix the new errors.

- [ ] **Step 3: Commit**

```bash
git add frontend/src/pages/Contributions/ContributionsTimelineView.vue
git commit -m "feat(contributions): timeline view body (overdue + weekly strip)"
```

---

## Task 4: View-mode toggle on ContributionsPage

**Files:**
- Modify: `frontend/src/pages/Contributions/ContributionsPage.vue`

Add the segmented `List | Timeline` control between the page header and the filter chips. Persist to `localStorage`. Hide status/type filter rows when viewing the timeline (timeline derives content purely from deadlines).

- [ ] **Step 1: Inspect the current template to find the insertion points**

```bash
grep -n "filter-row\|filteredContributions\|myContributions\|<template>\|viewMode" frontend/src/pages/Contributions/ContributionsPage.vue | head -20
```

Note the line numbers for: where status/type filter rows live, where the list `<div v-for="contribution in filteredContributions">` lives, and where to slot the new toggle.

- [ ] **Step 2: Add view-mode state + persistence**

In the `<script setup>` block, near the other `ref`s (e.g. just below the `activeStatusFilter` / `activeTypeFilter` declarations), add:

```ts
const VIEW_MODE_STORAGE_KEY = 'matou:contributions:view';
const viewMode = ref<'list' | 'timeline'>(
  (localStorage.getItem(VIEW_MODE_STORAGE_KEY) as 'list' | 'timeline') ?? 'list',
);

watch(viewMode, (v) => {
  localStorage.setItem(VIEW_MODE_STORAGE_KEY, v);
});
```

If `watch` isn't already imported from vue, add it to the existing `import { ref, computed, onMounted } from 'vue';` line.

Add the timeline component import near the other component imports:

```ts
import ContributionsTimelineView from 'src/pages/Contributions/ContributionsTimelineView.vue';
```

- [ ] **Step 3: Wire the click-card handler for the timeline**

Find the existing click handler that opens the detail page from a card click on the list (typically `router.push({ name: 'contribution-detail', params: { id: ... } })`). Add a small function that the timeline emits to:

```ts
function handleViewContribution(c: Contribution) {
  void router.push({ name: 'contribution-detail', params: { id: c.id } });
}
```

(If `router` is already imported and used elsewhere on the page, reuse it. If `Contribution` type isn't already imported from `src/lib/api/contributions`, add it.)

- [ ] **Step 4: Add the segmented control + conditional render in the template**

Right after the Mine/All section header / above the filter pills, insert the view toggle. Wrap the existing filter rows + list with `v-if="viewMode === 'list'"`. Add the timeline body for `v-else-if="viewMode === 'timeline'"`.

The exact insertion depends on the current markup, but the shape is:

```vue
<div class="view-mode-row">
  <q-btn-toggle
    v-model="viewMode"
    no-caps
    spread
    toggle-color="primary"
    color="white"
    text-color="primary"
    :options="[
      { label: 'List', value: 'list', icon: 'view_list' },
      { label: 'Timeline', value: 'timeline', icon: 'view_timeline' },
    ]"
    class="view-mode-toggle"
  />
</div>

<template v-if="viewMode === 'list'">
  <!-- existing filter pills + filteredContributions grid stay here unchanged -->
</template>
<template v-else>
  <ContributionsTimelineView
    :contributions="filteredContributions"
    @view-contribution="handleViewContribution"
  />
</template>
```

Note: pass `filteredContributions` (which already has Mine/All applied + sorting) so the timeline inherits the user's selection. Status/type filters are List-only by design; the timeline derives from the full set under the active Mine/All scope.

Wait — re-read this. The current `filteredContributions` *also* applies status/type filters. We want the timeline to ignore those. Define a separate computed:

```ts
const timelineContributions = computed(() => {
  // Same Mine/All scoping as the list, but no status/type filters.
  return activeAudience.value === 'mine'
    ? myContributions.value
    : store.contributions.filter((c) => c.status !== 'archived');
});
```

…and pass `:contributions="timelineContributions"` to `<ContributionsTimelineView>`. Adjust to match the existing variable names you find on the page — `activeAudience`/`myContributions`/`store.contributions` are illustrative.

- [ ] **Step 5: Add minimal styling**

In the `<style>` block of `ContributionsPage.vue`, add:

```scss
.view-mode-row {
  display: flex;
  justify-content: flex-start;
  margin: 0 0 16px;
}

.view-mode-toggle {
  border: 1px solid var(--matou-border);
  border-radius: 8px;
  overflow: hidden;
}
```

- [ ] **Step 6: Type-check**

```bash
cd frontend && npx vue-tsc --noEmit 2>&1 | grep "error TS" | wc -l
```

Expected: 22 (baseline). Fix any new errors.

- [ ] **Step 7: Commit**

```bash
git add frontend/src/pages/Contributions/ContributionsPage.vue
git commit -m "feat(contributions): list/timeline view toggle on contributions page"
```

---

## Task 5: Manual verification + final commit

**Files:** none modified — verification only.

- [ ] **Step 1: Confirm dev sessions are running**

```bash
cd frontend && npm run dev:sessions:status
```

If not running:

```bash
npm run dev:sessions:stop
for port in 4000 4001 4002 5100 5101 5102; do lsof -ti :$port 2>/dev/null | xargs -r kill -9 2>/dev/null; done
npm run dev:sessions:3
```

- [ ] **Step 2: Verify in browser**

Open `http://localhost:5100/contributions`. Walk through:

- The `List | Timeline` toggle is visible above the filter chips.
- Default state is List (same as today). Click `Timeline` — the body swaps. Reload the page — toggle stays on Timeline.
- In Timeline view: status/type filter chips are hidden; Mine/All section still controls scope.
- Overdue section appears at the top with cards in a 3-per-row grid (resize the window to 800px — should collapse to 2 per row, 600px → 1 per row).
- If overdue count > 6 → collapsed by default, `Show` button reveals.
- The three weekly columns show; the current week's column has a primary border and a `Today` chip in its header.
- Each card shows title, status pill, project name, and (when assigned) the assignee avatar with tooltip.
- Click a card → routes to the standalone contribution detail page.
- `Prev` and `Next` shift the visible window by one week. `Prev` disables when at earliest week; `Next` disables when at latest week.
- Toggle back to List — filter chips + list reappear, state unchanged.

- [ ] **Step 3: Cross-session live update check**

In session 1 (`localhost:5100`), open the Contributions page and switch to Timeline. In session 2 (`localhost:5101`), as a project lead post a comment on a contribution that's in scope for session 1's user. Confirm:

- The contribution's slim card in session 1 doesn't visually change (slim card has no unread badge — by design).
- The contribution still appears in the correct week.

Then in session 2, change a contribution's deadline. Confirm session 1's timeline re-buckets the card into the new week within a few seconds (driven by the existing `contribution_updated` SSE → `contributionsStore.refreshContribution` pipeline).

- [ ] **Step 4: Done**

No commit needed — the prior tasks each committed their slice. Plan is complete.

---

## Self-Review

- **Spec coverage:** Walked the spec section-by-section:
  - Placement & toggle → Task 4.
  - Mine/All semantics → reuses existing computed in `ContributionsPage`.
  - Overdue section (definition, layout, collapse > 6) → Task 3 template + script.
  - Weekly columns + Mon-Sun + Prev/Next bounds → Task 3 (`windowStart`, `canPrev`, `canNext`).
  - Slim card content → Task 2.
  - Live updates via SSE → no new code (existing `DashboardLayout` watcher + `refreshContribution` carry the load).
  - File layout matches spec.
  - Empty state when no deadlines → Task 3 `timeline-empty`.
- **Placeholder scan:** No "TBD" / "implement later" / vague references. Code blocks present in every code step. The only soft notes are "adjust to match the existing variable names you find on the page" in Task 4 Step 4 — that's necessary because the existing `ContributionsPage.vue` is mid-refactor (Mine vs filteredContributions), so the engineer needs to read the local symbols. The instruction is explicit about what to define.
- **Type consistency:** `Contribution` from `src/lib/api/contributions` used throughout. `startOfWeek`/`endOfWeek`/`addWeeks`/`sameWeek`/`weekKey` defined in Task 1 and consumed in Task 3 with matching signatures. `ContributionSlimCard` props (`contribution`, `showOverdueLine`) match between Task 2 (definition) and Task 3 (usage).
