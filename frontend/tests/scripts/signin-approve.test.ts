/**
 * runApprove ties sign + export + post into one tap (idss #1492 story 14). It
 * signs the door-bound message, exports the credential, and posts the answer;
 * the door's verdict (or a site-unreachable) comes back as data, not a throw.
 */
import { describe, it, expect, vi } from 'vitest';
import { runApprove } from 'src/lib/signin/approve';
import type { PresentBody, PresentVerdict } from 'src/lib/signin/present';

const input = {
  door: 'https://id.example.nz/login',
  present: 'https://id.example.nz/login/app/present',
  challenge: 'c_3f9',
  aid: 'EHa',
  credentialSaid: 'ECred',
};

function fakeDeps(verdict: PresentVerdict) {
  const present = vi.fn(async (_presentUrl: string, _body: PresentBody) => verdict);
  return {
    sign: vi.fn(async (m: string) => `sig(${m})`),
    exportCredential: vi.fn(async (said: string) => `EXPORT:${said}`),
    present,
  };
}

describe('runApprove', () => {
  it('signs the door-bound message, exports the credential, posts the answer', async () => {
    const deps = fakeDeps({ outcome: 'verified' });
    const verdict = await runApprove(input, deps);

    expect(verdict).toEqual({ outcome: 'verified' });
    expect(deps.exportCredential).toHaveBeenCalledWith('ECred');
    expect(deps.sign).toHaveBeenCalledWith('idss-idp:https://id.example.nz/login:EHa:c_3f9');
    // Signed over the DOOR, but POSTed to the ask's present URL (never derived).
    expect(deps.present).toHaveBeenCalledWith('https://id.example.nz/login/app/present', {
      aid: 'EHa',
      challenge_id: 'c_3f9',
      response: 'sig(idss-idp:https://id.example.nz/login:EHa:c_3f9)',
      // the fake export yields no ACDC/iss, so trimPresentation returns it whole
      presentation: 'EXPORT:ECred',
    });
  });

  it('returns a refusal verdict without throwing', async () => {
    const deps = fakeDeps({ outcome: 'refused', refusal: 'revoked' });
    await expect(runApprove(input, deps)).resolves.toEqual({ outcome: 'refused', refusal: 'revoked' });
  });

  it('rides the armed signal — and NO box — in the ONE present body when armed (#674)', async () => {
    // Option B (idss #1967): a panel unlock with the line on arms and posts
    // `armed: true`, never a sealed box. The door mints the handover capability
    // off this signal; the wallet seals later on the handover routes.
    const deps = fakeDeps({ outcome: 'verified' });
    await runApprove({ ...input, armed: true }, deps);
    expect(deps.present).toHaveBeenCalledTimes(1);
    const body = deps.present.mock.calls[0]![1];
    expect(body.armed).toBe(true);
    expect(body).not.toHaveProperty('sealed_passcode');
  });

  it('never puts armed or a box on the wire for an ordinary sign-in (#674)', async () => {
    const deps = fakeDeps({ outcome: 'verified' });
    await runApprove(input, deps);
    expect(deps.present.mock.calls[0]![1]).not.toHaveProperty('armed');
    expect(deps.present.mock.calls[0]![1]).not.toHaveProperty('sealed_passcode');
  });

  it('posts no armed signal when armed is explicitly false (#674)', async () => {
    const deps = fakeDeps({ outcome: 'verified' });
    await runApprove({ ...input, armed: false }, deps);
    expect(deps.present.mock.calls[0]![1]).not.toHaveProperty('armed');
  });
});
