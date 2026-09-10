import { describe, it, expect } from 'vitest';
import { featureDefines } from '../../scripts/kit/feature-flags.mjs';

describe('featureDefines', () => {
  it('maps the four module toggles to define-ready strings', () => {
    expect(featureDefines({ chat: true, projects: false, proposals: true, notices: true })).toEqual({
      __KIT_CHAT__: 'true',
      __KIT_PROJECTS__: 'false',
      __KIT_PROPOSALS__: 'true',
      __KIT_NOTICES__: 'true',
    });
  });

  it('treats anything but true as false (a hand-edited kit cannot half-enable)', () => {
    expect(featureDefines({}).__KIT_CHAT__).toBe('false');
  });
});
