// @vitest-environment happy-dom
/**
 * The no-credential screen (#683; Ben, 2026-09-28: "if the user doesnt have the
 * credential they should see a screen saying you do not have the required
 * credential to sign into this service"). A screen of its own — not the approve
 * card with a disabled button. It names the service and the credential it asks
 * for, says who can issue it, and offers no Approve: nothing is presented and
 * nothing is posted to the door.
 */
import { describe, it, expect } from 'vitest';
import { mount } from '@vue/test-utils';
import NoCredential from 'src/components/signin/NoCredential.vue';
import FirstContact from 'src/components/signin/FirstContact.vue';

const stubs = { MBtn: { template: '<button v-bind="$attrs"><slot/></button>' } };

function mountScreen(props: Record<string, unknown> = {}) {
  return mount(NoCredential, {
    props: {
      service: 'the control panel',
      community: 'Whakatōhea',
      credentialName: 'Administrator',
      posted: false,
      ...props,
    },
    global: { stubs },
  });
}

describe('NoCredential', () => {
  it("says it in Ben's words", () => {
    const w = mountScreen();
    expect(w.find('[data-face="no-credential"]').exists()).toBe(true);
    expect(w.find('[data-field="heading"]').text()).toBe(
      'You do not have the required credential to sign into this service',
    );
  });

  it('names the service and the credential it asks for', () => {
    const w = mountScreen();
    expect(w.find('[data-field="asked"]').text()).toBe('The control panel asks for the Administrator credential.');
    expect(mountScreen({ service: 'Files', credentialName: 'Membership' }).find('[data-field="asked"]').text()).toBe(
      'Files asks for the Membership credential.',
    );
  });

  it('says who can issue it', () => {
    expect(mountScreen().find('[data-field="issuer"]').text()).toBe('A steward of Whakatōhea can issue it to you.');
  });

  it('stays grammatical when the ask could not name the credential', () => {
    const w = mountScreen({ credentialName: '' });
    expect(w.find('[data-field="asked"]').text()).toBe('The control panel asks for a credential this app does not hold.');
  });

  it('has no Approve — only a way out', async () => {
    const w = mountScreen();
    expect(w.find('[data-action="approve"]').exists()).toBe(false);
    expect(w.findAll('button')).toHaveLength(1);
    await w.find('[data-action="close"]').trigger('click');
    expect(w.emitted('close')).toHaveLength(1);
  });

  it('says nothing was shown to the site — but only when nothing was', () => {
    expect(mountScreen().find('[data-field="nothing-shown"]').text()).toBe('Nothing was shown to the sign-in site.');
    // The door itself answered no-credential to a presentation: that line would
    // be untrue, so it is not said.
    expect(mountScreen({ posted: true }).find('[data-field="nothing-shown"]').exists()).toBe(false);
  });
});

// First contact (WS-A1) says what trusting the site will show it. At a door that
// names a credential, that is the named credential, not the membership.
describe('FirstContact — what trusting discloses (#683)', () => {
  it('names the credential the door asked for', () => {
    const w = mount(FirstContact, {
      props: { address: 'id.example.nz', claimedName: 'Whakatōhea', credentialName: 'Administrator' },
      global: { stubs },
    });
    expect(w.find('[data-field="discloses"]').text()).toContain('shows this site your Administrator credential');
  });

  it('says membership, as before, when the door named none', () => {
    const w = mount(FirstContact, {
      props: { address: 'id.example.nz', claimedName: 'Whakatōhea' },
      global: { stubs },
    });
    expect(w.find('[data-field="discloses"]').text()).toContain('shows this site your membership credential');
  });
});
