// @vitest-environment happy-dom
/**
 * App chrome is branded from the kit (coa-kit plan Task 4, issue #240).
 *
 * The titlebar, sidebar, splash and welcome overlay read their name/logo from
 * the generated KIT (src/generated/kit.ts) rather than hard-coded "Matou"
 * strings. This mounts the lightest of those — TitleBar — and asserts the
 * rendered name equals KIT.brand.name, so a kit swap flows through to chrome.
 *
 * Runs under happy-dom (the repo's DOM env; jsdom is not installed) because
 * TitleBar only renders inside Electron — we set window.electronAPI so
 * isElectron() is true and the titlebar mounts.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { mount } from '@vue/test-utils';
import TitleBar from 'src/components/base/TitleBar.vue';
import { KIT } from 'src/generated/kit';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

beforeAll(() => {
  // TitleBar renders only when isElectron() — give it a minimal Electron shim.
  (window as unknown as { electronAPI: Record<string, unknown> }).electronAPI = {
    isElectron: true,
    windowIsMaximized: () => Promise.resolve(false),
  };
});

describe('chrome from kit', () => {
  it('TitleBar shows the kit name', () => {
    const wrapper = mount(TitleBar);
    expect(wrapper.text()).toContain(KIT.brand.name);
    wrapper.unmount();
  });

  // The window chrome colour comes from the kit too: --matou-brand is the
  // theme-invariant brand primary (design-tokens.scss), the same token the
  // splash and home header use. happy-dom cannot compute styles, so assert on
  // the SFC source: no stock-Mātou navy, brand token for the bar and the
  // maximize glyph's inner fill.
  it('TitleBar paints with the kit brand primary, not a hard-coded colour', () => {
    const sfc = readFileSync(join(__dirname, '../../src/components/base/TitleBar.vue'), 'utf8');
    expect(sfc).not.toMatch(/#003141/i);
    expect(sfc).toMatch(/\.titlebar\s*{[^}]*background:\s*var\(--matou-brand\)/);
    expect(sfc).toMatch(/fill="var\(--matou-brand\)"/);
  });
});
