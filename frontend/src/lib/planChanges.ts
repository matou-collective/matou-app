/**
 * Pure grouping/annotation logic for the implementation-plan "Show changes"
 * redline view. Groups a plan's change_log entries by milestone (matching on
 * milestone_id, falling back to milestone_title), synthesizing ghost groups
 * for milestones archived since the last sign-off and a catch-all fallback
 * group for entries that reference no known milestone.
 */
import type { Milestone, PlanChangeEntry, PlanFieldChange } from 'src/types/projects';

const FIELD_LABELS: Record<string, string> = {
  title: 'Title',
  description: 'Description',
  duration: 'Duration',
  start_date: 'Start Date',
  end_date: 'End Date',
  budget_allocation: 'Budget',
  success_criteria: 'Success Criteria',
  status: 'Status',
  estimated_duration: 'Duration',
  deadline: 'Deadline',
  budget: 'Budget',
  assigned_contributor: 'Assigned Contributor',
};

/** Humanizes a snake_case field name, e.g. `budget_allocation` -> `Budget`. */
export function humanizeFieldName(field: string): string {
  const known = FIELD_LABELS[field];
  if (known) return known;
  return field
    .split('_')
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

export interface HumanizedFieldChange extends PlanFieldChange {
  label: string;
}

export interface FieldChangeEvent {
  entryId: string;
  changedBy: string;
  changedAt: string;
  changes: HumanizedFieldChange[];
}

export interface ContributionChangeItem {
  entryId: string;
  contributionId?: string;
  title: string;
  kind: 'contribution_added' | 'contribution_edited' | 'contribution_removed';
  changes?: HumanizedFieldChange[];
  changedBy: string;
  changedAt: string;
}

export interface PlanChangeGroup {
  /** milestone_id for real milestones, a synthetic key otherwise. */
  key: string;
  milestoneId?: string;
  title: string;
  isAdded: boolean;
  isArchived: boolean;
  addedEvent?: { changedBy: string; changedAt: string };
  archivedEvent?: { changedBy: string; changedAt: string };
  fieldChangeEvents: FieldChangeEvent[];
  contributionChanges: ContributionChangeItem[];
}

const UNASSIGNED_KEY = '__unassigned__';

function humanizeChanges(changes?: PlanFieldChange[]): HumanizedFieldChange[] {
  return (changes ?? []).map((c) => ({ ...c, label: humanizeFieldName(c.field) }));
}

/**
 * Builds one annotated group per milestone (plus ghost/fallback groups) from
 * a plan's active milestone list and its change_log. Read-only, no side effects.
 */
export function buildPlanChangeGroups(
  milestones: Milestone[],
  changeLog: PlanChangeEntry[] | undefined,
): PlanChangeGroup[] {
  const groups = new Map<string, PlanChangeGroup>();
  const order: string[] = [];

  const ensureGroup = (key: string, title: string, milestoneId: string | undefined, isArchived: boolean): PlanChangeGroup => {
    let group = groups.get(key);
    if (!group) {
      group = { key, milestoneId, title, isAdded: false, isArchived, fieldChangeEvents: [], contributionChanges: [] };
      groups.set(key, group);
      order.push(key);
    }
    return group;
  };

  for (const m of milestones) {
    ensureGroup(m.milestone_id, m.title, m.milestone_id, false);
  }

  const idByTitle = new Map<string, string>();
  for (const m of milestones) {
    if (!idByTitle.has(m.title)) idByTitle.set(m.title, m.milestone_id);
  }

  // Most recent first, so a group's activity reads newest-on-top.
  const entries = [...(changeLog ?? [])].sort(
    (a, b) => new Date(b.changed_at).getTime() - new Date(a.changed_at).getTime(),
  );

  const resolveKey = (entry: PlanChangeEntry): string => {
    if (entry.milestone_id && groups.has(entry.milestone_id)) return entry.milestone_id;
    if (entry.milestone_title && idByTitle.has(entry.milestone_title)) return idByTitle.get(entry.milestone_title)!;
    if (entry.milestone_id) return entry.milestone_id;
    if (entry.milestone_title) return `title:${entry.milestone_title}`;
    return UNASSIGNED_KEY;
  };

  for (const entry of entries) {
    const key = resolveKey(entry);
    const isKnownActiveMilestone = milestones.some((m) => m.milestone_id === key);
    const title = entry.milestone_title ?? groups.get(key)?.title ?? 'Unknown milestone';
    const group = ensureGroup(key, title, entry.milestone_id, key !== UNASSIGNED_KEY && !isKnownActiveMilestone);
    if (entry.milestone_title && !isKnownActiveMilestone) group.title = entry.milestone_title;

    switch (entry.kind) {
      case 'milestone_added':
        group.isAdded = true;
        group.addedEvent ??= { changedBy: entry.changed_by, changedAt: entry.changed_at };
        break;
      case 'milestone_archived':
        group.isArchived = true;
        group.archivedEvent = { changedBy: entry.changed_by, changedAt: entry.changed_at };
        break;
      case 'milestone_edited':
        group.fieldChangeEvents.push({
          entryId: entry.id,
          changedBy: entry.changed_by,
          changedAt: entry.changed_at,
          changes: humanizeChanges(entry.changes),
        });
        break;
      case 'contribution_added':
      case 'contribution_edited':
      case 'contribution_removed':
        group.contributionChanges.push({
          entryId: entry.id,
          contributionId: entry.contribution_id,
          title: entry.contribution_title ?? 'Untitled contribution',
          kind: entry.kind,
          changes: entry.kind === 'contribution_edited' ? humanizeChanges(entry.changes) : undefined,
          changedBy: entry.changed_by,
          changedAt: entry.changed_at,
        });
        break;
    }
  }

  return order.map((key) => groups.get(key)!);
}
