import { describe, it, expect } from 'vitest';
import { isInitiatorExn, rotationSaidOf, shouldRotateForRound1 } from 'src/lib/keri/multisigRound';

const exn = (i: string, rot: string) => ({ i, a: { smids: ['EADMIN', 'ESTEWARD1'], rmids: ['EADMIN', 'ESTEWARD1', 'EJOINER'], round: 'round-1' }, e: { rot: { d: rot, s: '9' } } });

describe('round-1 dedupe (registration e2e test 5, 2026-09-30)', () => {
  it('the initiator is smids[0]', () => {
    expect(isInitiatorExn(exn('EADMIN', 'EROT'))).toBe(true);
    expect(isInitiatorExn(exn('ESTEWARD1', 'EROT'))).toBe(false);
  });
  it('reads the embedded rotation SAID', () => {
    expect(rotationSaidOf(exn('EADMIN', 'EROT'))).toBe('EROT');
  });
  it('rotates once for the initiator, never for a co-signer forward of the same proposal', () => {
    const handled = new Set<string>();
    expect(shouldRotateForRound1(exn('EADMIN', 'EROT'), handled)).toEqual({ rotate: true, said: 'EROT' });
    handled.add('EROT');
    expect(shouldRotateForRound1(exn('ESTEWARD1', 'EROT'), handled)).toEqual({ rotate: false, said: 'EROT' });
    expect(shouldRotateForRound1(exn('EADMIN', 'EROT'), handled)).toEqual({ rotate: false, said: 'EROT' });
  });
  it('a co-signer forward of an unseen proposal does not rotate either', () => {
    expect(shouldRotateForRound1(exn('ESTEWARD1', 'EROT2'), new Set())).toEqual({ rotate: false, said: 'EROT2' });
  });
});
