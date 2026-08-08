import { describe, it, expect } from 'vitest';
import {
  filterMyProjects,
  filterAllProjects,
  sortByCreatedDesc,
} from '../../src/lib/projectsView';
import type { Project } from '../../src/lib/api/projects';

function make(overrides: Partial<Project> & { id: string }): Project {
  return {
    id: overrides.id,
    title: overrides.title ?? 'Title',
    description: 'Description',
    status: 'active',
    created_by: 'someone',
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    ...overrides,
  } as Project;
}

const list: Project[] = [
  make({ id: 'created', status: 'created' }),
  make({ id: 'active', status: 'active' }),
  make({ id: 'pending', status: 'pending_completion' }),
  make({ id: 'completed', status: 'completed' }),
  make({ id: 'archived', status: 'archived' }),
];

describe('filterMyProjects', () => {
  it('default "active" view hides completed and archived', () => {
    const r = filterMyProjects(list, 'active');
    expect(r.map((p) => p.id)).toEqual(['created', 'active', 'pending']);
  });

  it('"completed" view shows only completed', () => {
    const r = filterMyProjects(list, 'completed');
    expect(r.map((p) => p.id)).toEqual(['completed']);
  });

  it('"archived" view shows only archived', () => {
    const r = filterMyProjects(list, 'archived');
    expect(r.map((p) => p.id)).toEqual(['archived']);
  });

  it('does not mutate the input list', () => {
    const copy = [...list];
    filterMyProjects(list, 'active');
    expect(list).toEqual(copy);
  });
});

describe('filterAllProjects', () => {
  it('"all" hides completed but keeps every other status (including archived)', () => {
    const r = filterAllProjects(list, 'all');
    expect(r.map((p) => p.id)).toEqual(['created', 'active', 'pending', 'archived']);
  });

  it('"completed" reveals completed projects', () => {
    const r = filterAllProjects(list, 'completed');
    expect(r.map((p) => p.id)).toEqual(['completed']);
  });

  it('an exact-status filter matches that status', () => {
    expect(filterAllProjects(list, 'active').map((p) => p.id)).toEqual(['active']);
    expect(filterAllProjects(list, 'created').map((p) => p.id)).toEqual(['created']);
    expect(filterAllProjects(list, 'archived').map((p) => p.id)).toEqual(['archived']);
  });
});

describe('sortByCreatedDesc', () => {
  it('orders newest first without mutating the input', () => {
    const unsorted = [
      make({ id: 'old', created_at: '2026-01-01T00:00:00Z' }),
      make({ id: 'new', created_at: '2026-03-01T00:00:00Z' }),
      make({ id: 'mid', created_at: '2026-02-01T00:00:00Z' }),
    ];
    const copy = [...unsorted];
    const r = sortByCreatedDesc(unsorted);
    expect(r.map((p) => p.id)).toEqual(['new', 'mid', 'old']);
    expect(unsorted).toEqual(copy);
  });
});
