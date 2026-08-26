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
  space: 'bafyreispace000000000000000000000000000000000000000000000',
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
        'bafyreispace000000000000000000000000000000000000000000000',
        'signed_off',
        '2026-08-14T04:07:43.000Z',
      ].join('\n'),
    );
  });

  it('is a stable golden vector (mirror this exact string in the Go verifier)', () => {
    expect(buildProofMessage(SIGNOFF)).toBe(
      'matou-proof/v1\ncontribution_signoff\nEContribution0000000000000000000000000000000\nbafyreispace000000000000000000000000000000000000000000000\nsigned_off\n2026-08-14T04:07:43.000Z',
    );
  });

  it('golden vector for each action type', () => {
    expect(
      buildProofMessage({ action: 'contribution_reward', subject: 'ECx', space: 'sp1', value: 'rewarded', dt: '2026-01-02T03:04:05Z' }),
    ).toBe('matou-proof/v1\ncontribution_reward\nECx\nsp1\nrewarded\n2026-01-02T03:04:05Z');
    expect(
      buildProofMessage({ action: 'plan_signoff', subject: 'plan-1', space: 'sp1', value: 'signed_off', dt: '2026-01-02T03:04:05Z' }),
    ).toBe('matou-proof/v1\nplan_signoff\nplan-1\nsp1\nsigned_off\n2026-01-02T03:04:05Z');
    expect(
      buildProofMessage({ action: 'project_completion', subject: 'proj-1', space: 'sp1', value: 'completed', dt: '2026-01-02T03:04:05Z' }),
    ).toBe('matou-proof/v1\nproject_completion\nproj-1\nsp1\ncompleted\n2026-01-02T03:04:05Z');
  });

  it('binds the space id — same tuple in another space signs differently', () => {
    const other = buildProofMessage({ ...SIGNOFF, space: 'bafyreiotherspace' });
    expect(other).not.toBe(buildProofMessage(SIGNOFF));
  });

  it('is deterministic', () => {
    expect(buildProofMessage(SIGNOFF)).toBe(buildProofMessage({ ...SIGNOFF }));
  });

  it('rejects empty fields', () => {
    expect(() => buildProofMessage({ ...SIGNOFF, subject: '' })).toThrow(/subject/);
    expect(() => buildProofMessage({ ...SIGNOFF, space: '' })).toThrow(/space/);
    expect(() => buildProofMessage({ ...SIGNOFF, value: '' })).toThrow(/value/);
  });

  it('rejects line-break-bearing fields (would break the layout)', () => {
    expect(() => buildProofMessage({ ...SIGNOFF, value: 'signed\noff' })).toThrow(/line break/);
    expect(() => buildProofMessage({ ...SIGNOFF, value: 'signed\roff' })).toThrow(/line break/);
  });
});

describe('proofMessageBytes', () => {
  it('is the UTF-8 encoding of the canonical message', () => {
    expect(proofMessageBytes(SIGNOFF)).toEqual(new TextEncoder().encode(buildProofMessage(SIGNOFF)));
  });

  it('pins UTF-8 bytes for non-ASCII content (hex golden vector for the Go verifier)', () => {
    // Subject carrying a macron (te reo): "Mātou". The Go verifier MUST
    // produce these exact bytes — ā is 0xC4 0x81 in UTF-8, never NFD or
    // latin-1. Layout: v\naction\nsubject\nspace\nvalue\ndt
    const bytes = proofMessageBytes({
      action: 'plan_signoff',
      subject: 'Mātou',
      space: 'sp',
      value: 'signed_off',
      dt: '2026-01-02T03:04:05Z',
    });
    const hex = Array.from(bytes)
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
    expect(hex).toBe(
      '6d61746f752d70726f6f662f76310a' + // "matou-proof/v1\n"
        '706c616e5f7369676e6f66660a' + // "plan_signoff\n"
        '4dc481746f750a' + // "Mātou\n"  (ā = c4 81)
        '73700a' + // "sp\n"
        '7369676e65645f6f66660a' + // "signed_off\n"
        '323032362d30312d30325430333a30343a30355a', // "2026-01-02T03:04:05Z"
    );
  });
});

describe('makeActionProof', () => {
  it('assembles a versioned envelope carrying the signed fields', () => {
    const proof = makeActionProof(SIGNOFF, 'EAsignerAID', '0Bsignaturebytes');
    expect(proof).toEqual({
      v: PROOF_VERSION,
      action: 'contribution_signoff',
      subject: SIGNOFF.subject,
      space: SIGNOFF.space,
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
