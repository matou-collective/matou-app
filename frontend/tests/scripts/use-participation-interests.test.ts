// @vitest-environment happy-dom
/**
 * useParticipationInterests (issue #301) sources the offered participation
 * interests from the org's SharedProfile schema enum — so an org that edits the
 * enum (seeded from its kit at setup) changes what the profile form offers —
 * decorating each slug with its kit label and humanizing org-added values, and
 * falling back to the kit vocabulary when the schema declares no enum.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';
import { flushPromises } from '@vue/test-utils';
import type { TypeDefinition } from 'src/lib/api/client';
import { PARTICIPATION_INTERESTS } from 'stores/onboarding';

let sharedProfileDef: TypeDefinition | null = null;

vi.mock('src/lib/api/client', () => ({
  getTypeDefinitions: vi.fn(async () => (sharedProfileDef ? [sharedProfileDef] : [])),
  getTypeDefinition: vi.fn(async () => sharedProfileDef),
}));

import { useParticipationInterests } from 'src/composables/useParticipationInterests';
import { useTypesStore } from 'stores/types';

function defWithEnum(enumValues?: string[]): TypeDefinition {
  return {
    name: 'SharedProfile',
    version: 1,
    description: '',
    space: 'community',
    fields: [
      { name: 'aid', type: 'string', core: true },
      {
        name: 'participationInterests',
        type: 'array',
        ...(enumValues ? { validation: { enum: enumValues } } : {}),
      },
    ],
    layouts: {},
    permissions: { read: 'community', write: 'owner' },
  };
}

describe('useParticipationInterests', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    sharedProfileDef = null;
  });

  it('offers exactly the schema enum, decorated with kit labels', async () => {
    sharedProfileDef = defWithEnum(['research_and_knowledge', 'cultural_oversight']);
    await useTypesStore().loadDefinitions();
    const { options, labels } = useParticipationInterests();
    await flushPromises();

    expect(options.value.map((o) => o.value)).toEqual([
      'research_and_knowledge',
      'cultural_oversight',
    ]);
    // The kit label for a matching slug decorates the schema value.
    expect(labels.value['research_and_knowledge']).toBe('Research and Knowledge');
  });

  it('humanizes an org-added value with no matching kit label', async () => {
    sharedProfileDef = defWithEnum(['fundraising_events']);
    await useTypesStore().loadDefinitions();
    const { options } = useParticipationInterests();
    await flushPromises();

    expect(options.value).toEqual([
      { value: 'fundraising_events', label: 'Fundraising Events', description: '' },
    ]);
  });

  it('falls back to the kit vocabulary when the schema declares no enum', async () => {
    sharedProfileDef = defWithEnum(undefined);
    await useTypesStore().loadDefinitions();
    const { options } = useParticipationInterests();
    await flushPromises();

    expect(options.value.map((o) => o.value)).toEqual(
      PARTICIPATION_INTERESTS.map((o) => o.value),
    );
  });

  it('falls back to the kit vocabulary when types are not loaded', () => {
    const { options } = useParticipationInterests();
    expect(options.value.map((o) => o.value)).toEqual(
      PARTICIPATION_INTERESTS.map((o) => o.value),
    );
  });
});
