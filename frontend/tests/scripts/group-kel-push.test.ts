import { describe, it, expect } from 'vitest';
import { selectGroupKelPushTargets } from 'src/lib/keri/groupKelPush';

const GROUP = 'ELeDMgroupAID';
const ADMIN = 'EADMINpersonal';
const STEWARD = 'ESTEWARDpersonal';
const OTHER = 'EOTHERpersonal';

describe('selectGroupKelPushTargets (issue #63)', () => {
  it('returns every other member when the steward is acting', () => {
    // Steward just anchored a group ixn → push to the admin (the other member)
    // so the admin does not re-anchor at the same sn and fork the group KEL.
    expect(
      selectGroupKelPushTargets([ADMIN, STEWARD], GROUP, STEWARD),
    ).toEqual([ADMIN]);
  });

  it('returns every other member when the admin is acting', () => {
    expect(
      selectGroupKelPushTargets([ADMIN, STEWARD], GROUP, ADMIN),
    ).toEqual([STEWARD]);
  });

  it('excludes the acting member, the group AID, and empty entries', () => {
    expect(
      selectGroupKelPushTargets(
        [ADMIN, STEWARD, GROUP, '', null, undefined, OTHER],
        GROUP,
        ADMIN,
      ),
    ).toEqual([STEWARD, OTHER]);
  });

  it('dedupes repeated member AIDs', () => {
    expect(
      selectGroupKelPushTargets([STEWARD, STEWARD, OTHER], GROUP, ADMIN),
    ).toEqual([STEWARD, OTHER]);
  });

  it('still targets all non-self members when the acting AID is unknown', () => {
    // If the group hab does not expose its mhab, we push to every member
    // (a redundant self-push is a harmless idempotent no-op).
    expect(
      selectGroupKelPushTargets([ADMIN, STEWARD], GROUP),
    ).toEqual([ADMIN, STEWARD]);
  });

  it('returns empty when the acting member is the only member', () => {
    expect(selectGroupKelPushTargets([ADMIN], GROUP, ADMIN)).toEqual([]);
  });

  it('returns empty for an empty member list', () => {
    expect(selectGroupKelPushTargets([], GROUP, ADMIN)).toEqual([]);
  });
});
