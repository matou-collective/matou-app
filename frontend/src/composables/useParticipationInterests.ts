import { computed } from 'vue';
import { useTypesStore } from 'stores/types';
import { PARTICIPATION_INTERESTS } from 'stores/onboarding';
import type { InterestOption } from 'src/kit/profile';

/**
 * Humanize an interest slug that has no matching kit label, e.g.
 * `research_and_knowledge` → `Research And Knowledge`. Used as the fallback so
 * an org that added a value to the schema enum outside the built-in kit
 * vocabulary still renders sensibly.
 */
function humanizeInterest(value: string): string {
  return value.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

/**
 * Participation-interest options sourced from the org's SharedProfile schema
 * (issue #301). The offered options are exactly the values the schema's
 * `participationInterests` `validation.enum` declares — so an org that edits the
 * enum (seeded from its kit at setup) immediately changes what the profile form
 * offers, and the kit is only the authoring surface. Each schema slug is
 * decorated with its kit label/description where the slug matches, and a
 * humanized label otherwise.
 *
 * When the schema declares no enum — an org set up before this change, or one
 * that left the field free-form — the built-in kit vocabulary is used, so those
 * orgs keep today's behaviour.
 */
export function useParticipationInterests() {
  const typesStore = useTypesStore();

  // Best-effort load; the kit fallback covers the not-yet-loaded case.
  if (!typesStore.loaded && !typesStore.loading) {
    void typesStore.loadDefinitions();
  }

  // The kit vocabulary is the display source (labels + descriptions) and the
  // fallback when the schema declares no enum.
  const kitByValue = new Map(PARTICIPATION_INTERESTS.map((o) => [o.value, o]));

  const enumValues = computed<string[] | undefined>(() => {
    const def = typesStore.getDefinition('SharedProfile');
    const field = def?.fields.find((f) => f.name === 'participationInterests');
    return field?.validation?.enum;
  });

  const options = computed<InterestOption[]>(() => {
    const values = enumValues.value;
    if (!values || values.length === 0) {
      return [...PARTICIPATION_INTERESTS];
    }
    return values.map(
      (value) => kitByValue.get(value) ?? { value, label: humanizeInterest(value), description: '' },
    );
  });

  const labels = computed<Record<string, string>>(() => {
    const map: Record<string, string> = {};
    for (const o of options.value) map[o.value] = o.label;
    return map;
  });

  return { options, labels };
}

export { humanizeInterest };
