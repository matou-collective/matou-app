// @vitest-environment happy-dom
/**
 * #802 — Explain why a project is still "Created".
 *
 * A project's status is derived, not set by hand: it stays `created` until its
 * implementation plan is signed off, and sign-off is restricted to steward/admin
 * roles (Project Steward / Operations Steward / Founding Member). A project lead
 * (or anyone without sign-off permission) saw a `created` badge with no "Sign Off
 * Plan" button and no explanation of why the project wasn't active or who could
 * activate it.
 *
 * The fix renders an explanatory hint beside the status badge, shown precisely
 * when the project is `created` AND the current user lacks sign-off permission
 * (the existing `canSignOffPlan` predicate). It never appears once the project is
 * active, and never for users who already have the "Sign Off Plan" control.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { shallowMount, flushPromises } from '@vue/test-utils';
import { setActivePinia, createPinia } from 'pinia';

vi.mock('quasar', () => ({ useQuasar: () => ({ notify: vi.fn() }) }));

vi.mock('vue-router', () => ({
  useRoute: () => ({ params: { id: 'p1' } }),
  useRouter: () => ({ push: vi.fn() }),
}));

import ProjectDetailPage from 'src/pages/Projects/ProjectDetailPage.vue';
import { useProjectsStore } from 'src/stores/projects';
import { useProposalsStore } from 'src/stores/proposals';
import { useCommentCursorsStore } from 'src/stores/commentCursors';
import { useIdentityStore } from 'src/stores/identity';
import type { Project } from 'src/lib/api/projects';

const MY_AID = 'EMyAidPrefix0000000000000000000000000000000';
const STEWARD_AID = 'EStewardPrefix000000000000000000000000000000';

function makeProject(overrides: Partial<Project>): Project {
  return {
    id: 'p1',
    title: 'Marae Restoration',
    description: 'A project',
    status: 'created',
    created_by: 'someone-else',
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    ...overrides,
  } as Project;
}

function setupStores(project: Project) {
  const projects = useProjectsStore();
  const proposals = useProposalsStore();
  const cursors = useCommentCursorsStore();
  vi.spyOn(projects, 'fetchProject').mockResolvedValue(undefined as never);
  vi.spyOn(projects, 'fetchImplementationPlan').mockResolvedValue(undefined as never);
  vi.spyOn(projects, 'fetchProjectContributions').mockResolvedValue(undefined as never);
  vi.spyOn(projects, 'fetchComments').mockResolvedValue(undefined as never);
  vi.spyOn(proposals, 'fetchProposals').mockResolvedValue(undefined as never);
  vi.spyOn(cursors, 'markRead').mockResolvedValue(undefined as never);
  projects.currentProject = { ...project };
}

/**
 * @param isCommunityAdmin  holder of an Operations Steward / Founding Member credential
 */
function setupIdentity(isCommunityAdmin: boolean) {
  const identity = useIdentityStore();
  // currentAID / adminCredential are exposed refs on the setup store.
  (identity as unknown as { currentAID: unknown }).currentAID = { prefix: MY_AID };
  (identity as unknown as { adminCredential: unknown }).adminCredential = {
    role: isCommunityAdmin ? 'Operations Steward' : 'Member',
  };
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
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, json: async () => ({}) }));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('#802 created-status hint', () => {
  it('renders the hint for a project lead (no sign-off permission) on a created project', async () => {
    // Lead on the project, but steward is someone else and the user is not a
    // community admin → canSignOffPlan is false.
    setupStores(makeProject({ status: 'created', project_lead_id: MY_AID, project_steward_id: STEWARD_AID }));
    setupIdentity(false);

    const wrapper = await mountPage();
    const hint = wrapper.find('[data-testid="created-status-hint"]');
    expect(hint.exists()).toBe(true);
    // Names the roles that can activate the project so the lead knows who to ask.
    expect(hint.text()).toContain('Project Steward');
    expect(hint.text()).toContain('Operations Steward');
    expect(hint.text()).toContain('Founding Member');

    wrapper.unmount();
  });

  it('does not render the hint once the project is active', async () => {
    setupStores(makeProject({ status: 'active', project_lead_id: MY_AID, project_steward_id: STEWARD_AID }));
    setupIdentity(false);

    const wrapper = await mountPage();
    expect(wrapper.find('[data-testid="created-status-hint"]').exists()).toBe(false);

    wrapper.unmount();
  });

  it('does not render the hint for a user who can sign off the plan', async () => {
    // Community admin (Operations Steward) → canSignOffPlan is true, so they
    // already see the "Sign Off Plan" control and get no redundant hint.
    setupStores(makeProject({ status: 'created', project_steward_id: STEWARD_AID }));
    setupIdentity(true);

    const wrapper = await mountPage();
    expect(wrapper.find('[data-testid="created-status-hint"]').exists()).toBe(false);

    wrapper.unmount();
  });
});
