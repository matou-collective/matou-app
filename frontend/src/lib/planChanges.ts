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
  /**
   * 'contribution_context' rows are synthesized parents: a sub-contribution
   * changed but its parent has no changes of its own, so the parent renders
   * as a plain container row with no change tag or meta.
   */
  kind: 'contribution_added' | 'contribution_edited' | 'contribution_removed' | 'contribution_context';
  changes?: HumanizedFieldChange[];
  changedBy: string;
  changedAt: string;
  parentContributionId?: string;
  parentContributionTitle?: string;
  /** Sub-contribution changes nested under this contribution's row. */
  children: ContributionChangeItem[];
}

/**
 * Minimal contribution shape used to resolve change-log entries that predate
 * parent/milestone stamping: legacy sub-contribution entries carry only a
 * contribution_id, so the milestone is found by walking the parent chain.
 */
export interface ContributionRef {
  id: string;
  title?: string;
  milestone_id?: string;
  parent_contribution?: string;
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

interface ResolvedEntryRefs {
  milestoneId?: string;
  milestoneTitle?: string;
  parentId?: string;
  parentTitle?: string;
}

/**
 * Resolves the milestone/parent refs for a change entry, preferring what the
 * entry itself carries and falling back to walking the contributions list's
 * parent chain for legacy entries that predate ref stamping.
 */
function resolveEntryRefs(
  entry: PlanChangeEntry,
  byId: Map<string, ContributionRef>,
): ResolvedEntryRefs {
  const refs: ResolvedEntryRefs = {
    ...(entry.milestone_id ? { milestoneId: entry.milestone_id } : {}),
    ...(entry.milestone_title ? { milestoneTitle: entry.milestone_title } : {}),
    ...(entry.parent_contribution_id ? { parentId: entry.parent_contribution_id } : {}),
    ...(entry.parent_contribution_title ? { parentTitle: entry.parent_contribution_title } : {}),
  };

  const contribution = entry.contribution_id ? byId.get(entry.contribution_id) : undefined;
  if (!refs.parentId && contribution?.parent_contribution) {
    refs.parentId = contribution.parent_contribution;
  }
  if (refs.parentId && !refs.parentTitle) {
    const parent = byId.get(refs.parentId);
    if (parent?.title) refs.parentTitle = parent.title;
  }
  if (!refs.milestoneId && contribution) {
    let cursor: ContributionRef | undefined = contribution;
    for (let hops = 0; cursor && !cursor.milestone_id && cursor.parent_contribution && hops < 10; hops++) {
      cursor = byId.get(cursor.parent_contribution);
    }
    if (cursor?.milestone_id) refs.milestoneId = cursor.milestone_id;
  }
  return refs;
}

/**
 * Turns a group's flat contribution-change list into a tree: sub-contribution
 * changes nest under their parent contribution's row, synthesizing a plain
 * 'contribution_context' row when the parent has no changes of its own.
 */
function nestContributionChanges(items: ContributionChangeItem[]): ContributionChangeItem[] {
  const roots: ContributionChangeItem[] = [];
  const rowByContribution = new Map<string, ContributionChangeItem>();
  for (const item of items) {
    if (item.contributionId && !rowByContribution.has(item.contributionId)) {
      rowByContribution.set(item.contributionId, item);
    }
  }
  for (const item of items) {
    if (!item.parentContributionId) {
      roots.push(item);
      continue;
    }
    let parentRow = rowByContribution.get(item.parentContributionId);
    if (parentRow === item) parentRow = undefined; // self-reference guard
    if (!parentRow) {
      parentRow = {
        entryId: `ctx:${item.parentContributionId}`,
        contributionId: item.parentContributionId,
        title: item.parentContributionTitle ?? 'Parent contribution',
        kind: 'contribution_context',
        changedBy: '',
        changedAt: '',
        children: [],
      };
      rowByContribution.set(item.parentContributionId, parentRow);
      roots.push(parentRow);
    }
    parentRow.children.push(item);
  }
  // A nested parent row may itself have been removed from roots' candidates —
  // keep only rows that aren't someone else's child.
  const nested = new Set<ContributionChangeItem>();
  for (const row of rowByContribution.values()) {
    for (const child of row.children) nested.add(child);
  }
  return roots.filter((r) => !nested.has(r));
}

/**
 * Builds one annotated group per milestone (plus ghost/fallback groups) from
 * a plan's active milestone list and its change_log. `contributions`, when
 * provided, lets legacy entries without milestone/parent refs resolve their
 * milestone via the parent chain. Read-only, no side effects.
 */
export function buildPlanChangeGroups(
  milestones: Milestone[],
  changeLog: PlanChangeEntry[] | undefined,
  contributions?: ContributionRef[],
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

  const byId = new Map<string, ContributionRef>();
  for (const c of contributions ?? []) byId.set(c.id, c);

  // Most recent first, so a group's activity reads newest-on-top.
  const entries = [...(changeLog ?? [])].sort(
    (a, b) => new Date(b.changed_at).getTime() - new Date(a.changed_at).getTime(),
  );

  const resolveKey = (refs: ResolvedEntryRefs): string => {
    if (refs.milestoneId && groups.has(refs.milestoneId)) return refs.milestoneId;
    if (refs.milestoneTitle && idByTitle.has(refs.milestoneTitle)) return idByTitle.get(refs.milestoneTitle)!;
    if (refs.milestoneId) return refs.milestoneId;
    if (refs.milestoneTitle) return `title:${refs.milestoneTitle}`;
    return UNASSIGNED_KEY;
  };

  for (const entry of entries) {
    const refs = resolveEntryRefs(entry, byId);
    const key = resolveKey(refs);
    const isKnownActiveMilestone = milestones.some((m) => m.milestone_id === key);
    const title = refs.milestoneTitle ?? groups.get(key)?.title ?? 'Unknown milestone';
    const group = ensureGroup(key, title, refs.milestoneId, key !== UNASSIGNED_KEY && !isKnownActiveMilestone);
    if (refs.milestoneTitle && !isKnownActiveMilestone) group.title = refs.milestoneTitle;

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
          ...(refs.parentId ? { parentContributionId: refs.parentId } : {}),
          ...(refs.parentTitle ? { parentContributionTitle: refs.parentTitle } : {}),
          children: [],
        });
        break;
    }
  }

  for (const group of groups.values()) {
    group.contributionChanges = nestContributionChanges(group.contributionChanges);
  }

  return order.map((key) => groups.get(key)!);
}
