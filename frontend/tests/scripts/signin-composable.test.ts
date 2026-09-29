/**
 * useSignin phase machine (idss #1492 stories 13–17/28, WS-A2/A2p/A2d/A2r).
 * Prepare builds the card; Approve drives proving → done (touching the known
 * door) or → refused with the matching copy; Not now signs and posts nothing.
 *
 * The heavy KERI/descriptor/store modules are mocked so only the controller's
 * logic runs; side-effects come in through injected deps.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const touch = vi.fn(async () => undefined);
const trust = vi.fn(async () => undefined);
const knownDoors = {
  load: vi.fn(async () => undefined),
  isHome: vi.fn(() => true),
  isKnown: vi.fn(() => true),
  trust,
  touch,
};

vi.mock('src/lib/keri/client', () => ({
  useKERIClient: () => ({ getSignifyClient: () => null, ensureSession: async () => undefined }),
}));
vi.mock('src/lib/clientConfig', () => ({ getCommunityDescriptor: async () => ({ schemas: {} }) }));
vi.mock('stores/identity', () => ({ useIdentityStore: () => ({ aidPrefix: 'EHa' }) }));
vi.mock('src/stores/knownDoors', () => ({ useKnownDoorsStore: () => knownDoors }));

import { useSignin, walletReady, type SigninDeps } from 'src/composables/useSignin';
import { reactive } from 'vue';
import type { HeldCredential } from 'src/lib/signin/credential';
import type { PresentVerdict } from 'src/lib/signin/present';

const cred: HeldCredential = {
  sad: { d: 'ECred', s: 'EMe', a: { i: 'EHa', role: 'Member', dt: '2026-08-12T00:00:00Z' } },
};

const LINK =
  'matou://signin?door=https://id.example.nz/login&present=https://id.example.nz/login/app/present&c=c_3f9&s=EMe&name=Home&service=Files';

function deps(overrides: Partial<SigninDeps> = {}): SigninDeps {
  return {
    listCredentials: async () => [cred],
    exportCredential: async (said) => `EXPORT:${said}`,
    sign: async (_aid, m) => `sig(${m})`,
    present: async () => ({ outcome: 'verified' }),
    schemaKinds: async () => ({ EMe: 'membership', ECo: 'committee' }),
    ready: async () => undefined,
    sealingKeyFingerprint: async (verkey) => `fp(${verkey})`,
    now: () => 1_000_000,
    arm: () => undefined,
    answerHandover: async () => undefined,
    ...overrides,
  };
}

// A steward's control-panel sign-in: the link carries `ek=` (a sealing key) and
// the held credential's role is operator. #663.
const stewardCred: HeldCredential = {
  sad: { d: 'ECred', s: 'EMe', i: 'ECommunity', a: { i: 'EHa', role: 'operator', dt: '2026-08-12T00:00:00Z' } },
};
const PANEL_LINK =
  'matou://signin?door=https://id.example.nz/login&present=https://id.example.nz/login/app/present&c=c_panel&s=EMe&name=Home&svc=the%20control%20panel&ek=DVERKEY_EXAMPLE';

beforeEach(() => {
  vi.clearAllMocks();
  knownDoors.isHome.mockReturnValue(true);
  knownDoors.isKnown.mockReturnValue(true);
});

describe('useSignin', () => {
  it('prepareFromLink builds the card view and finds the credential', async () => {
    const s = useSignin(deps());
    const ok = await s.prepareFromLink(LINK);
    expect(ok).toBe(true);
    expect(s.phase.value).toBe('card');
    expect(s.view.value?.service).toBe('Files');
    expect(s.view.value?.isHome).toBe(true);
    expect(s.view.value?.credential?.kindLabel).toBe('Membership');
    expect(s.chosen.value).toBe(cred);
  });

  it('prepareFromLink returns false for a non-signin link', async () => {
    const s = useSignin(deps());
    expect(await s.prepareFromLink('matou://pair?id=x&pk=y&s=z')).toBe(false);
  });

  it('approve → proving → done touches the known door', async () => {
    const s = useSignin(deps());
    await s.prepareFromLink(LINK);
    await s.approve();
    expect(s.phase.value).toBe('done');
    expect(touch).toHaveBeenCalledWith('https://id.example.nz/login');
  });

  it('approve → refused renders the matching refusal copy', async () => {
    const s = useSignin(deps({ present: async () => ({ outcome: 'refused', refusal: 'revoked' }) }));
    await s.prepareFromLink(LINK);
    await s.approve();
    expect(s.phase.value).toBe('refused');
    expect(s.refusal.value?.kind).toBe('revoked');
    expect(s.refusal.value?.text).toContain('has been revoked');
    expect(touch).not.toHaveBeenCalled();
  });

  it('a post that gets no answer shows the wallet-only site-unreachable line', async () => {
    const s = useSignin(deps({ present: async () => ({ outcome: 'site-unreachable' }) }));
    await s.prepareFromLink(LINK);
    await s.approve();
    expect(s.refusal.value?.kind).toBe('site-unreachable');
    expect(s.refusal.value?.showContact).toBe(false);
  });

  it('a wallet-side failure during approve is shown as site-unreachable', async () => {
    const s = useSignin(deps({ sign: async () => { throw new Error('no signer'); } }));
    await s.prepareFromLink(LINK);
    await s.approve();
    expect(s.phase.value).toBe('refused');
    expect(s.refusal.value?.kind).toBe('site-unreachable');
  });

  it('a known (or home) site skips straight to the card, no first-contact', async () => {
    knownDoors.isKnown.mockReturnValue(true);
    const s = useSignin(deps());
    await s.prepareFromLink(LINK);
    expect(s.phase.value).toBe('card');
  });

  it('an unmet site stops at the first-contact prompt before any card (#535)', async () => {
    knownDoors.isKnown.mockReturnValue(false);
    const s = useSignin(deps());
    await s.prepareFromLink(LINK);
    expect(s.phase.value).toBe('first-contact');
    // The card view is still built so Trust can continue to it, and it carries
    // the address the prompt shows.
    expect(s.view.value?.siteAddress).toBe('id.example.nz');
  });

  it('trust adds the site and continues to the approve card (#535)', async () => {
    knownDoors.isKnown.mockReturnValue(false);
    const s = useSignin(deps());
    await s.prepareFromLink(LINK);
    expect(s.phase.value).toBe('first-contact');
    await s.trust();
    expect(trust).toHaveBeenCalledWith('https://id.example.nz/login', 'Home');
    expect(s.phase.value).toBe('card');
  });

  // #675: the newest sign-in code must always win, and a code the door has
  // already spent/expired must never be re-presented on "try again".
  const OTHER_LINK =
    'matou://signin?door=https://id.example.nz/login&present=https://id.example.nz/login/app/present&c=c_fresh&s=EMe&name=Home&service=Files';

  it('a second prepare with a fresh code supersedes the held ask (#675)', async () => {
    const s = useSignin(deps());
    await s.prepareFromLink(LINK);
    expect(s.ask.value?.challenge).toBe('c_3f9');
    // A fresh code arrives (a new deep link / re-scan) while the card is held.
    await s.prepareFromLink(OTHER_LINK);
    expect(s.phase.value).toBe('card');
    expect(s.ask.value?.challenge).toBe('c_fresh');
  });

  it('approve presents the newest challenge after a fresh code supersedes it (#675)', async () => {
    const present = vi.fn(async () => ({ outcome: 'verified' as const }));
    const s = useSignin(deps({ present }));
    await s.prepareFromLink(LINK);
    await s.prepareFromLink(OTHER_LINK);
    await s.approve();
    expect(present).toHaveBeenCalledTimes(1);
    // The bound message carries the fresh challenge, never the first one.
    const body = present.mock.calls[0]?.[1] as { challenge_id?: string } | undefined;
    expect(body?.challenge_id).toBe('c_fresh');
  });

  it('a spent refusal holds the card and try again does not re-present it (#675)', async () => {
    const present = vi.fn(async () => ({ outcome: 'refused' as const, refusal: 'spent' }));
    const s = useSignin(deps({ present }));
    await s.prepareFromLink(LINK);
    await s.approve();
    expect(s.phase.value).toBe('refused');
    expect(s.refusal.value?.kind).toBe('spent');
    expect(s.staleCode.value).toBe(true);
    // Try again must not re-arm Approve with the dead code: it stays on the
    // refusal (whose copy asks for a fresh code) and posts nothing more.
    s.tryAgain();
    expect(s.phase.value).toBe('refused');
    await s.approve();
    expect(present).toHaveBeenCalledTimes(1);
  });

  it('an expired refusal is held the same way (#675)', async () => {
    const present = vi.fn(async () => ({ outcome: 'refused' as const, refusal: 'expired' }));
    const s = useSignin(deps({ present }));
    await s.prepareFromLink(LINK);
    await s.approve();
    expect(s.staleCode.value).toBe(true);
    s.tryAgain();
    await s.approve();
    expect(present).toHaveBeenCalledTimes(1);
  });

  it('a fresh code after a spent refusal clears the hold and can approve (#675)', async () => {
    let outcome: PresentVerdict = { outcome: 'refused', refusal: 'spent' };
    const present = vi.fn(async () => outcome);
    const s = useSignin(deps({ present }));
    await s.prepareFromLink(LINK);
    await s.approve();
    expect(s.staleCode.value).toBe(true);
    // A freshly minted code supersedes the spent one; the hold lifts.
    outcome = { outcome: 'verified' };
    await s.prepareFromLink(OTHER_LINK);
    expect(s.staleCode.value).toBe(false);
    expect(s.phase.value).toBe('card');
    await s.approve();
    expect(s.phase.value).toBe('done');
    expect(present).toHaveBeenCalledTimes(2);
  });

  it('a non-stale refusal still lets try again return to the card (#675)', async () => {
    const s = useSignin(deps({ present: async () => ({ outcome: 'refused', refusal: 'revoked' }) }));
    await s.prepareFromLink(LINK);
    await s.approve();
    expect(s.phase.value).toBe('refused');
    expect(s.staleCode.value).toBe(false);
    s.tryAgain();
    expect(s.phase.value).toBe('card');
  });

  it('notNow signs and posts nothing', async () => {
    const present = vi.fn(async () => ({ outcome: 'verified' as const }));
    const s = useSignin(deps({ present }));
    await s.prepareFromLink(LINK);
    s.notNow();
    expect(present).not.toHaveBeenCalled();
    expect(s.phase.value).toBe('card');
  });
});

// A sign-in code opened before the wallet has finished restoring its session
// (a cold start from the camera: session restore runs non-blocking in boot)
// used to leave the card blank with a disabled Approve until a second scan.
describe('useSignin — preparing before the wallet is ready', () => {
  it('starts on loading, waits for the wallet, and only then reads credentials', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const listCredentials = vi.fn(async () => [cred]);
    const s = useSignin(deps({ ready: () => gate, listCredentials }));
    expect(s.phase.value).toBe('loading');
    const pending = s.prepareFromLink(LINK);
    await Promise.resolve();
    expect(s.phase.value).toBe('loading');
    expect(s.view.value).toBeNull();
    expect(listCredentials).not.toHaveBeenCalled();
    release();
    await pending;
    expect(s.phase.value).toBe('card');
    expect(s.view.value?.service).toBe('Files');
  });

  it('lands on unavailable, never a half-built card, when the wallet never gets ready', async () => {
    const s = useSignin(deps({ ready: async () => { throw new Error('wallet not ready'); } }));
    await expect(s.prepareFromLink(LINK)).resolves.toBe(true);
    expect(s.phase.value).toBe('unavailable');
    expect(s.view.value).toBeNull();
  });

  it('lands on unavailable when reading the credentials fails', async () => {
    const s = useSignin(deps({ listCredentials: async () => { throw new Error('agent not connected'); } }));
    await s.prepareFromLink(LINK);
    expect(s.phase.value).toBe('unavailable');
    expect(s.view.value).toBeNull();
  });

  it('retry re-runs the same sign-in and reaches the card once the wallet answers', async () => {
    let fail = true;
    const s = useSignin(deps({ listCredentials: async () => { if (fail) throw new Error('not yet'); return [cred]; } }));
    await s.prepareFromLink(LINK);
    expect(s.phase.value).toBe('unavailable');
    fail = false;
    await s.retry();
    expect(s.phase.value).toBe('card');
    expect(s.chosen.value).toBe(cred);
  });
});

describe('walletReady — the default readiness gate', () => {
  it('waits for the session restore to finish, then refreshes the agent session', async () => {
    const identity = reactive({ isReady: false, aidPrefix: null as string | null });
    const ensureSession = vi.fn(async () => undefined);
    let settled = false;
    const p = walletReady(identity, { ensureSession }).then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);
    identity.aidPrefix = 'EHa';
    identity.isReady = true;
    await p;
    expect(ensureSession).toHaveBeenCalledTimes(1);
  });

  it('fails when the restore finishes with no identity', async () => {
    const identity = reactive({ isReady: true, aidPrefix: null as string | null });
    await expect(walletReady(identity, { ensureSession: async () => undefined })).rejects.toThrow(/no identity/);
  });

  it('gives up after the timeout', async () => {
    const identity = reactive({ isReady: false, aidPrefix: null as string | null });
    await expect(walletReady(identity, { ensureSession: async () => undefined }, 10)).rejects.toThrow(/did not finish/);
  });
});

// The steward-unlock line and the passcode sealed to the panel's key (#663,
// PU-A2u). The line appears ONLY for a steward's control-panel sign-in; on
// approve with it on the passcode is sealed and posted once; every other card is
// untouched and nothing is armed.
describe('useSignin — the steward-unlock line (#663)', () => {
  it('offers the unlock line, on by default, for a steward control-panel sign-in', async () => {
    const s = useSignin(deps({ listCredentials: async () => [stewardCred] }));
    await s.prepareFromLink(PANEL_LINK);
    expect(s.phase.value).toBe('card');
    expect(s.unlockAvailable.value).toBe(true);
    expect(s.unlockOn.value).toBe(true);
    // The sealing-key fingerprint rides the details, off the face.
    expect(s.view.value?.unlock).toEqual({ sealingKeyFingerprint: 'fp(DVERKEY_EXAMPLE)' });
  });

  it('offers no unlock line for an ordinary service sign-in (no ek)', async () => {
    const s = useSignin(deps({ listCredentials: async () => [stewardCred] }));
    await s.prepareFromLink(LINK);
    expect(s.unlockAvailable.value).toBe(false);
    expect(s.view.value?.unlock).toBeNull();
  });

  it('offers no unlock line to a non-steward on a control-panel sign-in', async () => {
    // The held credential is a plain Member (role !== operator).
    const s = useSignin(deps({ listCredentials: async () => [cred] }));
    await s.prepareFromLink(PANEL_LINK);
    expect(s.unlockAvailable.value).toBe(false);
    expect(s.view.value?.unlock).toBeNull();
  });

  it('arms, posts armed:true and no box, and answers the panel later when the line is on (#674)', async () => {
    // Approve ARMS the wallet for the panel's later request rather than sealing
    // to the sign-in code's `ek=`; the present request carries `armed: true` and
    // NO box, and the box the panel can open is minted only when it asks — so
    // after the sign-in verifies the wallet answers the panel's request in the
    // background (option B, idss #1961/#1967).
    const present = vi.fn(async () => ({ outcome: 'verified' as const }));
    const arm = vi.fn((_challenge: string, _expiresAt: number) => undefined);
    const answerHandover = vi.fn(async () => undefined);
    const s = useSignin(
      deps({ listCredentials: async () => [stewardCred], present, arm, answerHandover, now: () => 1_000_000 }),
    );
    await s.prepareFromLink(PANEL_LINK);
    await s.approve();
    expect(arm).toHaveBeenCalledTimes(1);
    // Armed for the sign-in's own challenge, with an expiry in the future.
    expect(arm.mock.calls[0]![0]).toBe('c_panel');
    expect(arm.mock.calls[0]![1]).toBeGreaterThan(1_000_000);
    expect(present).toHaveBeenCalledTimes(1);
    const body = present.mock.calls[0]![1] as Record<string, unknown>;
    expect(body).not.toHaveProperty('sealed_passcode');
    // The wire tells the door the sign-in armed a handover so it mints the
    // capability (idss #1967).
    expect(body.armed).toBe(true);
    // The panel's request is answered in the background, keyed by this sign-in's
    // present URL, challenge and AID.
    expect(answerHandover).toHaveBeenCalledWith('https://id.example.nz/login/app/present', 'c_panel', 'EHa');
    expect(s.phase.value).toBe('done');
  });

  it('arms nothing, posts no armed signal, and answers nothing when the line is switched off (#674)', async () => {
    const present = vi.fn(async () => ({ outcome: 'verified' as const }));
    const arm = vi.fn((_challenge: string, _expiresAt: number) => undefined);
    const answerHandover = vi.fn(async () => undefined);
    const s = useSignin(deps({ listCredentials: async () => [stewardCred], present, arm, answerHandover }));
    await s.prepareFromLink(PANEL_LINK);
    s.setUnlock(false);
    await s.approve();
    expect(arm).not.toHaveBeenCalled();
    const body = present.mock.calls[0]![1] as Record<string, unknown>;
    expect(body).not.toHaveProperty('sealed_passcode');
    expect(body).not.toHaveProperty('armed');
    expect(answerHandover).not.toHaveBeenCalled();
    expect(s.phase.value).toBe('done');
  });

  it('arms nothing and answers nothing on an ordinary service sign-in even for a steward (#674)', async () => {
    const present = vi.fn(async () => ({ outcome: 'verified' as const }));
    const arm = vi.fn((_challenge: string, _expiresAt: number) => undefined);
    const answerHandover = vi.fn(async () => undefined);
    const s = useSignin(deps({ listCredentials: async () => [stewardCred], present, arm, answerHandover }));
    await s.prepareFromLink(LINK);
    await s.approve();
    expect(arm).not.toHaveBeenCalled();
    const body = present.mock.calls[0]![1] as Record<string, unknown>;
    expect(body).not.toHaveProperty('sealed_passcode');
    expect(body).not.toHaveProperty('armed');
    expect(answerHandover).not.toHaveBeenCalled();
  });

  it('signs in with the seat locked, posts no armed signal, and answers nothing when arming throws (#674)', async () => {
    // A failure to arm must never block the sign-in — it degrades to an ordinary
    // locked-seat session; nothing but a later ciphertext ever leaves, and with
    // no arming there is nothing to answer.
    const present = vi.fn(async () => ({ outcome: 'verified' as const }));
    const arm = vi.fn(() => {
      throw new Error('no passcode in this session');
    });
    const answerHandover = vi.fn(async () => undefined);
    const s = useSignin(deps({ listCredentials: async () => [stewardCred], present, arm, answerHandover }));
    await s.prepareFromLink(PANEL_LINK);
    await s.approve();
    const body = present.mock.calls[0]![1] as Record<string, unknown>;
    expect(body).not.toHaveProperty('sealed_passcode');
    expect(body).not.toHaveProperty('armed');
    expect(answerHandover).not.toHaveBeenCalled();
    expect(s.phase.value).toBe('done');
  });

  it('a refused armed sign-in answers no panel request (#674)', async () => {
    // The door refused, so nothing was handed over — the wallet must not poll or
    // seal for a sign-in that never completed.
    const present = vi.fn(async () => ({ outcome: 'refused' as const, refusal: 'signature' }));
    const answerHandover = vi.fn(async () => undefined);
    const s = useSignin(deps({ listCredentials: async () => [stewardCred], present, answerHandover }));
    await s.prepareFromLink(PANEL_LINK);
    await s.approve();
    expect(s.phase.value).toBe('refused');
    expect(answerHandover).not.toHaveBeenCalled();
  });
});

// The credential the door names (#683, idss ADR 0289). The control panel's door
// asks for Administrator by slug; the wallet presents that credential, else an
// operator's Membership, else nothing.
describe('useSignin — the credential the door names (#683)', () => {
  const financeCred: HeldCredential = {
    sad: { d: 'EFinance', s: 'ECo', i: 'ECommunity', a: { i: 'EHa', committee: 'finance', dt: '2026-09-01T00:00:00Z' } },
    status: { s: '0', et: 'iss' },
  };
  const administratorCred: HeldCredential = {
    sad: {
      d: 'EAdministrator',
      s: 'ECo',
      i: 'ECommunity',
      a: { i: 'EHa', committee: 'administrator', dt: '2026-09-28T00:00:00Z' },
    },
    status: { s: '0', et: 'iss' },
  };
  // The golden's panel ask: committee schema first, then membership; cred named.
  const ADMIN_LINK =
    'matou://signin?c=c_admin&cred=administrator&door=https://id.example.nz/login&name=Home&present=https://id.example.nz/login/app/present&s=ECo,EMe&svc=the%20control%20panel';
  const ADMIN_PANEL_LINK = `${ADMIN_LINK}&ek=DVERKEY_EXAMPLE`;

  it.each([
    ['Membership, Finance, Administrator', [cred, financeCred, administratorCred]],
    ['Finance, Administrator, Membership', [financeCred, administratorCred, cred]],
  ])('shows and presents Administrator whatever order the wallet holds them in (%s)', async (_order, held) => {
    const present = vi.fn(async () => ({ outcome: 'verified' as const }));
    const exportCredential = vi.fn(async (said: string) => `EXPORT:${said}`);
    const s = useSignin(deps({ listCredentials: async () => held, present, exportCredential }));
    await s.prepareFromLink(ADMIN_LINK);
    expect(s.phase.value).toBe('card');
    expect(s.chosen.value).toBe(administratorCred);
    expect(s.view.value?.credential?.name).toBe('Administrator');
    expect(s.view.value?.credential?.card.name).toBe('Administrator');

    await s.approve();
    expect(exportCredential).toHaveBeenCalledTimes(1);
    expect(exportCredential).toHaveBeenCalledWith('EAdministrator');
    const body = present.mock.calls[0]![1] as Record<string, unknown>;
    expect(body.presentation).toBe('EXPORT:EAdministrator');
    expect(s.phase.value).toBe('done');
  });

  // #683 as amended (Ben, 2026-09-28): the founding operator, and any steward
  // still on the legacy role, is never shown the no-credential screen at the
  // control panel — the gateway admits them on their Membership.
  it.each([
    ['alone', [stewardCred]],
    ['after a komiti credential', [financeCred, stewardCred]],
    ['before a komiti credential', [stewardCred, financeCred]],
  ])('an operator with no Administrator is shown and presents their Membership (%s)', async (_case, held) => {
    const present = vi.fn(async () => ({ outcome: 'verified' as const }));
    const s = useSignin(deps({ listCredentials: async () => held, present }));
    await s.prepareFromLink(ADMIN_LINK);
    expect(s.phase.value).toBe('card');
    expect(s.chosen.value).toBe(stewardCred);
    expect(s.view.value?.credential?.card.name).toBe('Membership');
    expect(s.view.value?.provingLine).toBe("Proving you're a member…");
    await s.approve();
    const body = present.mock.calls[0]![1] as Record<string, unknown>;
    expect(body.presentation).toBe('EXPORT:ECred');
    expect(s.phase.value).toBe('done');
  });

  it('an operator who also holds Administrator is shown and presents Administrator', async () => {
    const present = vi.fn(async () => ({ outcome: 'verified' as const }));
    const s = useSignin(deps({ listCredentials: async () => [stewardCred, administratorCred], present }));
    await s.prepareFromLink(ADMIN_LINK);
    expect(s.chosen.value).toBe(administratorCred);
    await s.approve();
    const body = present.mock.calls[0]![1] as Record<string, unknown>;
    expect(body.presentation).toBe('EXPORT:EAdministrator');
  });

  it('a wallet holding Membership only lands on no-credential and posts nothing', async () => {
    const present = vi.fn(async () => ({ outcome: 'verified' as const }));
    const exportCredential = vi.fn(async (said: string) => `EXPORT:${said}`);
    const sign = vi.fn(async (_aid: string, m: string) => `sig(${m})`);
    const s = useSignin(deps({ listCredentials: async () => [cred], present, exportCredential, sign }));
    await s.prepareFromLink(ADMIN_LINK);
    expect(s.phase.value).toBe('no-credential');
    expect(s.chosen.value).toBeNull();
    // The screen can name what the door asked for, and who asked.
    expect(s.view.value?.askedName).toBe('Administrator');
    expect(s.view.value?.service).toBe('the control panel');
    expect(s.view.value?.credential).toBeNull();
    expect(s.posted.value).toBe(false);

    // There is no Approve; were it called anyway, nothing is signed or posted.
    await s.approve();
    expect(sign).not.toHaveBeenCalled();
    expect(exportCredential).not.toHaveBeenCalled();
    expect(present).not.toHaveBeenCalled();
    expect(s.phase.value).toBe('no-credential');
  });

  // #685: a credential issued after joining waits in the agent as a grant. A
  // code scanned cold opens the app on this card, not the dashboard, so the
  // card admits what the community issued before it says there is nothing.
  it('admits a credential the community issued but the wallet had not yet accepted, then shows it', async () => {
    const wallet: HeldCredential[] = [cred];
    const s = useSignin(
      deps({
        listCredentials: async () => [...wallet],
        admitPending: async () => {
          wallet.push(administratorCred);
        },
      }),
    );
    await s.prepareFromLink(ADMIN_LINK);
    expect(s.phase.value).toBe('card');
    expect(s.chosen.value).toBe(administratorCred);
    expect(s.view.value?.credential?.card.name).toBe('Administrator');
  });

  it('admits nothing when the wallet already holds what the door asks for', async () => {
    const admitPending = vi.fn(async () => undefined);
    const s = useSignin(deps({ listCredentials: async () => [administratorCred], admitPending }));
    await s.prepareFromLink(ADMIN_LINK);
    expect(s.phase.value).toBe('card');
    expect(admitPending).not.toHaveBeenCalled();
  });

  it('lands on no-credential when the admission fails or finds nothing', async () => {
    const failing = useSignin(
      deps({
        listCredentials: async () => [cred],
        admitPending: async () => {
          throw new Error('agent unreachable');
        },
      }),
    );
    await failing.prepareFromLink(ADMIN_LINK);
    expect(failing.phase.value).toBe('no-credential');

    const empty = useSignin(deps({ listCredentials: async () => [cred], admitPending: async () => undefined }));
    await empty.prepareFromLink(ADMIN_LINK);
    expect(empty.phase.value).toBe('no-credential');
  });

  it('a service ask that names no credential shows and presents the Membership, as before', async () => {
    const present = vi.fn(async () => ({ outcome: 'verified' as const }));
    const s = useSignin(deps({ listCredentials: async () => [financeCred, administratorCred, cred], present }));
    await s.prepareFromLink(LINK);
    expect(s.phase.value).toBe('card');
    expect(s.chosen.value).toBe(cred);
    expect(s.view.value?.credential?.card.name).toBe('Membership');
    await s.approve();
    const body = present.mock.calls[0]![1] as Record<string, unknown>;
    expect(body.presentation).toBe('EXPORT:ECred');
  });

  it('a wallet holding nothing the service asks for lands on no-credential too', async () => {
    const s = useSignin(deps({ listCredentials: async () => [financeCred] }));
    await s.prepareFromLink(LINK);
    expect(s.phase.value).toBe('no-credential');
    expect(s.view.value?.askedName).toBe('Membership');
  });

  it('no-credential is shown without first asking to trust an unmet site — nothing would be shown to it', async () => {
    knownDoors.isKnown.mockReturnValue(false);
    const s = useSignin(deps({ listCredentials: async () => [cred] }));
    await s.prepareFromLink(ADMIN_LINK);
    expect(s.phase.value).toBe('no-credential');
  });

  it("the door's own no-credential refusal lands on the same screen, marked as posted", async () => {
    const s = useSignin(
      deps({
        listCredentials: async () => [administratorCred],
        present: async () => ({ outcome: 'refused', refusal: 'no-credential' }),
      }),
    );
    await s.prepareFromLink(ADMIN_LINK);
    await s.approve();
    expect(s.phase.value).toBe('no-credential');
    expect(s.posted.value).toBe(true);
    expect(touch).not.toHaveBeenCalled();
  });

  it('a fresh code after no-credential starts clean', async () => {
    const s = useSignin(
      deps({
        listCredentials: async () => [cred, administratorCred],
        present: async () => ({ outcome: 'refused', refusal: 'no-credential' }),
      }),
    );
    await s.prepareFromLink(ADMIN_LINK);
    await s.approve();
    expect(s.posted.value).toBe(true);
    await s.prepareFromLink(LINK);
    expect(s.phase.value).toBe('card');
    expect(s.posted.value).toBe(false);
  });

  // The handover rides the same card (#663/#674). What is presented changes;
  // who may unlock, and how the wallet arms, do not.
  describe('the panel handover is unchanged', () => {
    it('a steward presenting Administrator is still offered the unlock line, and arms exactly as before', async () => {
      const present = vi.fn(async () => ({ outcome: 'verified' as const }));
      const arm = vi.fn((_challenge: string, _expiresAt: number) => undefined);
      const answerHandover = vi.fn(async () => undefined);
      const s = useSignin(
        deps({
          // The steward's standing is on their Membership; what they present at
          // this door is their Administrator.
          listCredentials: async () => [stewardCred, financeCred, administratorCred],
          present,
          arm,
          answerHandover,
          now: () => 1_000_000,
        }),
      );
      await s.prepareFromLink(ADMIN_PANEL_LINK);
      expect(s.chosen.value).toBe(administratorCred);
      expect(s.unlockAvailable.value).toBe(true);
      expect(s.unlockOn.value).toBe(true);
      expect(s.view.value?.unlock).toEqual({ sealingKeyFingerprint: 'fp(DVERKEY_EXAMPLE)' });

      await s.approve();
      expect(arm).toHaveBeenCalledTimes(1);
      expect(arm.mock.calls[0]![0]).toBe('c_admin');
      expect(arm.mock.calls[0]![1]).toBeGreaterThan(1_000_000);
      const body = present.mock.calls[0]![1] as Record<string, unknown>;
      expect(body.presentation).toBe('EXPORT:EAdministrator');
      expect(body.armed).toBe(true);
      expect(body).not.toHaveProperty('sealed_passcode');
      expect(answerHandover).toHaveBeenCalledWith('https://id.example.nz/login/app/present', 'c_admin', 'EHa');
      expect(s.phase.value).toBe('done');
    });

    it('an operator answering with their Membership arms exactly as before', async () => {
      const present = vi.fn(async () => ({ outcome: 'verified' as const }));
      const arm = vi.fn((_challenge: string, _expiresAt: number) => undefined);
      const answerHandover = vi.fn(async () => undefined);
      const s = useSignin(deps({ listCredentials: async () => [financeCred, stewardCred], present, arm, answerHandover }));
      await s.prepareFromLink(ADMIN_PANEL_LINK);
      expect(s.chosen.value).toBe(stewardCred);
      expect(s.unlockAvailable.value).toBe(true);
      await s.approve();
      expect(arm).toHaveBeenCalledTimes(1);
      const body = present.mock.calls[0]![1] as Record<string, unknown>;
      expect(body.presentation).toBe('EXPORT:ECred');
      expect(body.armed).toBe(true);
      expect(answerHandover).toHaveBeenCalledWith('https://id.example.nz/login/app/present', 'c_admin', 'EHa');
    });

    it('an administrator who is not a steward is offered no unlock line and arms nothing', async () => {
      // Administrator grants the panel, not signing (idss ADR 0286 d.2): holding
      // it does not make its holder a steward.
      const present = vi.fn(async () => ({ outcome: 'verified' as const }));
      const arm = vi.fn((_challenge: string, _expiresAt: number) => undefined);
      const s = useSignin(deps({ listCredentials: async () => [cred, administratorCred], present, arm }));
      await s.prepareFromLink(ADMIN_PANEL_LINK);
      expect(s.chosen.value).toBe(administratorCred);
      expect(s.unlockAvailable.value).toBe(false);
      expect(s.view.value?.unlock).toBeNull();
      await s.approve();
      expect(arm).not.toHaveBeenCalled();
      const body = present.mock.calls[0]![1] as Record<string, unknown>;
      expect(body).not.toHaveProperty('armed');
    });

    it.each([
      [
        'revoked',
        { sad: stewardCred.sad, status: { s: '1', et: 'rev' } } as HeldCredential,
      ],
      [
        'of a schema the door did not ask for',
        { sad: { ...stewardCred.sad, s: 'ESomeOtherCommunity' } } as HeldCredential,
      ],
      [
        'a komiti credential that claims the role',
        { sad: { d: 'EKomiti', s: 'ECo', a: { i: 'EHa', committee: 'finance', role: 'operator' } } } as HeldCredential,
      ],
    ])("an administrator's operator standing does not count when it is %s", async (_case, notStanding) => {
      const arm = vi.fn((_challenge: string, _expiresAt: number) => undefined);
      const s = useSignin(deps({ listCredentials: async () => [notStanding, administratorCred], arm }));
      await s.prepareFromLink(ADMIN_PANEL_LINK);
      expect(s.chosen.value).toBe(administratorCred);
      expect(s.unlockAvailable.value).toBe(false);
      await s.approve();
      expect(arm).not.toHaveBeenCalled();
    });

    it('when a Membership is presented, its own role decides — as it always did', async () => {
      // A door that names no credential (a gateway that predates `cred=`): the
      // first Membership is presented, and a second credential the wallet also
      // holds never lends it a steward's standing.
      const alsoHeld: HeldCredential = {
        sad: { d: 'EOtherOperator', s: 'EMe', i: 'ECommunity', a: { i: 'EHa', role: 'operator' } },
      };
      const s = useSignin(deps({ listCredentials: async () => [cred, alsoHeld] }));
      await s.prepareFromLink(PANEL_LINK);
      expect(s.chosen.value).toBe(cred);
      expect(s.unlockAvailable.value).toBe(false);
    });

    it("a steward's standing is never read off someone else's credential", async () => {
      const someoneElses: HeldCredential = {
        sad: { d: 'EOther', s: 'EMe', i: 'ECommunity', a: { i: 'ESomeoneElse', role: 'operator' } },
      };
      const s = useSignin(deps({ listCredentials: async () => [someoneElses, cred, administratorCred] }));
      await s.prepareFromLink(ADMIN_PANEL_LINK);
      expect(s.unlockAvailable.value).toBe(false);
    });
  });
});
