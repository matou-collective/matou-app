/**
 * Pure logic for tracking the lifecycle of the user's KERIA agent.
 *
 * Background (Andrew Weaver incident, Mar–Aug 2026): SignifyClient silently
 * calls boot() when connect fails with "agent does not exist", which creates a
 * NEW agent AID. Every previously shared agent-form OOBI
 * (`…/oobi/<AID>/agent/<agentAID>`) then points at a dead agent, so contacts
 * that recorded it can no longer resolve the user's key state. These helpers
 * let the client tell a legitimate first-ever boot (no prior agent AID on
 * record) apart from an unexpected re-boot of an existing identity, and
 * persist a marker so the re-boot can be surfaced and repaired (end role
 * re-published, user notified) even if the app restarts in between.
 */

/** secureStorage key holding the last agent AID this device connected as. */
export const AGENT_AID_STORAGE_KEY = 'matou_agent_aid';

/** secureStorage key holding a pending (unacknowledged) re-boot marker. */
export const AGENT_REBOOT_MARKER_KEY = 'matou_agent_reboot';

export interface AgentRebootRecord {
  previousAgentAid: string;
  newAgentAid: string;
  /** ISO timestamp of when the re-boot was detected. */
  occurredAt: string;
}

/**
 * Classify a successful KERIA connection against the agent AID recorded on
 * this device. 'first' = nothing recorded (legit onboarding), 'unchanged' =
 * same agent, 'changed' = the agent was re-created and every shared
 * agent-form OOBI is now stale.
 */
export function classifyAgentConnect(
  storedAgentAid: string | null | undefined,
  connectedAgentAid: string,
): 'first' | 'unchanged' | 'changed' {
  if (!storedAgentAid) return 'first';
  return storedAgentAid === connectedAgentAid ? 'unchanged' : 'changed';
}

/** Safe parse of a persisted re-boot marker; null on any malformed input. */
export function parseAgentRebootMarker(raw: string | null): AgentRebootRecord | null {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed === 'object' && parsed !== null &&
      typeof (parsed as AgentRebootRecord).previousAgentAid === 'string' &&
      typeof (parsed as AgentRebootRecord).newAgentAid === 'string' &&
      typeof (parsed as AgentRebootRecord).occurredAt === 'string'
    ) {
      const { previousAgentAid, newAgentAid, occurredAt } = parsed as AgentRebootRecord;
      return { previousAgentAid, newAgentAid, occurredAt };
    }
  } catch {
    // fall through
  }
  return null;
}
