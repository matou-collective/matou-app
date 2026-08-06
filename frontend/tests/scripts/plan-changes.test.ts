import { describe, it, expect } from 'vitest';
import { buildPlanChangeGroups, humanizeFieldName } from '../../src/lib/planChanges';
import type { Milestone, PlanChangeEntry } from '../../src/types/projects';

function milestone(overrides: Partial<Milestone> = {}): Milestone {
  return {
    milestone_id: 'm1',
    implementation_plan_id: 'plan1',
    title: 'Site Preparation',
    duration: '2 weeks',
    ...overrides,
  };
}

function entry(overrides: Partial<PlanChangeEntry> = {}): PlanChangeEntry {
  return {
    id: 'e1',
    kind: 'milestone_edited',
    changed_by: 'EAbc123',
    changed_at: '2026-07-20T00:00:00.000Z',
    ...overrides,
  };
}

describe('humanizeFieldName', () => {
  it('maps known snake_case fields to friendly labels', () => {
    expect(humanizeFieldName('budget_allocation')).toBe('Budget');
    expect(humanizeFieldName('start_date')).toBe('Start Date');
    expect(humanizeFieldName('estimated_duration')).toBe('Duration');
  });

  it('falls back to title-casing unknown fields', () => {
    expect(humanizeFieldName('some_new_field')).toBe('Some New Field');
  });
});

describe('buildPlanChangeGroups', () => {
  it('groups a milestone_edited entry by milestone_id and humanizes field diffs', () => {
    const milestones = [milestone()];
    const changeLog = [
      entry({
        id: 'e1',
        kind: 'milestone_edited',
        milestone_id: 'm1',
        milestone_title: 'Site Preparation',
        changes: [{ field: 'budget_allocation', old_value: '8000', new_value: '11500' }],
      }),
    ];

    const groups = buildPlanChangeGroups(milestones, changeLog);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.key).toBe('m1');
    expect(groups[0]!.title).toBe('Site Preparation');
    expect(groups[0]!.isAdded).toBe(false);
    expect(groups[0]!.isArchived).toBe(false);
    expect(groups[0]!.fieldChangeEvents).toHaveLength(1);
    expect(groups[0]!.fieldChangeEvents[0]!.changes).toEqual([
      { field: 'budget_allocation', old_value: '8000', new_value: '11500', label: 'Budget' },
    ]);
  });

  it('falls back to matching by milestone_title when milestone_id is absent', () => {
    const milestones = [milestone({ milestone_id: 'm1', title: 'Community Consultation' })];
    const changeLog = [
      entry({ kind: 'milestone_edited', milestone_title: 'Community Consultation', changes: [] }),
    ];

    const groups = buildPlanChangeGroups(milestones, changeLog);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.key).toBe('m1');
  });

  it('tags a milestone present in the active list as added', () => {
    const milestones = [milestone({ milestone_id: 'm2', title: 'Post-completion Review' })];
    const changeLog = [entry({ kind: 'milestone_added', milestone_id: 'm2', milestone_title: 'Post-completion Review' })];

    const groups = buildPlanChangeGroups(milestones, changeLog);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.isAdded).toBe(true);
    expect(groups[0]!.addedEvent?.changedBy).toBe('EAbc123');
  });

  it('synthesizes a ghost group for an archived milestone absent from the active list', () => {
    const milestones = [milestone({ milestone_id: 'm1' })];
    const changeLog = [
      entry({
        kind: 'milestone_archived',
        milestone_id: 'm-old',
        milestone_title: 'Deprecated Step',
      }),
    ];

    const groups = buildPlanChangeGroups(milestones, changeLog);
    expect(groups).toHaveLength(2);
    const ghost = groups.find((g) => g.key === 'm-old');
    expect(ghost).toBeDefined();
    expect(ghost!.isArchived).toBe(true);
    expect(ghost!.title).toBe('Deprecated Step');
    expect(ghost!.archivedEvent?.changedBy).toBe('EAbc123');
  });

  it('attaches contribution changes to their milestone group, humanizing edited-field diffs', () => {
    const milestones = [milestone({ milestone_id: 'm1' })];
    const changeLog = [
      entry({
        id: 'c1',
        kind: 'contribution_added',
        milestone_id: 'm1',
        contribution_id: 'k1',
        contribution_title: 'Coordinate hapu liaison meetings',
      }),
      entry({
        id: 'c2',
        kind: 'contribution_edited',
        milestone_id: 'm1',
        contribution_id: 'k2',
        contribution_title: 'Draft consultation flyer',
        changes: [{ field: 'deadline', old_value: '2026-08-01', new_value: '2026-08-15' }],
      }),
    ];

    const groups = buildPlanChangeGroups(milestones, changeLog);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.contributionChanges).toHaveLength(2);
    const edited = groups[0]!.contributionChanges.find((c) => c.entryId === 'c2');
    expect(edited!.changes).toEqual([
      { field: 'deadline', old_value: '2026-08-01', new_value: '2026-08-15', label: 'Deadline' },
    ]);
  });

  it('does not crash on an entry with no milestone reference, using a fallback group', () => {
    const milestones = [milestone({ milestone_id: 'm1' })];
    const changeLog = [entry({ kind: 'contribution_added', contribution_id: 'orphan', contribution_title: 'Orphan task' })];

    expect(() => buildPlanChangeGroups(milestones, changeLog)).not.toThrow();
    const groups = buildPlanChangeGroups(milestones, changeLog);
    const fallback = groups.find((g) => g.key !== 'm1');
    expect(fallback).toBeDefined();
    expect(fallback!.contributionChanges).toHaveLength(1);
    expect(fallback!.contributionChanges[0]!.title).toBe('Orphan task');
  });

  it('returns an empty array when there is no change log', () => {
    expect(buildPlanChangeGroups([milestone()], undefined)).toEqual([
      expect.objectContaining({ key: 'm1', fieldChangeEvents: [], contributionChanges: [] }),
    ]);
  });
});
