/**
 * The wallet's refusal copy contract (idss #1492 stories 25/27/28, WS-A2r). The
 * sentence and tails must match the sign-in page verbatim, the two outage/
 * network lines wear their own words, and an unknown slug degrades to the
 * least-specific tail rather than leaking or rendering blank.
 */
import { describe, it, expect } from 'vitest';
import {
  refusalCopy,
  normalizeRefusal,
  REFUSAL_OPENER,
  RECORDS_UNREACHABLE_TEXT,
  SITE_UNREACHABLE_TEXT,
  STALE_CODE_TEXT,
} from 'src/lib/signin/refusal';

describe('refusalCopy — verification refusals', () => {
  it('no-membership wears the operator-add tail', () => {
    const c = refusalCopy('no-membership');
    expect(c.text).toBe(
      REFUSAL_OPENER + "you don't hold a membership from this community yet. Ask your operator to add you.",
    );
    expect(c.showTryAgain).toBe(true);
    expect(c.showContact).toBe(true);
  });

  it('revoked, untrusted-issuer wear their own tails', () => {
    expect(refusalCopy('revoked').text).toBe(REFUSAL_OPENER + 'your membership here has been revoked.');
    expect(refusalCopy('untrusted-issuer').text).toBe(
      REFUSAL_OPENER + "that credential wasn't issued by this community.",
    );
  });

  it('signature and wrong-holder share one tail (holder mismatch is not distinguished)', () => {
    const sig = refusalCopy('signature');
    const holder = refusalCopy('wrong-holder');
    expect(sig.text).toBe(REFUSAL_OPENER + "that approval didn't match this sign-in.");
    expect(holder.text).toBe(sig.text);
  });

  it('an unknown slug degrades to the signature tail', () => {
    const c = refusalCopy('some-new-reason');
    expect(c.kind).toBe('signature');
    expect(c.text).toBe(REFUSAL_OPENER + "that approval didn't match this sign-in.");
  });
});

describe('refusalCopy — the outage and network lines', () => {
  it('records-unreachable has no opener and no operator line', () => {
    const c = refusalCopy('records-unreachable');
    expect(c.text).toBe(RECORDS_UNREACHABLE_TEXT);
    expect(c.text.startsWith(REFUSAL_OPENER)).toBe(false);
    expect(c.showTryAgain).toBe(true);
    expect(c.showContact).toBe(false);
  });

  it('site-unreachable is the wallet-only network line', () => {
    const c = refusalCopy('site-unreachable');
    expect(c.text).toBe(SITE_UNREACHABLE_TEXT);
    expect(c.showContact).toBe(false);
  });
});

describe('refusalCopy — the stale-code lines (#574)', () => {
  it.each(['unknown', 'spent', 'expired'] as const)(
    '%s wears its own stale-code line — no opener, no operator line',
    (kind) => {
      const c = refusalCopy(kind);
      expect(c.kind).toBe(kind);
      expect(c.text).toBe(STALE_CODE_TEXT[kind]);
      // The credential is fine; a fresh code fixes it, so no verification opener
      // and no "contact your operator" line.
      expect(c.text.startsWith(REFUSAL_OPENER)).toBe(false);
      expect(c.showTryAgain).toBe(true);
      expect(c.showContact).toBe(false);
    },
  );
});

describe('normalizeRefusal', () => {
  it('passes known slugs and folds the rest to signature', () => {
    expect(normalizeRefusal('revoked')).toBe('revoked');
    expect(normalizeRefusal('REVOKED')).toBe('revoked');
    expect(normalizeRefusal(undefined)).toBe('signature');
    expect(normalizeRefusal('garbled')).toBe('signature');
  });

  it('passes the challenge-lifecycle slugs (#574)', () => {
    expect(normalizeRefusal('unknown')).toBe('unknown');
    expect(normalizeRefusal('spent')).toBe('spent');
    expect(normalizeRefusal('expired')).toBe('expired');
  });
});
