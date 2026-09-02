import { computed } from 'vue';
import { useTypesStore } from 'stores/types';
import {
  participationInterestOptions,
  participationInterestLabels,
  type ParticipationInterestOption,
} from 'src/lib/participationInterests';

/**
 * Participation interest options sourced from the org's SharedProfile schema.
 *
 * The offered options are exactly the values the schema's
 * `participationInterests` enum declares (issue #301) — so an org that edits the
 * enum immediately changes what the profile form offers. When the type
 * definitions are not yet loaded, the built-in vocabulary is used as a fallback.
 */
export function useParticipationInterests() {
  const typesStore = useTypesStore();

  // Best-effort load; the fallback covers the not-yet-loaded case.
  if (!typesStore.loaded && !typesStore.loading) {
    void typesStore.loadDefinitions();
  }

  const enumValues = computed<string[] | undefined>(() => {
    const def = typesStore.getDefinition('SharedProfile');
    const field = def?.fields.find((f) => f.name === 'participationInterests');
    return field?.validation?.enum;
  });

  const options = computed<ParticipationInterestOption[]>(() =>
    participationInterestOptions(enumValues.value)
  );

  const labels = computed<Record<string, string>>(() =>
    participationInterestLabels(enumValues.value)
  );

  return { options, labels };
}
