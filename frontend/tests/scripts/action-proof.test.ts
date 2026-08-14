import { describe, it, expect } from 'vitest';
import {
  canonicalDigest,
  signActionProof,
  PROOF_VERSION,
  type SignedDigest,
} from '../../src/lib/keri/actionProof';

// These golden vectors are shared, byte-for-byte, with the backend test
// `backend/internal/keri/actionproof_test.go`. If you change either side you
// MUST change both — the signer (this frontend) and the verifier (Go, deferred
// to #19) must reconstruct the exact same digest from the same fields.

describe('canonicalDigest', () => {
  it('builds the three-part form when no context is given', () => {
    expect(
      canonicalDigest(
        'contribution.sign_off',
        'ECg6npd1vQ5mEnoLrsK7DG72gHJXklSa61Ybh559wZOI',
        '2026-08-14T05:16:49.000Z',
      ),
    ).toBe(
      'contribution.sign_off:ECg6npd1vQ5mEnoLrsK7DG72gHJXklSa61Ybh559wZOI:2026-08-14T05:16:49.000Z',
    );
  });

  it('builds the four-part form when context is given', () => {
    expect(
      canonicalDigest(
        'member.role_change',
        'EBmemberAID000000000000000000000000000000000',
        '2026-08-14T05:16:49.000Z',
        'Operations Steward',
      ),
    ).toBe(
      'member.role_change:EBmemberAID000000000000000000000000000000000:Operations Steward:2026-08-14T05:16:49.000Z',
    );
  });

  it('treats an empty-string context as absent (three-part form)', () => {
    expect(canonicalDigest('contribution.reward', 'SUBJECT', 'DT', '')).toBe(
      'contribution.reward:SUBJECT:DT',
    );
  });
});

describe('signActionProof', () => {
  // A deterministic stub signer — records the digest it was asked to sign so we
  // can assert the envelope binds to exactly that canonical string.
  function stubSigner() {
    const calls: string[] = [];
    const sign = (data: string): Promise<SignedDigest> => {
      calls.push(data);
      return Promise.resolve({
        aid: 'EBsignerAID00000000000000000000000000000000',
        keyIndex: 0,
        verferQb64: 'DKverferPublicKeyQb64Placeholder00000000000',
        sequence: '0',
        signature: 'AAxSignatureQb64Placeholder',
      });
    };
    return { sign, calls };
  }

  it('signs the canonical digest and returns a v1 envelope', async () => {
    const { sign, calls } = stubSigner();
    const proof = await signActionProof(
      sign,
      'contribution.sign_off',
      'ECg6npd1vQ5mEnoLrsK7DG72gHJXklSa61Ybh559wZOI',
      { dt: '2026-08-14T05:16:49.000Z' },
    );

    // The signer saw exactly the canonical digest.
    expect(calls).toEqual([
      'contribution.sign_off:ECg6npd1vQ5mEnoLrsK7DG72gHJXklSa61Ybh559wZOI:2026-08-14T05:16:49.000Z',
    ]);

    expect(proof).toEqual({
      v: PROOF_VERSION,
      action: 'contribution.sign_off',
      subject: 'ECg6npd1vQ5mEnoLrsK7DG72gHJXklSa61Ybh559wZOI',
      dt: '2026-08-14T05:16:49.000Z',
      aid: 'EBsignerAID00000000000000000000000000000000',
      ki: 0,
      s: '0',
      sig: 'AAxSignatureQb64Placeholder',
    });
    // No context key when none was supplied.
    expect('context' in proof).toBe(false);
  });

  it('includes context in both the digest and the envelope when supplied', async () => {
    const { sign, calls } = stubSigner();
    const proof = await signActionProof(
      sign,
      'member.role_change',
      'EBmemberAID000000000000000000000000000000000',
      { dt: '2026-08-14T05:16:49.000Z', context: 'Operations Steward' },
    );

    expect(calls[0]).toBe(
      'member.role_change:EBmemberAID000000000000000000000000000000000:Operations Steward:2026-08-14T05:16:49.000Z',
    );
    expect(proof.context).toBe('Operations Steward');
    expect(proof.action).toBe('member.role_change');
  });

  it('defaults dt to an ISO timestamp when not provided', async () => {
    const { sign } = stubSigner();
    const proof = await signActionProof(sign, 'contribution.reward', 'SUBJECT');
    // ISO-8601 with millis and trailing Z (what Date.toISOString produces).
    expect(proof.dt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });
});
