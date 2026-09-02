/**
 * Participation interests — the vocabulary offered on the profile form.
 *
 * The *set* of allowed values is owned by the backend schema: the SharedProfile
 * type ships them as `participationInterests` `validation.enum`, and an org can
 * add or remove values by editing that enum (see issue #301). This module holds
 * the built-in display metadata (label + description) for the shipped values and
 * derives the offered options from whatever enum the schema declares — values
 * without built-in metadata get a humanized label so org-added values still
 * render sensibly.
 */

export interface ParticipationInterestOption {
  value: string;
  label: string;
  description: string;
}

/**
 * Built-in participation interest metadata. Mirrors the backend's shipped enum
 * (`ParticipationInterests` in backend/internal/types/profiles.go); it is the
 * display source and the fallback when the schema definition is unavailable.
 */
export const PARTICIPATION_INTERESTS: readonly ParticipationInterestOption[] = [
  {
    value: 'research_knowledge',
    label: 'Research and Knowledge',
    description: 'Support inquiry, documentation, and knowledge sharing.',
  },
  {
    value: 'coordination_operations',
    label: 'Coordination and Operations',
    description: 'Organize efforts, track tasks, and improve processes.',
  },
  {
    value: 'art_design',
    label: 'Art and Designs',
    description: 'Create graphics, UI/UX, and brand assets.',
  },
  {
    value: 'discussion_community_input',
    label: 'Discussions and Community Input',
    description: 'Participate in conversations and share feedback.',
  },
  {
    value: 'follow_learn',
    label: 'Follow and Learn',
    description: 'Stay informed and learn at your own pace.',
  },
  {
    value: 'coding_technical_dev',
    label: 'Coding and Technical Dev',
    description: 'Build and maintain software and infrastructure.',
  },
  {
    value: 'cultural_oversight',
    label: 'Cultural Oversight',
    description: 'Ensure cultural alignment and respectful practices.',
  },
] as const;

export type ParticipationInterest = (typeof PARTICIPATION_INTERESTS)[number]['value'];

const META = new Map<string, ParticipationInterestOption>(
  PARTICIPATION_INTERESTS.map((o) => [o.value, o])
);

/**
 * Turn an enum value into a human label ("art_design" → "Art Design"),
 * used for org-added values that carry no built-in metadata.
 */
export function humanizeInterest(value: string): string {
  return value
    .split(/[_\s-]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

/**
 * The options to offer for participationInterests. When the schema declares an
 * enum (the org may have edited it), that ordered value list is the source of
 * truth; each value is decorated with built-in metadata or a humanized
 * fallback. Without a schema enum, the full built-in list is returned.
 */
export function participationInterestOptions(
  enumValues?: readonly string[] | null
): ParticipationInterestOption[] {
  if (!enumValues || enumValues.length === 0) {
    return [...PARTICIPATION_INTERESTS];
  }
  return enumValues.map(
    (v) => META.get(v) ?? { value: v, label: humanizeInterest(v), description: '' }
  );
}

/**
 * A value → label map for rendering stored interests, spanning the built-in
 * vocabulary plus any org-added enum values.
 */
export function participationInterestLabels(
  enumValues?: readonly string[] | null
): Record<string, string> {
  const map: Record<string, string> = {};
  for (const o of participationInterestOptions(enumValues)) {
    map[o.value] = o.label;
  }
  return map;
}
