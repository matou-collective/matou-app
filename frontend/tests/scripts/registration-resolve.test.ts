import { describe, it, expect } from 'vitest';
import {
  buildOobiCandidates,
  buildSenderOobiFields,
  parseFailedRegistrationNotification,
  nextResolveDelayMs,
  shouldAttemptResolve,
  isApplicantUnreachable,
  UNREACHABLE_AFTER_MS,
  type ResolveAttemptState,
} from '../../src/lib/registrationResolve';

const AID = 'EFS4GiZ4qQ_FB4VFpSkAUQVynhJ0vJyUdVucLp3U7tl9';
const CESR = 'http://awa.matou.nz:3902';
const AGENT_OOBI = `http://awa.matou.nz:3902/oobi/${AID}/agent/EP8my4Zv5wn_S13pwAyTpWl4TMTSWK0KcjcJyr2gnYyT`;

describe('buildOobiCandidates', () => {
  it('puts the bare OOBI first, the recorded agent OOBI last', () => {
    const candidates = buildOobiCandidates({
      applicantAid: AID,
      recordedOobi: AGENT_OOBI,
      cesrUrl: CESR,
    });
    expect(candidates[0]).toBe(`${CESR}/oobi/${AID}`);
    expect(candidates[candidates.length - 1]).toBe(AGENT_OOBI);
  });

  it('derives a bare OOBI from the recorded OOBI host when it differs from cesrUrl', () => {
    const foreign = `http://other.example.com:3902/oobi/${AID}/agent/EAgentAgentAgentAgentAgentAgentAgentAgentAgu`;
    const candidates = buildOobiCandidates({
      applicantAid: AID,
      recordedOobi: foreign,
      cesrUrl: CESR,
    });
    expect(candidates).toContain(`http://other.example.com:3902/oobi/${AID}`);
    // bare-from-recorded-host must come before the full agent form
    expect(candidates.indexOf(`http://other.example.com:3902/oobi/${AID}`))
      .toBeLessThan(candidates.indexOf(foreign));
  });

  it('deduplicates when the recorded OOBI is already the bare form', () => {
    const bare = `${CESR}/oobi/${AID}`;
    const candidates = buildOobiCandidates({
      applicantAid: AID,
      recordedOobi: bare,
      cesrUrl: CESR,
    });
    expect(candidates).toEqual([bare]);
  });

  it('works with no recorded OOBI', () => {
    expect(buildOobiCandidates({ applicantAid: AID, cesrUrl: CESR }))
      .toEqual([`${CESR}/oobi/${AID}`]);
  });

  it('works with no cesrUrl (recorded only)', () => {
    const candidates = buildOobiCandidates({ applicantAid: AID, recordedOobi: AGENT_OOBI });
    expect(candidates).toContain(AGENT_OOBI);
    expect(candidates).toContain(`http://awa.matou.nz:3902/oobi/${AID}`);
  });

  it('ignores a malformed recorded OOBI', () => {
    const candidates = buildOobiCandidates({
      applicantAid: AID,
      recordedOobi: 'not a url',
      cesrUrl: CESR,
    });
    expect(candidates).toEqual([`${CESR}/oobi/${AID}`]);
  });

  it('returns empty for missing AID', () => {
    expect(buildOobiCandidates({ applicantAid: '', cesrUrl: CESR })).toEqual([]);
  });

  it('strips a trailing slash from cesrUrl', () => {
    expect(buildOobiCandidates({ applicantAid: AID, cesrUrl: `${CESR}/` }))
      .toEqual([`${CESR}/oobi/${AID}`]);
  });
});

describe('buildSenderOobiFields', () => {
  it('records the bare OOBI as senderOOBI and demotes the agent form to senderAgentOobi', () => {
    expect(buildSenderOobiFields({ prefix: AID, cesrUrl: CESR, agentOobi: AGENT_OOBI })).toEqual({
      senderOOBI: `${CESR}/oobi/${AID}`,
      senderAgentOobi: AGENT_OOBI,
    });
  });

  it('strips trailing slashes from cesrUrl', () => {
    expect(buildSenderOobiFields({ prefix: AID, cesrUrl: `${CESR}/` })).toEqual({
      senderOOBI: `${CESR}/oobi/${AID}`,
    });
  });

  it('derives the bare form from the agent OOBI host when cesrUrl is missing', () => {
    expect(buildSenderOobiFields({ prefix: AID, agentOobi: AGENT_OOBI })).toEqual({
      senderOOBI: `http://awa.matou.nz:3902/oobi/${AID}`,
      senderAgentOobi: AGENT_OOBI,
    });
  });

  it('omits senderAgentOobi when the agent OOBI is already the bare form', () => {
    const bare = `${CESR}/oobi/${AID}`;
    expect(buildSenderOobiFields({ prefix: AID, cesrUrl: CESR, agentOobi: bare })).toEqual({
      senderOOBI: bare,
    });
  });

  it('falls back to the agent OOBI verbatim when it is unparseable and there is no cesrUrl', () => {
    expect(buildSenderOobiFields({ prefix: AID, agentOobi: 'not a url' })).toEqual({
      senderOOBI: 'not a url',
    });
  });

  it('returns null without a prefix', () => {
    expect(buildSenderOobiFields({ prefix: '', cesrUrl: CESR, agentOobi: AGENT_OOBI })).toBeNull();
  });

  it('returns null with neither cesrUrl nor agentOobi', () => {
    expect(buildSenderOobiFields({ prefix: AID })).toBeNull();
  });
});

describe('parseFailedRegistrationNotification', () => {
  const failedNote = {
    i: 'note-id-1',
    r: false,
    a: {
      r: '/exn/matou/registration/apply/failed',
      d: 'EExnSaid123',
      i: AID,
      a: { name: 'Andrew Weaver', senderOOBI: AGENT_OOBI },
      failed: true,
      waitedSeconds: 7_776_000,
      dt: '2026-08-01T00:00:00.000Z',
    },
  };

  it('parses a dead-letter notification into an expired registration', () => {
    expect(parseFailedRegistrationNotification(failedNote)).toEqual({
      notificationId: 'note-id-1',
      applicantAid: AID,
      applicantName: 'Andrew Weaver',
      exnSaid: 'EExnSaid123',
      waitedSeconds: 7_776_000,
      failedAt: '2026-08-01T00:00:00.000Z',
    });
  });

  it('accepts the IPEX apply failed route', () => {
    const note = { ...failedNote, a: { ...failedNote.a, r: '/exn/ipex/apply/failed' } };
    expect(parseFailedRegistrationNotification(note)?.applicantAid).toBe(AID);
  });

  it('returns null for non-failed routes', () => {
    const note = { ...failedNote, a: { ...failedNote.a, r: '/exn/matou/registration/apply/pending' } };
    expect(parseFailedRegistrationNotification(note)).toBeNull();
  });

  it('returns null for failed routes of unrelated exchanges', () => {
    const note = { ...failedNote, a: { ...failedNote.a, r: '/exn/multisig/rot/failed' } };
    expect(parseFailedRegistrationNotification(note)).toBeNull();
  });

  it('returns null without a sender AID', () => {
    const note = { ...failedNote, a: { ...failedNote.a, i: '' } };
    expect(parseFailedRegistrationNotification(note)).toBeNull();
  });

  it('tolerates missing embedded profile data and duration', () => {
    const note = {
      i: 'note-id-2',
      r: false,
      a: { r: '/exn/matou/registration/apply/failed', d: 'EExnSaid456', i: AID },
    };
    expect(parseFailedRegistrationNotification(note)).toEqual({
      notificationId: 'note-id-2',
      applicantAid: AID,
      exnSaid: 'EExnSaid456',
    });
  });
});

describe('nextResolveDelayMs', () => {
  it('is zero before the first attempt', () => {
    expect(nextResolveDelayMs(0)).toBe(0);
  });

  it('backs off exponentially from 15s', () => {
    expect(nextResolveDelayMs(1)).toBe(15_000);
    expect(nextResolveDelayMs(2)).toBe(30_000);
    expect(nextResolveDelayMs(3)).toBe(60_000);
  });

  it('caps at one hour', () => {
    expect(nextResolveDelayMs(20)).toBe(3_600_000);
    expect(nextResolveDelayMs(1000)).toBe(3_600_000);
  });
});

describe('shouldAttemptResolve', () => {
  const now = 1_000_000_000;

  it('attempts immediately when there is no prior state', () => {
    expect(shouldAttemptResolve(undefined, now)).toBe(true);
  });

  it('never re-attempts once resolved', () => {
    const state: ResolveAttemptState = { attempts: 1, lastAttemptAt: 0, firstSeenAt: 0, resolved: true };
    expect(shouldAttemptResolve(state, now)).toBe(false);
  });

  it('waits out the backoff window', () => {
    const state: ResolveAttemptState = { attempts: 1, lastAttemptAt: now, firstSeenAt: now, resolved: false };
    expect(shouldAttemptResolve(state, now + 14_999)).toBe(false);
    expect(shouldAttemptResolve(state, now + 15_000)).toBe(true);
  });
});

describe('isApplicantUnreachable', () => {
  const firstSeenAt = 0;

  it('is false while attempts are young', () => {
    const state: ResolveAttemptState = { attempts: 3, lastAttemptAt: 1000, firstSeenAt, resolved: false };
    expect(isApplicantUnreachable(state, firstSeenAt + 1000)).toBe(false);
  });

  it('is true after the stale window with repeated failures', () => {
    const state: ResolveAttemptState = { attempts: 10, lastAttemptAt: 1000, firstSeenAt, resolved: false };
    expect(isApplicantUnreachable(state, firstSeenAt + UNREACHABLE_AFTER_MS + 1)).toBe(true);
  });

  it('is false when resolved, regardless of age', () => {
    const state: ResolveAttemptState = { attempts: 10, lastAttemptAt: 1000, firstSeenAt, resolved: true };
    expect(isApplicantUnreachable(state, firstSeenAt + UNREACHABLE_AFTER_MS + 1)).toBe(false);
  });

  it('is false with no state', () => {
    expect(isApplicantUnreachable(undefined, UNREACHABLE_AFTER_MS * 2)).toBe(false);
  });
});
