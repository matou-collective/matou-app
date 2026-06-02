import { describe, it, expect } from 'vitest';
import { isLikelyCredentialSaid } from '../../src/lib/keri/said';

// A real Blake3-256 ACDC SAID in qb64 is 44 chars (e.g. the membership schema SAID).
const REAL_SAID = 'ECg6npd1vQ5mEnoLrsK7DG72gHJXklSa61Ybh559wZOI';

describe('isLikelyCredentialSaid', () => {
  it('accepts a real 44-char qb64 SAID', () => {
    expect(isLikelyCredentialSaid(REAL_SAID)).toBe(true);
  });

  it('rejects the "pending" placeholder written before issuance', () => {
    // Root cause of the GET /credentials/pending 500: this placeholder was
    // passed straight to KERIA revoke instead of triggering a credential lookup.
    expect(isLikelyCredentialSaid('pending')).toBe(false);
  });

  it('rejects empty string', () => {
    expect(isLikelyCredentialSaid('')).toBe(false);
  });

  it('rejects undefined and null', () => {
    expect(isLikelyCredentialSaid(undefined)).toBe(false);
    expect(isLikelyCredentialSaid(null)).toBe(false);
  });

  it('rejects a string of the wrong length', () => {
    expect(isLikelyCredentialSaid('E' + 'a'.repeat(20))).toBe(false);
  });

  it('rejects a 44-char string with non-base64url characters', () => {
    expect(isLikelyCredentialSaid('E' + '!'.repeat(43))).toBe(false);
  });
});
