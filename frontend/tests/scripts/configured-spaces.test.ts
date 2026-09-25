/**
 * resolveConfiguredSpaces — where a joining member's three space IDs come from
 * (issue #645). On IDSS they ride in the descriptor's `anysync` block; on any
 * other backend they come from orgConfig.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

// A plain, per-test-swappable implementation (mirrors the mutable-knob mocking
// the WelcomeOverlay tests use) rather than a reused vi.fn — a vi.fn whose
// implementation throws is surfaced by vitest even when the caller catches it.
let descriptorImpl: () => Promise<unknown>;
let descriptorCalls = 0;
vi.mock('src/lib/clientConfig', () => ({
  getCommunityDescriptor: () => {
    descriptorCalls += 1;
    return descriptorImpl();
  },
}));

import { resolveConfiguredSpaces } from 'src/lib/spaces/configuredSpaces';
import type { OrgConfig } from 'src/api/config';

const RECORDED = {
  communitySpaceId: 'bafy-community',
  readOnlySpaceId: 'bafy-readonly',
  adminSpaceId: 'bafy-admin',
};

function idssDescriptor(anysync: Record<string, unknown> | undefined) {
  return {
    version: '1.1',
    backend_kind: 'idss',
    admins: [],
    schemas: {},
    ...(anysync ? { anysync } : {}),
  };
}

describe('resolveConfiguredSpaces (#645)', () => {
  beforeEach(() => {
    descriptorCalls = 0;
    descriptorImpl = async () => idssDescriptor({});
  });

  it('reads the three IDs from the IDSS descriptor anysync block', async () => {
    descriptorImpl = async () => idssDescriptor({ ...RECORDED });
    const spaces = await resolveConfiguredSpaces(null, true);
    expect(spaces).toEqual({ ...RECORDED, idssAwaitingSpaces: false });
  });

  it('flags the founding-ceremony state when the IDSS descriptor records no spaces', async () => {
    descriptorImpl = async () => idssDescriptor({});
    const spaces = await resolveConfiguredSpaces(null, true);
    expect(spaces.idssAwaitingSpaces).toBe(true);
    expect(spaces.communitySpaceId).toBeUndefined();
  });

  it('treats a partial set as no spaces (idss records the three together or not at all)', async () => {
    descriptorImpl = async () => idssDescriptor({ communitySpaceId: 'only-one' });
    const spaces = await resolveConfiguredSpaces(null, true);
    expect(spaces.idssAwaitingSpaces).toBe(true);
  });

  it('falls back to orgConfig if the IDSS descriptor is unreachable', async () => {
    descriptorImpl = async () => {
      throw new Error('offline');
    };
    const orgConfig = { communitySpaceId: 'cs', readOnlySpaceId: 'ro', adminSpaceId: 'adm' } as OrgConfig;
    const spaces = await resolveConfiguredSpaces(orgConfig, true);
    expect(spaces).toEqual({
      communitySpaceId: 'cs',
      readOnlySpaceId: 'ro',
      adminSpaceId: 'adm',
      idssAwaitingSpaces: false,
    });
  });

  it('reads orgConfig on a non-IDSS backend and never touches the descriptor', async () => {
    const orgConfig = { communitySpaceId: 'cs', readOnlySpaceId: 'ro', adminSpaceId: 'adm' } as OrgConfig;
    const spaces = await resolveConfiguredSpaces(orgConfig, false);
    expect(spaces).toEqual({
      communitySpaceId: 'cs',
      readOnlySpaceId: 'ro',
      adminSpaceId: 'adm',
      idssAwaitingSpaces: false,
    });
    expect(descriptorCalls).toBe(0);
  });
});
