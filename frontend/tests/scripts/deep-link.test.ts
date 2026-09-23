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
const PAIR = 'matou://pair?id=s1&pk=EPubKey&s=0ABsig';
const INBOX = 'matou://inbox';
const INBOX_TARGET = { name: 'dashboard', query: { focus: 'pending' } };

describe('classifyDeepLink', () => {
  it('recognises a sign-in link', () => {
    expect(classifyDeepLink(SIGNIN)).toBe('signin');
    expect(classifyDeepLink(`  ${SIGNIN}  `)).toBe('signin');
  });

  it('recognises a pairing link', () => {
    expect(classifyDeepLink(PAIR)).toBe('pair');
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
