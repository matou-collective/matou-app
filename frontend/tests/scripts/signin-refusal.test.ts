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
  NO_CREDENTIAL_TEXT,
  type RefusalKind,
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

// The door's `no-credential` (#683, idss ADR 0289, app-door-golden
// `present.no_credential`): the presented credential is not the one this door
// asks for. A wallet that reads `cred=` should never cause it; when it happens
// it wears the same sentence as the wallet's own no-credential screen.
describe('refusalCopy — no-credential (#683)', () => {
  it('wears the required-credential sentence, with no opener, retry or operator line', () => {
    const c = refusalCopy('no-credential');
    expect(c.kind).toBe('no-credential');
    expect(c.text).toBe('You do not have the required credential to sign into this service');
    expect(c.text).toBe(NO_CREDENTIAL_TEXT);
    expect(c.text.startsWith(REFUSAL_OPENER)).toBe(false);
    // Trying again presents the same credential to the same door.
    expect(c.showTryAgain).toBe(false);
    expect(c.showContact).toBe(false);
  });

  it('is a slug the wallet knows, not one folded to signature', () => {
    expect(normalizeRefusal('no-credential')).toBe('no-credential');
  });
});

// A `revoked` answer when the wallet holds something else this door admits
// (#690): the copy says what happens next, not only what went wrong. The refused
// code is spent, so what happens next rides a fresh one.
describe('refusalCopy — revoked, with a credential to fall back on (#690)', () => {
  const fallback = { revoked: 'Administrator', next: 'Membership' };

  it('names the credential that was revoked, and says trying again signs in with the Membership', () => {
    const c = refusalCopy('revoked', fallback);
    expect(c.kind).toBe('revoked');
    expect(c.text).toBe(
      REFUSAL_OPENER +
        'your Administrator credential has been revoked. ' +
        'Try again with a fresh code from the sign-in page, and you will sign in with your Membership.',
    );
    // It is not the Membership that was revoked, and the copy must not say so.
    expect(c.text).not.toContain('your membership here has been revoked');
  });

  it('keeps the two ways forward the refusal region always had', () => {
    const c = refusalCopy('revoked', fallback);
    expect(c.showTryAgain).toBe(true);
    expect(c.showContact).toBe(true);
  });

  it('names whatever will be presented next — a live credential of the same kind, too', () => {
    expect(refusalCopy('revoked', { revoked: 'Administrator', next: 'Administrator' }).text).toContain(
      'you will sign in with your Administrator.',
    );
  });

  it.each([
    ['none is given', undefined],
    ['none is given (null)', null],
    ['it names nothing to present next', { revoked: 'Administrator', next: '' }],
    ['it names nothing but spaces', { revoked: 'Administrator', next: '   ' }],
  ])('wears the plain revoked sentence when %s', (_case, none) => {
    expect(refusalCopy('revoked', none).text).toBe(REFUSAL_OPENER + 'your membership here has been revoked.');
  });

  it.each([
    ['MATOU Membership Credential', 'your MATOU Membership Credential has been revoked.'],
    ['Finance credential', 'your Finance credential has been revoked.'],
  ])('never says "credential" twice of one whose name already ends with it (%s)', (revoked, sentence) => {
    const text = refusalCopy('revoked', { revoked, next: 'Membership' }).text;
    expect(text).toContain(sentence);
    expect(text.toLowerCase()).not.toContain('credential credential');
  });

  it('speaks of "that credential" when the revoked one has no name', () => {
    expect(refusalCopy('revoked', { revoked: '', next: 'Membership' }).text).toContain(
      'that credential has been revoked. Try again',
    );
  });

  it.each<RefusalKind>([
    'no-membership',
    'untrusted-issuer',
    'signature',
    'wrong-holder',
    'no-credential',
    'records-unreachable',
    'site-unreachable',
    'unknown',
    'spent',
    'expired',
  ])('changes nothing about a %s refusal', (kind) => {
    expect(refusalCopy(kind, fallback)).toEqual(refusalCopy(kind));
  });
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
