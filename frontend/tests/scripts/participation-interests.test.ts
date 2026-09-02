import { describe, it, expect } from 'vitest';
import {
  PARTICIPATION_INTERESTS,
  participationInterestOptions,
  participationInterestLabels,
  humanizeInterest,
} from 'src/lib/participationInterests';

describe('participationInterestOptions', () => {
  it('falls back to the built-in vocabulary when no enum is given', () => {
    expect(participationInterestOptions()).toEqual([...PARTICIPATION_INTERESTS]);
    expect(participationInterestOptions([])).toEqual([...PARTICIPATION_INTERESTS]);
    expect(participationInterestOptions(null)).toEqual([...PARTICIPATION_INTERESTS]);
  });

  it('offers exactly the values the schema enum declares, in order', () => {
    const opts = participationInterestOptions(['cultural_oversight', 'research_knowledge']);
    expect(opts.map((o) => o.value)).toEqual(['cultural_oversight', 'research_knowledge']);
  });

  it('decorates known values with their built-in label and description', () => {
    const [opt] = participationInterestOptions(['art_design']);
    expect(opt).toEqual({
      value: 'art_design',
      label: 'Art and Designs',
      description: 'Create graphics, UI/UX, and brand assets.',
    });
  });

  it('humanizes org-added values that carry no built-in metadata', () => {
    const [opt] = participationInterestOptions(['fundraising_and_grants']);
    expect(opt).toEqual({
      value: 'fundraising_and_grants',
      label: 'Fundraising And Grants',
      description: '',
    });
  });

  it('drops values an org removed from the enum', () => {
    // Old default vocabulary contains "follow_learn"; an org that removes it
    // no longer offers it.
    const values = participationInterestOptions(['research_knowledge']).map((o) => o.value);
    expect(values).not.toContain('follow_learn');
  });
});

describe('participationInterestLabels', () => {
  it('maps every offered value to a label', () => {
    const labels = participationInterestLabels(['research_knowledge', 'new_thing']);
    expect(labels).toEqual({
      research_knowledge: 'Research and Knowledge',
      new_thing: 'New Thing',
    });
  });
});

describe('humanizeInterest', () => {
  it('title-cases underscore/space/dash separated values', () => {
    expect(humanizeInterest('art_design')).toBe('Art Design');
    expect(humanizeInterest('coding-technical dev')).toBe('Coding Technical Dev');
  });
});
