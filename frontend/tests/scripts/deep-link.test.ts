/**
 * OS deep-link classification + routing (idss #1492 story 34, #532).
 *
 * The native shells hand a raw `matou://…` URL to the WebView; classifyDeepLink
 * decides where it belongs and handleDeepLink navigates: a sign-in link opens
 * the approve card, a pairing link lands on the link-device screen with the
 * payload stashed, and anything malformed is ignored (the app stays home).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';
import type { Router } from 'vue-router';
import { classifyDeepLink } from 'src/lib/deepLink';
import { isPairingLink } from 'src/lib/pairing/link';
import {
  handleDeepLink,
  consumePendingPairLink,
  consumeInboxDeepLinkTarget,
  setDeepLinkRouter,
  __resetDeepLinkForTest,
} from 'src/composables/useDeepLink';
import { useOnboardingStore } from 'src/stores/onboarding';

const SIGNIN =
  'matou://signin?door=https://id.example.nz/login&present=https://id.example.nz/login/app/present&c=c_3f9&s=EMe&name=Home&service=Files';
// The retired panel unlock code (#664). A locked panel unlocks through the
// sign-in door now (#688), so nothing handles this scheme.
const OLD_UNLOCK =
  'matou://unlock?panel=https://admin.example.nz&present=https://id.example.nz/login/app/unlock&u=u_2d7&ek=DFRESHKEY&name=Home&t=14:06';
// What a locked panel's unlock IS now: a sign-in code that says it is an unlock.
const UNLOCK_HOP =
  'matou://signin?c=nonce-UNLOCK&cred=administrator&door=https://id.example.nz/login&name=Home&offer=unlock&present=https://id.example.nz/login/app/present&s=ECo,EMe&svc=the%20control%20panel';
const PAIR = 'matou://pair?id=s1&pk=EPubKey&s=0ABsig';
const INBOX = 'matou://inbox';
const INBOX_TARGET = { name: 'dashboard', query: { focus: 'pending' } };
// What Windows actually hands the app for a page's `matou://signin?…` link: the
// shell inserts a `/` after the host (recorded on a Windows 11 install of the
// WHAKATOHEA DEMO kit, 2026-09-30). The link must still open the approve card.
const WINDOWS_SIGNIN =
  'matou://signin/?c=-MOWoIcLtLQok0WU56XhVRYGqmPWLvsyXkNAIBJ-Uvo&door=https%3A%2F%2Fid.whakatohea-demo.idss.nz%2Flogin&name=WHAKATOHEA+DEMO&present=https%3A%2F%2Fid.whakatohea-demo.idss.nz%2Flogin%2Fapp%2Fpresent&s=IBpju1vRXOpF3gG-PXOdkeseqsqr0uD1ut7YN5538x9t%2CICyWw9WrDmRwNEPRIp032_3IrGiY9O1suzD2TGN8Mexx&svc=the+community+portal';
const WINDOWS_PAIR = 'matou://pair/?id=s1&pk=EPubKey&s=0ABsig';

describe('classifyDeepLink', () => {
  it('recognises a sign-in link', () => {
    expect(classifyDeepLink(SIGNIN)).toBe('signin');
    expect(classifyDeepLink(`  ${SIGNIN}  `)).toBe('signin');
  });

  it('an unlock is a sign-in link that says it is an unlock (#688)', () => {
    expect(classifyDeepLink(UNLOCK_HOP)).toBe('signin');
  });

  it('does not recognise the retired matou://unlock code (#688)', () => {
    expect(classifyDeepLink(OLD_UNLOCK)).toBe('unknown');
    expect(classifyDeepLink(`  ${OLD_UNLOCK}  `)).toBe('unknown');
  });

  it('recognises a pairing link', () => {
    expect(classifyDeepLink(PAIR)).toBe('pair');
  });

  it('tolerates the slash Windows inserts after the host (signin, pair)', () => {
    expect(classifyDeepLink(WINDOWS_SIGNIN)).toBe('signin');
    expect(classifyDeepLink(WINDOWS_PAIR)).toBe('pair');
  });

  it('recognises an inbox link, tolerating a trailing slash and a query', () => {
    expect(classifyDeepLink(INBOX)).toBe('inbox');
    expect(classifyDeepLink(`  ${INBOX}  `)).toBe('inbox');
    expect(classifyDeepLink('matou://inbox/')).toBe('inbox');
    expect(classifyDeepLink('matou://inbox?ref=laptop')).toBe('inbox');
    expect(classifyDeepLink('matou://inbox/?ref=laptop')).toBe('inbox');
  });

  it('treats a malformed or unknown link as unknown', () => {
    expect(classifyDeepLink('matou://signin?door=https://d.nz')).toBe('unknown'); // no challenge
    expect(classifyDeepLink('matou://pair?id=s1')).toBe('unknown'); // no pk/s
    expect(classifyDeepLink('matou://inboxes')).toBe('unknown'); // not the inbox host
    expect(classifyDeepLink('matou://inbox/pending')).toBe('unknown'); // no sub-path
    expect(classifyDeepLink('https://example.com')).toBe('unknown');
    expect(classifyDeepLink('garbage')).toBe('unknown');
    expect(classifyDeepLink('')).toBe('unknown');
  });
});

describe('isPairingLink', () => {
  it('accepts a full pairing link and rejects partial/other text', () => {
    expect(isPairingLink(PAIR)).toBe(true);
    expect(isPairingLink('matou://pair?id=s1&pk=x')).toBe(false);
    expect(isPairingLink(SIGNIN)).toBe(false);
  });
});

describe('handleDeepLink', () => {
  let push: ReturnType<typeof vi.fn>;
  let router: Router;

  beforeEach(() => {
    setActivePinia(createPinia());
    __resetDeepLinkForTest();
    push = vi.fn(async () => undefined);
    router = { push } as unknown as Router;
    setDeepLinkRouter(router);
  });

  it('pushes the approve card for a sign-in link', async () => {
    await handleDeepLink(SIGNIN);
    expect(push).toHaveBeenCalledWith({
      name: 'signin-approve',
      query: {
        door: 'https://id.example.nz/login',
        present: 'https://id.example.nz/login/app/present',
        c: 'c_3f9',
        s: 'EMe',
        name: 'Home',
        service: 'Files',
      },
    });
    expect(consumePendingPairLink()).toBeNull();
  });

  it('pushes the approve card for the link as Windows delivers it (slash after the host)', async () => {
    await handleDeepLink(WINDOWS_SIGNIN);
    expect(push).toHaveBeenCalledWith({
      name: 'signin-approve',
      query: {
        door: 'https://id.whakatohea-demo.idss.nz/login',
        present: 'https://id.whakatohea-demo.idss.nz/login/app/present',
        c: '-MOWoIcLtLQok0WU56XhVRYGqmPWLvsyXkNAIBJ-Uvo',
        s: 'IBpju1vRXOpF3gG-PXOdkeseqsqr0uD1ut7YN5538x9t,ICyWw9WrDmRwNEPRIp032_3IrGiY9O1suzD2TGN8Mexx',
        name: 'WHAKATOHEA DEMO',
        service: 'the community portal',
      },
    });
  });

  it('stashes a pairing link as Windows delivers it in its canonical form', async () => {
    await handleDeepLink(WINDOWS_PAIR);
    expect(consumePendingPairLink()).toBe(PAIR);
  });

  it('pushes the approve card for an unlock code, carrying what it offers (#688)', async () => {
    await handleDeepLink(UNLOCK_HOP);
    expect(push).toHaveBeenCalledWith({
      name: 'signin-approve',
      query: {
        door: 'https://id.example.nz/login',
        present: 'https://id.example.nz/login/app/present',
        c: 'nonce-UNLOCK',
        s: 'ECo,EMe',
        name: 'Home',
        service: 'the control panel',
        cred: 'administrator',
        offer: 'unlock',
      },
    });
  });

  it('ignores the retired matou://unlock code — no navigation (#688)', async () => {
    await handleDeepLink(OLD_UNLOCK);
    expect(push).not.toHaveBeenCalled();
  });

  it('steers onboarding to the link-device screen and stashes a pairing link', async () => {
    await handleDeepLink(PAIR);
    const onboarding = useOnboardingStore();
    expect(onboarding.onboardingPath).toBe('link');
    expect(onboarding.currentScreen).toBe('link-scan');
    expect(push).toHaveBeenCalledWith('/');
    expect(consumePendingPairLink()).toBe(PAIR);
    // Stash is consumed once.
    expect(consumePendingPairLink()).toBeNull();
  });

  it('stashes the inbox target for the onboarding gate on a cold start', async () => {
    // No dashboard route yet (splash/onboarding gate): the target is stashed
    // for the gate to replay and the app is steered to '/'.
    await handleDeepLink(INBOX);
    expect(push).toHaveBeenCalledWith('/');
    expect(consumeInboxDeepLinkTarget()).toEqual(INBOX_TARGET);
    // Stash is consumed once.
    expect(consumeInboxDeepLinkTarget()).toBeNull();
  });

  it('navigates straight to the Pending card when already on a dashboard route', async () => {
    const warmPush = vi.fn(async () => undefined);
    const warmRouter = {
      push: warmPush,
      currentRoute: { value: { path: '/dashboard' } },
    } as unknown as Router;
    setDeepLinkRouter(warmRouter);

    await handleDeepLink('matou://inbox/?ref=laptop');
    expect(warmPush).toHaveBeenCalledWith(INBOX_TARGET);
    // Warm nav does not stash — the gate has nothing to replay.
    expect(consumeInboxDeepLinkTarget()).toBeNull();
  });

  it('ignores a malformed link — no navigation, no stash', async () => {
    await handleDeepLink('matou://signin?door=https://d.nz'); // missing challenge
    await handleDeepLink('totally-not-a-link');
    expect(push).not.toHaveBeenCalled();
    expect(consumePendingPairLink()).toBeNull();
    expect(useOnboardingStore().currentScreen).toBe('splash');
  });

  it('does not throw when the router is not wired yet', async () => {
    __resetDeepLinkForTest();
    await expect(handleDeepLink(SIGNIN)).resolves.toBeUndefined();
  });
});
