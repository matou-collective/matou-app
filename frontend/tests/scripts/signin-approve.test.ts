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

  it('rides the sealed passcode in the ONE present body when armed (#663)', async () => {
    const deps = fakeDeps({ outcome: 'verified' });
    await runApprove({ ...input, sealedPasscode: '1AAHsealed' }, deps);
    expect(deps.present).toHaveBeenCalledTimes(1);
    expect(deps.present.mock.calls[0]![1]).toMatchObject({ sealed_passcode: '1AAHsealed' });
  });

  it('never puts sealed_passcode on the wire for an ordinary sign-in (#663)', async () => {
    const deps = fakeDeps({ outcome: 'verified' });
    await runApprove(input, deps);
    expect(deps.present.mock.calls[0]![1]).not.toHaveProperty('sealed_passcode');
  });
});
