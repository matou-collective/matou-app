/**
 * Posting the presentation and reading the verdict (idss #1492 stories
 * 14/16/28, ADR 0236 §2). The wire is pinned by the sign-in bridge's APP DOOR
 * golden, copied from idss (`internal/idp/testdata/app-door-golden.json`) — a
 * drift on either side reds this test, so neither repo guesses the wire (#574).
 *
 * The verdict is read from `body.status`, NOT the HTTP 2xx: the bridge answers
 * a refusal with HTTP 200, so trusting the 2xx would tell a member they are
 * signed in when the door refused them. The challenge-lifecycle verdicts ride
 * the HTTP code (404 unknown, 409 spent, 410 expired). A thrown fetch is the
 * wallet-only site-unreachable case, never mistaken for a refusal.
 */
import { describe, it, expect, vi } from 'vitest';
import { presentToDoor, boundMessage, type PresentBody } from 'src/lib/signin/present';
import golden from './fixtures/app-door/app-door-golden.json';

const PRESENT_URL = golden.ask.response.present_url;

const body: PresentBody = golden.present.request;

/** Fulfil a response with the golden's HTTP code + JSON body. */
function respond(spec: { status: number; body: unknown }): typeof fetch {
  return vi.fn(async () => new Response(JSON.stringify(spec.body), { status: spec.status })) as unknown as typeof fetch;
}

describe('boundMessage', () => {
  it('names the door, the AID and the nonce (ADR 0236 §5, golden signed_message)', () => {
    expect(boundMessage('https://id.example.nz/login', 'EHa', 'c_3f9')).toBe(
      'idss-idp:https://id.example.nz/login:EHa:c_3f9',
    );
  });
});

describe('presentToDoor', () => {
  it('posts the snake_case body to the present URL verbatim (no derived path)', async () => {
    const fetchImpl = respond(golden.present.verified);
    const verdict = await presentToDoor(PRESENT_URL, body, fetchImpl);
    expect(verdict).toEqual({ outcome: 'verified' });
    // Posted to the ask's present_url exactly, never `<door>/…`.
    expect(fetchImpl).toHaveBeenCalledWith(
      PRESENT_URL,
      expect.objectContaining({ method: 'POST', headers: { 'Content-Type': 'application/json' } }),
    );
    const sent = JSON.parse((vi.mocked(fetchImpl).mock.calls[0]![1] as RequestInit).body as string);
    expect(sent).toEqual({
      aid: golden.present.request.aid,
      challenge_id: golden.present.request.challenge_id,
      response: golden.present.request.response,
      presentation: golden.present.request.presentation,
    });
    // The body speaks snake_case — never the spike's camelCase `challengeID`.
    expect(sent).not.toHaveProperty('challengeID');
    expect(sent).toHaveProperty('challenge_id');
  });

  it('a 200 verified is the only VERIFIED (golden present.verified)', async () => {
    const verdict = await presentToDoor(PRESENT_URL, body, respond(golden.present.verified));
    expect(verdict).toEqual({ outcome: 'verified' });
  });

  it('a 200 refused reads as refused with its kind, NEVER verified (golden present.refused)', async () => {
    const verdict = await presentToDoor(PRESENT_URL, body, respond(golden.present.refused));
    expect(verdict).toEqual({ outcome: 'refused', refusal: golden.present.refused.body.refusal });
  });

  it('a 200 with no status fails closed to a refusal, never a false verified', async () => {
    const verdict = await presentToDoor(PRESENT_URL, body, respond({ status: 200, body: { ok: true } }));
    expect(verdict).toEqual({ outcome: 'refused', refusal: 'signature' });
  });

  it('a 404 is an unknown challenge (golden present.unknown_challenge)', async () => {
    const verdict = await presentToDoor(PRESENT_URL, body, respond(golden.present.unknown_challenge));
    expect(verdict).toEqual({ outcome: 'refused', refusal: 'unknown' });
  });

  it('a 409 is a spent challenge (golden present.spent_challenge)', async () => {
    const verdict = await presentToDoor(PRESENT_URL, body, respond(golden.present.spent_challenge));
    expect(verdict).toEqual({ outcome: 'refused', refusal: 'spent' });
  });

  it('a 410 is an expired challenge (golden present.expired_challenge)', async () => {
    const verdict = await presentToDoor(PRESENT_URL, body, respond(golden.present.expired_challenge));
    expect(verdict).toEqual({ outcome: 'refused', refusal: 'expired' });
  });

  it('a thrown fetch is site-unreachable, not a refusal', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError('Failed to fetch');
    });
    const verdict = await presentToDoor(PRESENT_URL, body, fetchImpl as unknown as typeof fetch);
    expect(verdict).toEqual({ outcome: 'site-unreachable' });
  });
});
