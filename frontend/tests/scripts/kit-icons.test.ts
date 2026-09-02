import { describe, it, expect } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { renderIcons } from '../../scripts/kit/icons.mjs';

const REPO = join(__dirname, '..', '..', '..');

describe('kit icons', () => {
  it('renders every size from a PNG logo', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kit-icons-'));
    const written = await renderIcons({ logo: join(REPO, 'coa-kit/logo.png'), primary: '#0A5C6B', root });
    expect(written.length).toBeGreaterThanOrEqual(9 + 15 + 11 + 1 + 4 + 1);
    const m = await sharp(join(root, 'src-electron/icons/256x256.png')).metadata();
    expect([m.width, m.height, m.channels]).toEqual([256, 256, 4]);
    const fg = await sharp(join(root, 'src-capacitor/android/app/src/main/res/mipmap-xxxhdpi/ic_launcher_foreground.png')).metadata();
    expect([fg.width, fg.height]).toEqual([432, 432]);
    const splash = await sharp(join(root, 'src-capacitor/android/app/src/main/res/drawable-port-xxxhdpi/splash.png')).metadata();
    expect([splash.width, splash.height]).toEqual([1280, 1920]);
    const centre = await sharp(join(root, 'src-electron/icons/64x64.png')).extract({ left: 2, top: 2, width: 1, height: 1 }).raw().toBuffer();
    expect(centre[3]).toBe(0); // rounded corner is transparent
    await rm(root, { recursive: true, force: true });
  }, 60_000);
  it('accepts an SVG logo', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kit-icons-'));
    const { writeFile } = await import('node:fs/promises');
    const svg = join(root, 'logo.svg');
    await writeFile(svg, '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><circle cx="5" cy="5" r="4" fill="#fff"/></svg>');
    await renderIcons({ logo: svg, primary: '#0A5C6B', root });
    const m = await sharp(join(root, 'src/assets/kit/logo.png')).metadata();
    expect([m.width, m.height]).toEqual([512, 512]);
    await rm(root, { recursive: true, force: true });
  }, 60_000);
});
