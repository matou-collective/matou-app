export const CONTRIBUTION_TYPES = [
  "coding_technical_dev",
  "coordination_operations",
  "discussion_community_input",
  "research_knowledge",
  "art_design",
  "cultural_oversight",
  "follow_learn",
  "technical",
  "community",
  "governance",
  "operations",
] as const;

export const PRIORITIES = ["low", "medium", "high", "critical"] as const;
export const REVIEW_DECISIONS = ["approved", "incomplete", "declined"] as const;
export const NOTICE_TYPES = ["event", "update", "announcement"] as const;
export const NOTICE_STATES = ["draft", "published"] as const;

export function validateEnum(field: string, value: string, allowed: readonly string[]): string {
  if (!allowed.includes(value)) {
    throw new Error(`${field} must be one of: ${allowed.join(", ")} (got "${value}")`);
  }
  return value;
}

// Returns the human-readable derivation note appended to completion_notes when a
// fractional actual_duration must be rounded for an int-only backend build.
export function buildDerivationNote(hours: number, amount?: number): string {
  if (amount !== undefined && hours > 0) {
    const rate = (amount / hours).toFixed(2);
    return `Effort: ${hours} hrs @ $${rate}/hr = $${amount}. (Stored as whole hours; this build accepts integers only.)`;
  }
  return `Effort: ${hours} hrs (stored rounded to whole hours; this build accepts integers only).`;
}
