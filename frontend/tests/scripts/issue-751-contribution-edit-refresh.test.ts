// @vitest-environment happy-dom
/**
 * #751 — Editing a sub-contribution (or contribution) inside an implementation
 * plan did not update the UI until the user navigated away and back.
 *
 * Symptom 1 (page handler): onContributionSave refetched ONLY the implementation
 * plan. Sub-contributions are not hydrated into plan milestones — the detail
 * dialog's sub-list resolves child ids against the flat project-contributions
 * list — so the edited sub kept its old values until loadProject() (route
 * re-enter) refetched that flat list too. The fix routes save AND archive through
 * one shared refresh that refetches both lists and re-syncs the open dialog.
 *
 * Symptom 2 (store race): concurrent fetchImplementationPlan calls (the handler's
 * own plus an SSE-triggered one) did last-write-wins on implementationPlans with
 * no ordering guard, so a slower earlier response could clobber a newer one and
 * surface an older version of a contribution. The fix adds a per-project sequence
 * guard that drops a stale response.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { shallowMount, flushPromises } from '@vue/test-utils';
import { setActivePinia, createPinia } from 'pinia';

const notify = vi.hoisted(() => vi.fn());
vi.mock('quasar', () => ({ useQuasar: () => ({ notify }) }));

vi.mock('vue-router', () => ({
  useRoute: () => ({ params: { id: 'p1' } }),
  useRouter: () => ({ push: vi.fn() }),
}));

// Mock the implementation-plans API so the store's fetchImplementationPlan can
// be exercised directly for the ordering-guard test.
const getPlan = vi.hoisted(() => vi.fn());
vi.mock('src/lib/api/implementationPlans', async (importOriginal) => {
  const actual = await importOriginal<typeof import('src/lib/api/implementationPlans')>();
  return { ...actual, getImplementationPlanForProject: getPlan };
});

import ProjectDetailPage from 'src/pages/Projects/ProjectDetailPage.vue';
import { useProjectsStore } from 'src/stores/projects';
import { useProposalsStore } from 'src/stores/proposals';
import { useContributionsStore } from 'src/stores/contributions';
import { useCommentCursorsStore } from 'src/stores/commentCursors';
import type { Project } from 'src/lib/api/projects';
import type { Contribution } from 'src/lib/api/contributions';

const PROJECT: Project = {
  id: 'p1',
  title: 'Marae Restoration',
  description: 'A project',
  status: 'active',
  created_by: 'someone-else',
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
} as Project;

const SUB: Contribution = {
  id: 'sub1',
  project_id: 'p1',
  title: 'Draft consultation flyer',
  status: 'created',
  parent_contribution: 'c1',
} as unknown as Contribution;

function setupStores() {
  const projects = useProjectsStore();
  const proposals = useProposalsStore();
  const contributions = useContributionsStore();
  const cursors = useCommentCursorsStore();
  vi.spyOn(projects, 'fetchProject').mockResolvedValue(undefined as never);
  vi.spyOn(projects, 'fetchImplementationPlan').mockResolvedValue(undefined as never);
  vi.spyOn(projects, 'fetchProjectContributions').mockResolvedValue(undefined as never);
  vi.spyOn(projects, 'fetchComments').mockResolvedValue(undefined as never);
  vi.spyOn(proposals, 'fetchProposals').mockResolvedValue(undefined as never);
  vi.spyOn(cursors, 'markRead').mockResolvedValue(undefined as never);
  projects.currentProject = { ...PROJECT };
  return { projects, contributions };
}

async function mountPage() {
  const wrapper = shallowMount(ProjectDetailPage, {
    global: { directives: { 'close-popup': {} } },
  });
  await flushPromises();
  return wrapper;
}

beforeEach(() => {
  setActivePinia(createPinia());
  notify.mockClear();
  getPlan.mockReset();
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, json: async () => ({}) }));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('#751 onContributionSave refreshes both lists', () => {
  it('refetches the flat project-contributions list, not only the plan', async () => {
    const { projects, contributions } = setupStores();
    vi.spyOn(contributions, 'update').mockResolvedValue(SUB as never);

    const wrapper = await mountPage();
    (projects.fetchImplementationPlan as ReturnType<typeof vi.fn>).mockClear();
    (projects.fetchProjectContributions as ReturnType<typeof vi.fn>).mockClear();

    // A lead/steward edits a sub-contribution assigned to another member.
    wrapper.vm.editingContribution = { ...SUB };
    await wrapper.vm.onContributionSave({ title: 'Draft consultation flyer v2' });
    await flushPromises();

    expect(contributions.update).toHaveBeenCalledWith('sub1', expect.objectContaining({
      title: 'Draft consultation flyer v2',
    }));
    // The regression: the old handler only refetched the plan. The sub-list is
    // backed by the flat project-contributions list, so that must refetch too.
    expect(projects.fetchImplementationPlan).toHaveBeenCalledWith('p1');
    expect(projects.fetchProjectContributions).toHaveBeenCalledWith('p1');
    expect(wrapper.vm.editingContribution).toBeNull();

    wrapper.unmount();
  });

  it('re-syncs the open detail dialog to the freshly-fetched contribution', async () => {
    const { projects, contributions } = setupStores();
    vi.spyOn(contributions, 'update').mockResolvedValue(SUB as never);
    // The flat list returns the updated copy after the save.
    (projects.fetchProjectContributions as ReturnType<typeof vi.fn>).mockImplementation(
      async () => {
        projects.projectContributions = {
          p1: [{ ...SUB, title: 'Draft consultation flyer v2' }],
        };
      },
    );

    const wrapper = await mountPage();
    wrapper.vm.viewingContribution = { ...SUB };
    wrapper.vm.editingContribution = { ...SUB };
    await wrapper.vm.onContributionSave({ title: 'Draft consultation flyer v2' });
    await flushPromises();

    // The open dialog's viewed contribution reflects the edit without a reload.
    expect(wrapper.vm.viewingContribution?.title).toBe('Draft consultation flyer v2');

    wrapper.unmount();
  });
});

describe('#751 fetchImplementationPlan ordering guard', () => {
  it('drops a stale response so a slow earlier fetch cannot clobber a newer one', async () => {
    setupStores();
    // Un-stub the spy installed by setupStores so the real store action runs
    // against the mocked API.
    const projects = useProjectsStore();
    vi.mocked(projects.fetchImplementationPlan).mockRestore();

    let resolveFirst!: (v: unknown) => void;
    let resolveSecond!: (v: unknown) => void;
    getPlan
      .mockImplementationOnce(() => new Promise((r) => { resolveFirst = r; }))
      .mockImplementationOnce(() => new Promise((r) => { resolveSecond = r; }));

    // Kick off two concurrent fetches for the same project.
    const first = projects.fetchImplementationPlan('p1');
    const second = projects.fetchImplementationPlan('p1');

    // The newer (second) fetch resolves first with the fresh plan…
    resolveSecond({ id: 'plan1', project_id: 'p1', milestones: [], signed_off: false });
    await second;
    expect(projects.implementationPlans.p1?.id).toBe('plan1');

    // …then the older (first) fetch resolves late with a stale plan. It must NOT
    // overwrite the fresher value already stored.
    resolveFirst({ id: 'plan1-stale', project_id: 'p1', milestones: [], signed_off: false });
    await first;
    expect(projects.implementationPlans.p1?.id).toBe('plan1');
  });
});
