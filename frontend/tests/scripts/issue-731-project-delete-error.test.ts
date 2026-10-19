// @vitest-environment happy-dom
/**
 * #731 — Deleting a project failed silently.
 *
 * From the project detail page's danger-zone "Delete Project" button, confirming
 * the destroy dialog invoked a handler that awaited the projects store's archive
 * action inside a `try { … } finally { … }` with no `catch`. When the backend
 * rejected the request (e.g. a 403 "insufficient permissions"), the rejection
 * became an unhandled promise rejection that only printed to the console — the
 * confirm dialog stayed open and the user saw nothing on screen.
 *
 * The fix adds a `catch` that surfaces the backend error as a negative Quasar
 * notification (matching the sibling mutation handlers in the same page) and
 * clears the busy flag so the dialog returns to an actionable state.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { shallowMount, flushPromises } from '@vue/test-utils';
import { setActivePinia, createPinia } from 'pinia';

// Capture the Quasar notification spy.
const notify = vi.hoisted(() => vi.fn());
vi.mock('quasar', () => ({ useQuasar: () => ({ notify }) }));

// Router: the page calls useRoute()/useRouter() at setup.
const routerPush = vi.hoisted(() => vi.fn());
vi.mock('vue-router', () => ({
  useRoute: () => ({ params: { id: 'p1' } }),
  useRouter: () => ({ push: routerPush }),
}));

import ProjectDetailPage from 'src/pages/Projects/ProjectDetailPage.vue';
import { useProjectsStore } from 'src/stores/projects';
import { useProposalsStore } from 'src/stores/proposals';
import { useCommentCursorsStore } from 'src/stores/commentCursors';
import type { Project } from 'src/lib/api/projects';

const PROJECT: Project = {
  id: 'p1',
  title: 'Marae Restoration',
  description: 'A project',
  status: 'active',
  created_by: 'someone-else',
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
} as Project;

function setupStores() {
  const projects = useProjectsStore();
  const proposals = useProposalsStore();
  const cursors = useCommentCursorsStore();
  // Keep onMounted's loadProject()/loadCommunityMembers() inert.
  vi.spyOn(projects, 'fetchProject').mockResolvedValue(undefined as never);
  vi.spyOn(projects, 'fetchImplementationPlan').mockResolvedValue(undefined as never);
  vi.spyOn(projects, 'fetchProjectContributions').mockResolvedValue(undefined as never);
  vi.spyOn(projects, 'fetchComments').mockResolvedValue(undefined as never);
  vi.spyOn(proposals, 'fetchProposals').mockResolvedValue(undefined as never);
  vi.spyOn(cursors, 'markRead').mockResolvedValue(undefined as never);
  projects.currentProject = { ...PROJECT };
  return { projects };
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
  routerPush.mockClear();
  // loadCommunityMembers() calls fetch(); keep it quiet.
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, json: async () => ({}) }));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('#731 confirmDestroy error handling', () => {
  it('surfaces a negative notification with the backend message when archive is rejected', async () => {
    const { projects } = setupStores();
    const archive = vi
      .spyOn(projects, 'archive')
      .mockRejectedValue(new Error('insufficient permissions'));

    const wrapper = await mountPage();
    wrapper.vm.showDestroy = true;
    notify.mockClear();

    // The confirm-destroy handler must not leak an unhandled rejection.
    await expect(wrapper.vm.confirmDestroy()).resolves.toBeUndefined();
    await flushPromises();

    expect(archive).toHaveBeenCalledWith('p1');
    expect(notify).toHaveBeenCalledWith({
      type: 'negative',
      message: 'insufficient permissions',
    });
    // Busy flag cleared and dialog left actionable (still open, not navigated away).
    expect(wrapper.vm.archivingProject).toBe(false);
    expect(wrapper.vm.showDestroy).toBe(true);
    expect(routerPush).not.toHaveBeenCalled();

    wrapper.unmount();
  });

  it('closes the dialog and navigates to the projects list on success', async () => {
    const { projects } = setupStores();
    const archive = vi.spyOn(projects, 'archive').mockResolvedValue(undefined as never);

    const wrapper = await mountPage();
    wrapper.vm.showDestroy = true;
    notify.mockClear();

    await wrapper.vm.confirmDestroy();
    await flushPromises();

    expect(archive).toHaveBeenCalledWith('p1');
    expect(wrapper.vm.archivingProject).toBe(false);
    expect(wrapper.vm.showDestroy).toBe(false);
    expect(routerPush).toHaveBeenCalledWith({ name: 'projects' });
    // No error notification on the happy path.
    expect(notify).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: 'negative' }),
    );

    wrapper.unmount();
  });
});
