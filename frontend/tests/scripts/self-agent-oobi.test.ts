import { describe, it, expect } from 'vitest';
import { parseAgentOobiEid, isSelfAgentOobi } from '../../src/lib/selfAgentOobi';

// Real URL shape from issue #450 (coa-shared, proxied https layout):
//   https://coa-infra.matou.nz/keria/cesr/oobi/<AID>/agent/<AGENT_EID>
const HOST = 'https://coa-infra.matou.nz/keria/cesr';
const ORG_AID = 'ELzF-pbW2vGyrWdIPBZeE4YZXh27hjbyX3wbxcQcC8hc';
const OWN_AGENT = 'ELPzJwwyei6_JWvgSRg6YUNl_XMp8dRoZM20AgjQ30_O';
const FOREIGN_AGENT = 'EN0UNAjbcK8kBdSO3PkGDNjpMKAAoSQ4Rp2b8SmBnLWU';

const ownAgentOobi = `${HOST}/oobi/${ORG_AID}/agent/${OWN_AGENT}`;
const foreignAgentOobi = `${HOST}/oobi/${ORG_AID}/agent/${FOREIGN_AGENT}`;
const bareOobi = `${HOST}/oobi/${ORG_AID}`;

describe('parseAgentOobiEid', () => {
  it('extracts the agent EID from an agent-role OOBI', () => {
    expect(parseAgentOobiEid(ownAgentOobi)).toBe(OWN_AGENT);
    expect(parseAgentOobiEid(foreignAgentOobi)).toBe(FOREIGN_AGENT);
  });

  it('returns null for a bare OOBI (no /agent/ segment)', () => {
    expect(parseAgentOobiEid(bareOobi)).toBeNull();
  });

  it('tolerates a trailing slash after the agent EID', () => {
    expect(parseAgentOobiEid(`${ownAgentOobi}/`)).toBe(OWN_AGENT);
  });

  it('returns null for missing or malformed input', () => {
    expect(parseAgentOobiEid(null)).toBeNull();
    expect(parseAgentOobiEid(undefined)).toBeNull();
    expect(parseAgentOobiEid('')).toBeNull();
    expect(parseAgentOobiEid('not a url')).toBeNull();
    // /agent/ present but with no EID following it.
    expect(parseAgentOobiEid(`${HOST}/oobi/${ORG_AID}/agent`)).toBeNull();
  });
});

describe('isSelfAgentOobi', () => {
  it('is true when the OOBI\'s agent EID equals our own agent prefix', () => {
    expect(isSelfAgentOobi(ownAgentOobi, OWN_AGENT)).toBe(true);
  });

  it('is false for an OOBI hosted by a different agent', () => {
    expect(isSelfAgentOobi(foreignAgentOobi, OWN_AGENT)).toBe(false);
  });

  it('is false for a bare OOBI (nothing to compare against)', () => {
    expect(isSelfAgentOobi(bareOobi, OWN_AGENT)).toBe(false);
  });

  it('is false (never throws) when inputs are missing or malformed', () => {
    expect(isSelfAgentOobi(undefined, OWN_AGENT)).toBe(false);
    expect(isSelfAgentOobi(ownAgentOobi, null)).toBe(false);
    expect(isSelfAgentOobi(ownAgentOobi, undefined)).toBe(false);
    expect(isSelfAgentOobi('not a url', OWN_AGENT)).toBe(false);
    expect(isSelfAgentOobi('', '')).toBe(false);
  });
});
