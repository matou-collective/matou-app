/**
 * Pure logic for detecting an OOBI whose target is hosted by our *own* KERIA
 * agent, so credential polling can skip resolving it (issue #450).
 *
 * Background: on a single-agent org setup (one KERIA agent hosts both the admin
 * AID and the org/group AID), the org and admin OOBIs recorded in the org
 * config are the agent-role form (`…/oobi/<AID>/agent/<AGENT_EID>`) whose
 * `<AGENT_EID>` is *this* client's own agent. KERIA refuses to verify the
 * loc-scheme reply it authored for its own agent (`Unverified loc scheme
 * reply`), so `resolveOOBI` polls the operation until the client's signal times
 * out (~30 s each). The client already holds current key state for its own
 * identifiers, so resolving a self-agent OOBI teaches it nothing — skipping it
 * is behaviour-preserving and just removes the dead-weight wait.
 *
 * Mirrors the URL-parsing style of registrationResolve.ts so it stays pure and
 * unit-testable with no live KERIA.
 */

/**
 * Extract the agent EID from an agent-role OOBI URL
 * (`…/oobi/<AID>/agent/<AGENT_EID>`). Returns null for a bare OOBI
 * (`…/oobi/<AID>`), a malformed URL, or anything without an `/agent/` segment.
 */
export function parseAgentOobiEid(oobi: string | undefined | null): string | null {
  if (!oobi) return null;
  try {
    const url = new URL(oobi);
    const parts = url.pathname.split('/').filter(Boolean);
    const idx = parts.lastIndexOf('agent');
    if (idx >= 0 && idx + 1 < parts.length) {
      return parts[idx + 1] || null;
    }
    return null;
  } catch {
    // Malformed URL — cannot determine the agent EID.
    return null;
  }
}

/**
 * Whether this OOBI's target is hosted by our own KERIA agent — i.e. it is the
 * agent-role form and its embedded agent EID equals our own agent prefix. Never
 * throws: any parse failure or missing input yields false, so the caller falls
 * through to attempting the resolve exactly as before (best-effort/non-fatal).
 */
export function isSelfAgentOobi(
  oobi: string | undefined | null,
  ownAgentAid: string | undefined | null,
): boolean {
  if (!oobi || !ownAgentAid) return false;
  const eid = parseAgentOobiEid(oobi);
  return eid !== null && eid === ownAgentAid;
}
