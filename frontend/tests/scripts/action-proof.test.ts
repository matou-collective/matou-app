import { describe, it, expect } from 'vitest';
import {
  PROOF_VERSION,
  buildProofMessage,
  proofMessageBytes,
  makeActionProof,
  type ActionProofInput,
} from '../../src/lib/keri/actionProof';

/**
 * These vectors PIN the wire format. The Go peer-side verifier (#19) must
 * reconstruct byte-for-byte identical messages from object fields. If a change
 * here is intentional, bump PROOF_VERSION and update the verifier in lockstep.
 */
const SIGNOFF: ActionProofInput = {
  action: 'contribution_signoff',
  subject: 'EContribution0000000000000000000000000000000',
  value: 'signed_off',
  dt: '2026-08-14T04:07:43.000Z',
};

describe('buildProofMessage', () => {
  it('produces the canonical newline-delimited layout', () => {
    expect(buildProofMessage(SIGNOFF)).toBe(
      [
        'matou-proof/v1',
        'contribution_signoff',
        'EContribution0000000000000000000000000000000',
        'signed_off',
        '2026-08-14T04:07:43.000Z',
      ].join('\n'),
    );
  });

  it('is a stable golden vector (mirror this exact string in the Go verifier)', () => {
    expect(buildProofMessage(SIGNOFF)).toBe(
      'matou-proof/v1\ncontribution_signoff\nEContribution0000000000000000000000000000000\nsigned_off\n2026-08-14T04:07:43.000Z',
    );
  });

  it('golden vector for each action type', () => {
    expect(
      buildProofMessage({ action: 'contribution_reward', subject: 'ECx', value: 'rewarded', dt: '2026-01-02T03:04:05Z' }),
    ).toBe('matou-proof/v1\ncontribution_reward\nECx\nrewarded\n2026-01-02T03:04:05Z');
    expect(
      buildProofMessage({ action: 'plan_signoff', subject: 'plan-1', value: 'signed_off', dt: '2026-01-02T03:04:05Z' }),
    ).toBe('matou-proof/v1\nplan_signoff\nplan-1\nsigned_off\n2026-01-02T03:04:05Z');
    expect(
      buildProofMessage({ action: 'project_completion', subject: 'proj-1', value: 'completed', dt: '2026-01-02T03:04:05Z' }),
    ).toBe('matou-proof/v1\nproject_completion\nproj-1\ncompleted\n2026-01-02T03:04:05Z');
  });

  it('is deterministic', () => {
    expect(buildProofMessage(SIGNOFF)).toBe(buildProofMessage({ ...SIGNOFF }));
  });

  it('rejects empty fields', () => {
    expect(() => buildProofMessage({ ...SIGNOFF, subject: '' })).toThrow(/subject/);
    expect(() => buildProofMessage({ ...SIGNOFF, value: '' })).toThrow(/value/);
  });

  it('rejects newline-bearing fields (would break the layout)', () => {
    expect(() => buildProofMessage({ ...SIGNOFF, value: 'signed\noff' })).toThrow(/newline/);
  });
});

describe('proofMessageBytes', () => {
  it('is the UTF-8 encoding of the canonical message', () => {
    expect(proofMessageBytes(SIGNOFF)).toEqual(new TextEncoder().encode(buildProofMessage(SIGNOFF)));
  });
});

describe('makeActionProof', () => {
  it('assembles a versioned envelope carrying the signed fields', () => {
    const proof = makeActionProof(SIGNOFF, 'EAsignerAID', '0Bsignaturebytes');
    expect(proof).toEqual({
      v: PROOF_VERSION,
      action: 'contribution_signoff',
      subject: SIGNOFF.subject,
      value: 'signed_off',
      dt: SIGNOFF.dt,
      aid: 'EAsignerAID',
      sig: '0Bsignaturebytes',
    });
  });

  it('requires a signer aid and signature', () => {
    expect(() => makeActionProof(SIGNOFF, '', 'sig')).toThrow(/aid/);
    expect(() => makeActionProof(SIGNOFF, 'aid', '')).toThrow(/signature/);
  });
});
