/**
 * Posting the presentation and reading the verdict (idss #1492 stories
 * 14/16/28, ADR 0236 §2). A 2xx is VERIFIED; a non-2xx carries the door's
 * refusal slug; a thrown fetch (no response) is the wallet-only site-unreachable
 * case, never mistaken for a refusal.
 */
import { describe, it, expect, vi } from 'vitest';
import { presentToDoor, boundMessage, PRESENT_PATH } from 'src/lib/signin/present';

const body = { aid: 'EHa', challengeID: 'c1', response: '0Bsig', presentation: 'acdc+iss' };

describe('boundMessage', () => {
  it('names the door, the AID and the nonce (ADR 0236 §5)', () => {
    expect(boundMessage('https://id.example.nz/login', 'EHa', 'c_3f9')).toBe(
      'idss-idp:https://id.example.nz/login:EHa:c_3f9',
    );
  });
});

describe('presentToDoor', () => {
  it('posts to <door>/signin/present and returns verified on 2xx', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
    const verdict = await presentToDoor('https://id.example.nz/', body, fetchImpl as unknown as typeof fetch);
    expect(verdict).toEqual({ outcome: 'verified' });
    // trailing slash trimmed, present path appended
    expect(fetchImpl).toHaveBeenCalledWith('https://id.example.nz' + PRESENT_PATH, expect.objectContaining({
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    }));
    const sent = JSON.parse((fetchImpl.mock.calls[0]![1] as RequestInit).body as string);
    expect(sent).toEqual(body);
  });

  it('maps a 403 with a refusal slug to a refused verdict', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ ok: false, refusal: 'revoked' }), { status: 403 }));
    const verdict = await presentToDoor('https://d.nz', body, fetchImpl as unknown as typeof fetch);
    expect(verdict).toEqual({ outcome: 'refused', refusal: 'revoked' });
  });

  it('a non-2xx with an unreadable body still refuses (least-specific tail)', async () => {
    const fetchImpl = vi.fn(async () => new Response('not json', { status: 403 }));
    const verdict = await presentToDoor('https://d.nz', body, fetchImpl as unknown as typeof fetch);
    expect(verdict).toEqual({ outcome: 'refused', refusal: 'signature' });
  });

  it('a thrown fetch is site-unreachable, not a refusal', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError('Failed to fetch');
    });
    const verdict = await presentToDoor('https://d.nz', body, fetchImpl as unknown as typeof fetch);
    expect(verdict).toEqual({ outcome: 'site-unreachable' });
  });
});
