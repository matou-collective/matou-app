import { describe, it, expect } from 'vitest';
import {
  classifyAgentConnect,
  parseAgentRebootMarker,
  type AgentRebootRecord,
} from '../../src/lib/agentLifecycle';

const OLD_AGENT = 'EP8my4Zv5wn_S13pwAyTpWl4TMTSWK0KcjcJyr2gnYyT';
const NEW_AGENT = 'EN0UNAjbcK8kBdSO3PkGDNjpMKAAoSQ4Rp2b8SmBnLWU';

describe('classifyAgentConnect', () => {
  it('is first-connect when no agent AID was ever stored', () => {
    expect(classifyAgentConnect(null, NEW_AGENT)).toBe('first');
    expect(classifyAgentConnect(undefined, NEW_AGENT)).toBe('first');
    expect(classifyAgentConnect('', NEW_AGENT)).toBe('first');
  });

  it('is unchanged when the stored agent AID matches', () => {
    expect(classifyAgentConnect(NEW_AGENT, NEW_AGENT)).toBe('unchanged');
  });

  it('is changed when the agent AID differs from the stored one', () => {
    expect(classifyAgentConnect(OLD_AGENT, NEW_AGENT)).toBe('changed');
  });
});

describe('parseAgentRebootMarker', () => {
  const marker: AgentRebootRecord = {
    previousAgentAid: OLD_AGENT,
    newAgentAid: NEW_AGENT,
    occurredAt: '2026-08-01T00:00:00.000Z',
  };

  it('round-trips a serialized marker', () => {
    expect(parseAgentRebootMarker(JSON.stringify(marker))).toEqual(marker);
  });

  it('returns null for null/empty input', () => {
    expect(parseAgentRebootMarker(null)).toBeNull();
    expect(parseAgentRebootMarker('')).toBeNull();
  });

  it('returns null for malformed JSON', () => {
    expect(parseAgentRebootMarker('{not json')).toBeNull();
  });

  it('returns null when required fields are missing', () => {
    expect(parseAgentRebootMarker(JSON.stringify({ previousAgentAid: OLD_AGENT }))).toBeNull();
    expect(
      parseAgentRebootMarker(JSON.stringify({ previousAgentAid: 1, newAgentAid: 2, occurredAt: 3 })),
    ).toBeNull();
  });
});
