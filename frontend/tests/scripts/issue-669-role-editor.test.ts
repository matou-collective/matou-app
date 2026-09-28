// @vitest-environment happy-dom
/**
 * #669 — the in-app role editor and founding member, per backend.
 *
 * On an IDSS backend the founding-member fact is the signer set (conferred by the
 * promotion rail), not an assignable role string. So:
 *
 *   - the Invite Member editor does NOT offer Founding Member as an initial role
 *     on IDSS (it would mint a founding member with no signing power — a second
 *     source of truth), but a Coa community keeps it (its own role model, AC7);
 *   - the Change Role editor offers Founding Member as a PROMOTION: selecting it
 *     runs `upgradeMemberToSteward` (the rail), never a plain role-history
 *     re-issue. That is what "not offered as a role-history grant" means here.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { ref } from 'vue';

// ---- Mutable app-store backend flag (flipped per test) ----------------------
const appState = vi.hoisted(() => ({ isIdssBackend: false }));
vi.mock('stores/app', () => ({ useAppStore: () => appState }));

// ---- Invite composable + api client (kept as light stubs) -------------------
vi.mock('src/composables/usePreCreatedInvite', () => ({
  usePreCreatedInvite: () => ({
    isSubmitting: ref(false),
    error: ref(null),
    progress: ref(''),
    result: ref(null),
    createInvite: vi.fn(async () => true),
    reset: vi.fn(),
  }),
}));

const spies = vi.hoisted(() => ({
  upgradeMemberToSteward: vi.fn(async () => true),
  reissueMembershipCredential: vi.fn(async () => true),
  updateMemberRole: vi.fn(async () => ({ error: null })),
}));
const { upgradeMemberToSteward, reissueMembershipCredential, updateMemberRole } = spies;
vi.mock('src/composables/useAdminActions', () => ({
  useAdminActions: () => ({
    upgradeMemberToSteward: spies.upgradeMemberToSteward,
    reissueMembershipCredential: spies.reissueMembershipCredential,
  }),
}));
vi.mock('src/lib/api/client', () => ({
  sendInviteEmail: vi.fn(async () => ({ success: true })),
  updateMemberRole: spies.updateMemberRole,
}));

vi.mock('src/stores/rolePolicy', () => ({
  useRolePolicyStore: () => ({ load: vi.fn(), roleOptions: [] }),
}));

import InviteMemberModal from 'src/components/dashboard/InviteMemberModal.vue';
import ChangeRoleModal from 'src/components/dashboard/ChangeRoleModal.vue';

// Passthrough stubs for the Quasar wrappers the invite modal uses, so its slot
// content (the role <select>) renders under happy-dom without the Quasar plugin.
const slotStub = { template: '<div><slot /></div>' };
const inviteStubs = {
  QDialog: slotStub,
  QCard: slotStub,
  QCardSection: slotStub,
  QSeparator: { template: '<hr />' },
  QCardActions: slotStub,
};

function mountInvite() {
  return mount(InviteMemberModal, {
    props: { modelValue: true, isSteward: true },
    global: { stubs: inviteStubs },
  });
}

describe('#669 Invite Member editor — Founding Member per backend', () => {
  beforeEach(() => {
    appState.isIdssBackend = false;
  });

  it('offers Founding Member on a Coa backend (AC7 — role model unchanged)', () => {
    const wrapper = mountInvite();
    const options = wrapper.findAll('option').map((o) => o.attributes('value'));
    expect(options).toContain('Founding Member');
    expect(options).toContain('Community Steward');
    wrapper.unmount();
  });

  it('does NOT offer Founding Member on an IDSS backend (AC4)', () => {
    appState.isIdssBackend = true;
    const wrapper = mountInvite();
    const options = wrapper.findAll('option').map((o) => o.attributes('value'));
    expect(options).not.toContain('Founding Member');
    // The other roles remain — only the signer-conferring role is withheld.
    expect(options).toContain('Member');
    expect(options).toContain('Community Steward');
    wrapper.unmount();
  });
});

describe('#669 Change Role editor — Founding Member is a promotion, not a grant', () => {
  beforeEach(() => {
    appState.isIdssBackend = true;
    upgradeMemberToSteward.mockClear();
    reissueMembershipCredential.mockClear();
    updateMemberRole.mockClear();
  });

  it('routes a Founding Member change through the promotion rail on IDSS', async () => {
    const wrapper = mount(ChangeRoleModal, {
      props: { show: true, memberName: 'Kahu', memberAid: 'DMEMBER', currentRole: 'Member' },
      global: { stubs: { teleport: true } },
    });

    await wrapper.find('input[value="Founding Member"]').setValue();
    const confirm = wrapper.findAll('button').find((b) => b.text() === 'Confirm');
    expect(confirm).toBeTruthy();
    await confirm!.trigger('click');
    await flushPromises();

    // The promotion rail runs; the plain role-history re-issue does NOT.
    expect(upgradeMemberToSteward).toHaveBeenCalledWith('DMEMBER', 'Founding Member', expect.anything());
    expect(reissueMembershipCredential).not.toHaveBeenCalled();

    wrapper.unmount();
  });
});
