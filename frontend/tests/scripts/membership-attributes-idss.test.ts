/**
 * The Membership credential body follows the community's schema (live
 * whakatohea-demo 400, 2026-09-25): approving a registration on an IDSS
 * community sent the Mātou body `{communityName: 'MATOU', role: 'Member',
 * joinedAt}` and the gateway refused it — "'Member' is not one of
 * ['operator', 'member']". The IDSS Membership schema (idss
 * internal/credschema membershipSchema()) is CLOSED, so `joinedAt` is also
 * invalid. These pin the IDSS body against that schema's rules and the legacy
 * body as unchanged.
 */
import { describe, it, expect } from 'vitest';
import {
  buildMembershipAttributes,
  idssMembershipRole,
  idssPreferredUsername,
  isValidEmail,
} from '../../src/lib/membershipAttributes';
import { IDSS_STEWARD_APP_ROLE } from '../../src/lib/spaces/steward';

// The IDSS Membership attribute block's rules, transcribed from idss
// internal/credschema/schema.go membershipSchema() + attributeBlock().
// `i` is added by the issuer and `dt` by signify-ts, so they are supplied here.
const IDSS_PROPERTIES = new Set([
  'd', 'i', 'dt', 'communityName', 'preferred_username', 'name', 'email', 'role', 'display',
]);
const IDSS_REQUIRED = ['i', 'dt', 'communityName', 'preferred_username', 'name', 'role'];
const IDSS_ROLES = ['operator', 'member'];

function idssSchemaErrors(body: Record<string, unknown>): string[] {
  const a: Record<string, unknown> = { i: 'EHOLDER', dt: '2026-09-25T00:00:00.000Z', ...body };
  const errs: string[] = [];
  for (const k of Object.keys(a)) if (!IDSS_PROPERTIES.has(k)) errs.push(`additional property ${k}`);
  for (const k of IDSS_REQUIRED) if (!(k in a)) errs.push(`missing ${k}`);
  for (const k of ['communityName', 'preferred_username', 'name', 'role', 'email']) {
    if (k in a && typeof a[k] !== 'string') errs.push(`${k} not a string`);
  }
  if (!IDSS_ROLES.includes(a.role as string)) errs.push(`role ${String(a.role)} not in enum`);
  if ('email' in a && !isValidEmail(a.email as string)) errs.push('email not an email');
  return errs;
}

const IDSS = { kind: 'idss' as const, communityName: 'Whakatōhea Demo' };
const APPLICANT = 'EApplicantAID0000000000000000000000000000000';

describe('IDSS membership attributes', () => {
  it('approve body validates against the IDSS schema: no joinedAt, lowercase role, all required present', () => {
    const body = buildMembershipAttributes(
      IDSS,
      { aid: APPLICANT, name: 'Aroha Te Kani', email: 'aroha@example.org' },
      'Member',
    );
    expect(idssSchemaErrors(body)).toEqual([]);
    expect(body).toEqual({
      communityName: 'Whakatōhea Demo',
      preferred_username: 'aroha',
      name: 'Aroha Te Kani',
      role: 'member',
      email: 'aroha@example.org',
    });
    expect(body).not.toHaveProperty('joinedAt');
    for (const k of ['communityName', 'preferred_username', 'name', 'role']) {
      expect((body[k] as string).length).toBeGreaterThan(0);
    }
  });

  it('the old Mātou body fails the IDSS rules (the live 400)', () => {
    const legacy = buildMembershipAttributes({ kind: 'legacy' }, { aid: APPLICANT }, 'Member');
    expect(idssSchemaErrors(legacy)).toEqual(
      expect.arrayContaining(['additional property joinedAt', 'missing preferred_username', 'role Member not in enum']),
    );
  });

  it('includes email only when it is a valid address', () => {
    const none = buildMembershipAttributes(IDSS, { aid: APPLICANT, name: 'Aroha' }, 'Member');
    expect(none).not.toHaveProperty('email');
    const bad = buildMembershipAttributes(IDSS, { aid: APPLICANT, name: 'Aroha', email: 'not-an-email' }, 'Member');
    expect(bad).not.toHaveProperty('email');
    expect(idssSchemaErrors(bad)).toEqual([]);
    const blank = buildMembershipAttributes(IDSS, { aid: APPLICANT, name: 'Aroha', email: '' }, 'Member');
    expect(blank).not.toHaveProperty('email');
  });

  it('derives preferred_username: explicit handle, else e-mail local part, else name slug, else AID', () => {
    expect(idssPreferredUsername({ aid: APPLICANT, preferredUsername: 'Kahu_01', name: 'X' })).toBe('kahu_01');
    expect(idssPreferredUsername({ aid: APPLICANT, name: 'Z', email: 'Mere.P+x@example.org' })).toBe('mere.px');
    expect(idssPreferredUsername({ aid: APPLICANT, name: '  Hōne  Te Rangi! ' })).toBe('hone-te-rangi');
    expect(idssPreferredUsername({ aid: APPLICANT, name: '!!!' })).toBe('eapplica');
    expect(idssPreferredUsername({ aid: APPLICANT })).toBe('eapplica');
  });

  it('name falls back to the handle so it is never empty', () => {
    const body = buildMembershipAttributes(IDSS, { aid: APPLICANT, name: '   ' }, 'Member');
    expect(body.name).toBe('eapplica');
    expect(idssSchemaErrors(body)).toEqual([]);
  });

  it('maps app roles onto operator|member', () => {
    expect(idssMembershipRole(IDSS_STEWARD_APP_ROLE)).toBe('operator');
    expect(idssMembershipRole('Community Steward')).toBe('operator');
    expect(idssMembershipRole('Admin')).toBe('operator');
    expect(idssMembershipRole('operator')).toBe('operator');
    expect(idssMembershipRole('Member')).toBe('member');
    expect(idssMembershipRole('Contributor')).toBe('member');
    expect(idssMembershipRole('')).toBe('member');
    const steward = buildMembershipAttributes(IDSS, { aid: APPLICANT, name: 'A' }, 'Founding Member');
    expect(steward.role).toBe('operator');
    expect(idssSchemaErrors(steward)).toEqual([]);
  });
});

describe('legacy (Mātou) membership attributes', () => {
  it('is the unchanged Mātou body', () => {
    const now = new Date('2026-09-25T01:02:03.000Z');
    expect(buildMembershipAttributes({ kind: 'legacy' }, { aid: APPLICANT, name: 'A', email: 'a@b.co' }, 'Member', now)).toEqual({
      communityName: 'MATOU',
      role: 'Member',
      joinedAt: '2026-09-25T01:02:03.000Z',
    });
    expect(buildMembershipAttributes({ kind: 'legacy' }, { aid: APPLICANT }, 'Community Steward', now)).toEqual({
      communityName: 'MATOU',
      role: 'Community Steward',
      joinedAt: '2026-09-25T01:02:03.000Z',
    });
  });
});
