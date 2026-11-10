// @vitest-environment happy-dom
/**
 * Issue #806 — the Electron window-chrome title must read as centred across the
 * FULL bar, not just the region left of the min/maximize/close buttons.
 *
 * Before the fix the bar had two children: a `flex: 1` drag region holding the
 * title (centred within itself) and the ~138px controls group. Centring the
 * title inside a region that stops short of the controls lands it left of the
 * window's true centre. The fix adds a leading spacer whose width equals the
 * controls width, so the centred drag region spans the whole bar symmetrically.
 *
 * happy-dom can't compute layout, so we assert the structural invariant that
 * makes the centring symmetric: a leading spacer mirrors the controls, and the
 * spacer + controls are the same fixed width. We also assert the title
 * ellipsises so it never slides under the buttons at narrow widths.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { mount } from '@vue/test-utils';
import TitleBar from 'src/components/base/TitleBar.vue';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

beforeAll(() => {
  // TitleBar renders only when isElectron() — give it a minimal Electron shim.
  (window as unknown as { electronAPI: Record<string, unknown> }).electronAPI = {
    isElectron: true,
    windowIsMaximized: () => Promise.resolve(false),
  };
});

const sfc = readFileSync(join(__dirname, '../../src/components/base/TitleBar.vue'), 'utf8');

describe('issue #806 — title centred across the full title bar', () => {
  it('renders a leading spacer before the centred drag region', () => {
    const wrapper = mount(TitleBar);
    const bar = wrapper.get('.titlebar');
    const children = Array.from(bar.element.children);
    // Order must be: leading spacer, centred drag region, trailing controls.
    expect(children[0]?.classList.contains('titlebar-spacer')).toBe(true);
    expect(children[1]?.classList.contains('titlebar-drag')).toBe(true);
    expect(children[children.length - 1]?.classList.contains('titlebar-controls')).toBe(true);
    wrapper.unmount();
  });

  it('spacer width matches the three 46px controls so centring is symmetric', () => {
    // 3 control buttons × 46px = 138px; the var the spacer uses must equal that.
    expect(sfc).toMatch(/--titlebar-controls-width:\s*138px/);
    expect(sfc).toMatch(/\.titlebar-btn\s*{[^}]*width:\s*46px/);
    expect(sfc).toMatch(
      /\.titlebar-spacer\s*{[^}]*width:\s*var\(--titlebar-controls-width\)/,
    );
  });

  it('spacer stays draggable so the left of the bar still moves the window', () => {
    expect(sfc).toMatch(/\.titlebar-spacer\s*{[^}]*-webkit-app-region:\s*drag/);
  });

  it('title ellipsises rather than sliding under the controls when narrow', () => {
    expect(sfc).toMatch(/\.titlebar-drag\s*{[^}]*min-width:\s*0/);
    expect(sfc).toMatch(/\.titlebar-title\s*{[^}]*text-overflow:\s*ellipsis/);
    expect(sfc).toMatch(/\.titlebar-title\s*{[^}]*white-space:\s*nowrap/);
  });
});
