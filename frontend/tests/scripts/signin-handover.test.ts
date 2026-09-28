/**
 * The wallet's answer to the panel's request (matou-app #674, idss #1961/#1967).
 * After an armed control-panel sign-in the wallet polls the door for the verkey
 * the panel bound, seals the steward's passcode to THAT verkey once, and posts
 * the ciphertext to the door's seal route. This proves the transport seam
 * directly — poll → seal → post, and the give-up paths — with a fake sealer and
 * a fake door, no signify-ts and no live bridge.
 *
 * The wire is pinned by the sign-in bridge's APP DOOR golden `sign_in_armed_
 * handover` (copied from idss `internal/idp/testdata/app-door-golden.json`), so
 * a drift on either side reds this test and neither repo guesses the wire.
 */
import { describe, it, expect, vi } from 'vitest';
import { runHandover, handoverKeyUrl, handoverSealUrl, type HandoverDeps } from 'src/lib/signin/handover';
import golden from './fixtures/app-door/app-door-golden.json';

const PRESENT_URL = golden.ask.response.present_url;
const H = golden.sign_in_armed_handover;
const PANEL_KEY = H.wallet_key.answered.body.sealing_key;
const CHALLENGE = 'nonce-PANEL';
const AID = 'Etama';

/** A JSON Response with the golden's HTTP code + body. */
function json(spec: { status: number; body: unknown }): Response {
  return new Response(JSON.stringify(spec.body), { status: spec.status });
}

/** A fetch fake that routes by path and records every call. */
function makeFetch(
  handler: (url: string, init: RequestInit | undefined) => Response,
): typeof fetch & { calls: { url: string; init?: RequestInit }[] } {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fn = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    return Promise.resolve(handler(url, init));
  });
  return Object.assign(fn as unknown as typeof fetch, { calls });
}

/** Deps with an instant sleep and a recording sealer, over an injected fetch. */
function deps(fetchImpl: typeof fetch, overrides: Partial<HandoverDeps> = {}): HandoverDeps & { sealed: string[] } {
  const sealed: string[] = [];
  const seal = vi.fn(async (_challenge: string, verkey: string) => {
    sealed.push(verkey);
    return `sealed(${verkey})`;
  });
  return Object.assign({ seal, fetchImpl, sleep: async () => undefined, ...overrides }, { sealed });
}

describe('handover route URLs', () => {
  it('derives the wallet key + seal routes from present_url, never from door', () => {
    expect(handoverKeyUrl(PRESENT_URL, CHALLENGE)).toBe(
      'https://id.whakatohea.idss.nz/login/app/handover/key?c=nonce-PANEL',
    );
    expect(handoverSealUrl(PRESENT_URL)).toBe('https://id.whakatohea.idss.nz/login/app/handover/seal');
  });
});

describe('runHandover — the wallet answers the panel', () => {
  it('polls for the verkey, seals to it, and posts the box once (AC2)', async () => {
    let keyPolls = 0;
    const sealPosts: Record<string, unknown>[] = [];
    const fetchImpl = makeFetch((url, init) => {
      if (url.includes('/handover/key')) {
        // The panel has not bound yet on the first poll, then it binds.
        keyPolls++;
        return keyPolls === 1 ? json({ status: 200, body: {} }) : json(H.wallet_key.answered);
      }
      sealPosts.push(JSON.parse(init!.body as string));
      return json(H.wallet_seal.answered);
    });
    const d = deps(fetchImpl);

    await runHandover(PRESENT_URL, CHALLENGE, AID, d);

    // Sealed to the verkey the PANEL bound, not the sign-in code's ek=.
    expect(d.sealed).toEqual([PANEL_KEY]);
    // Posted the box exactly once, to the seal route, snake_case.
    expect(sealPosts).toHaveLength(1);
    expect(sealPosts[0]).toEqual({
      challenge_id: CHALLENGE,
      aid: AID,
      sealed_passcode: `sealed(${PANEL_KEY})`,
    });
    const sealCall = fetchImpl.calls.find((c) => c.url.includes('/handover/seal'));
    expect(sealCall?.url).toBe(handoverSealUrl(PRESENT_URL));
    expect(sealCall?.init?.method).toBe('POST');
  });

  it('the passcode leaves only in the POST body — never on any URL (AC7)', async () => {
    const fetchImpl = makeFetch((url, init) => {
      if (url.includes('/handover/key')) return json(H.wallet_key.answered);
      void init;
      return json(H.wallet_seal.answered);
    });
    await runHandover(PRESENT_URL, CHALLENGE, AID, deps(fetchImpl));
    // No call's URL carries the cipher; the key poll carries only the challenge
    // nonce as ?c=, never a secret.
    for (const call of fetchImpl.calls) {
      expect(call.url).not.toContain('sealed(');
      expect(call.url).not.toContain('sealed_passcode');
    }
  });

  it('seals nothing when the panel never binds — gives up after the poll budget', async () => {
    // Every poll answers empty ({}) — the panel was backgrounded or never landed.
    const fetchImpl = makeFetch((url) => {
      if (url.includes('/handover/key')) return json({ status: 200, body: {} });
      throw new Error('the seal route must never be reached');
    });
    const d = deps(fetchImpl);
    await runHandover(PRESENT_URL, CHALLENGE, AID, d);
    expect(d.sealed).toEqual([]);
    // It polled a bounded number of times and posted no box.
    expect(fetchImpl.calls.every((c) => c.url.includes('/handover/key'))).toBe(true);
    expect(fetchImpl.calls.length).toBeGreaterThan(1);
  });

  it('seals nothing on a dead or unknown challenge (non-200 key route)', async () => {
    const fetchImpl = makeFetch((url) => {
      if (url.includes('/handover/key')) return json({ status: 410, body: { status: 'expired' } });
      throw new Error('the seal route must never be reached');
    });
    const d = deps(fetchImpl);
    await runHandover(PRESENT_URL, CHALLENGE, AID, d);
    expect(d.sealed).toEqual([]);
  });

  it('posts no box when the sealer yields nothing (a locked seat / spent arming)', async () => {
    let sealPosts = 0;
    const fetchImpl = makeFetch((url) => {
      if (url.includes('/handover/key')) return json(H.wallet_key.answered);
      sealPosts++;
      return json(H.wallet_seal.answered);
    });
    // The live sealer returns null: the seat locked between approve and the
    // request, or the arming was already consumed.
    const d = deps(fetchImpl, { seal: async () => null });
    await runHandover(PRESENT_URL, CHALLENGE, AID, d);
    expect(sealPosts).toBe(0);
  });

  it('never throws when the door is unreachable on the key poll', async () => {
    const fetchImpl = Object.assign(
      vi.fn(async () => {
        throw new TypeError('Failed to fetch');
      }),
      { calls: [] },
    ) as unknown as typeof fetch;
    const d = deps(fetchImpl);
    await expect(runHandover(PRESENT_URL, CHALLENGE, AID, d)).resolves.toBeUndefined();
    expect(d.sealed).toEqual([]);
  });

  it('never throws when the seal post fails after sealing', async () => {
    const fetchImpl = makeFetch((url) => {
      if (url.includes('/handover/key')) return json(H.wallet_key.answered);
      throw new TypeError('Failed to fetch');
    });
    const d = deps(fetchImpl);
    await expect(runHandover(PRESENT_URL, CHALLENGE, AID, d)).resolves.toBeUndefined();
    // It did seal (the arming is single-use and now spent) but the post threw.
    expect(d.sealed).toEqual([PANEL_KEY]);
  });
});
