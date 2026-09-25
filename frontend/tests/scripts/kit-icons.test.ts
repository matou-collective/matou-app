import { describe, it, expect } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { renderIcons, logoBackground } from '../../scripts/kit/icons.mjs';

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
    // A transparent logo keeps the brand primary behind the mark.
    const { readFile } = await import('node:fs/promises');
    expect(await readFile(join(root, 'src-capacitor/android/app/src/main/res/values/ic_launcher_background.xml'), 'utf8')).toContain('#0A5C6B');
    const edge = await sharp(join(root, 'src-electron/icons/256x256.png')).extract({ left: 40, top: 128, width: 1, height: 1 }).raw().toBuffer();
    expect([edge[0], edge[1], edge[2], edge[3]]).toEqual([0x0a, 0x5c, 0x6b, 255]);
    await rm(root, { recursive: true, force: true });
  }, 60_000);
  it('fills the tile with an opaque logo on its own background colour', async () => {
    // A white-background wordmark (the common case: a PNG export with no alpha)
    // must not become a small white square on the brand primary — the tile takes
    // the logo's background colour and the logo fills it.
    const root = await mkdtemp(join(tmpdir(), 'kit-icons-'));
    const logo = join(root, 'logo.png');
    const mark = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" fill="#ffffff"/><rect x="24" y="24" width="16" height="16" fill="#102030"/></svg>');
    await sharp(mark).png().toFile(logo);
    await renderIcons({ logo, primary: '#0A5C6B', root });
    const { readFile } = await import('node:fs/promises');
    expect(await readFile(join(root, 'src-capacitor/android/app/src/main/res/values/ic_launcher_background.xml'), 'utf8')).toContain('#ffffff');
    const px = async (rel: string, left: number, top: number) => {
      const b = await sharp(join(root, rel)).extract({ left, top, width: 1, height: 1 }).raw().toBuffer();
      return [b[0], b[1], b[2], b[3]];
    };
    // Legacy/electron tile: logo background reaches the tile edge, corner stays rounded, mark in the centre.
    expect(await px('src-electron/icons/256x256.png', 40, 128)).toEqual([255, 255, 255, 255]);
    expect(await px('src-electron/icons/256x256.png', 128, 128)).toEqual([0x10, 0x20, 0x30, 255]);
    expect((await px('src-electron/icons/256x256.png', 2, 2))[3]).toBe(0);
    // Adaptive foreground: the logo sits on transparent inside the safe zone (the matching background colour fills the rest).
    expect((await px('src-capacitor/android/app/src/main/res/mipmap-xxxhdpi/ic_launcher_foreground.png', 10, 10))[3]).toBe(0);
    expect(await px('src-capacitor/android/app/src/main/res/mipmap-xxxhdpi/ic_launcher_foreground.png', 216, 216)).toEqual([0x10, 0x20, 0x30, 255]);
    expect(await px('src-capacitor/android/app/src/main/res/mipmap-xxxhdpi/ic_launcher_foreground.png', 90, 216)).toEqual([255, 255, 255, 255]);
    await rm(root, { recursive: true, force: true });
  }, 60_000);
  it('adaptive background layer equals the detected logo background even when the wordmark touches the plate edge', async () => {
    // The whakatohea-demo case (#635): a wordmark on white whose dark glyphs
    // reach the left/right edges. A strict "every border pixel matches" check
    // gave up and the icon fell back to the brand primary; the background is the
    // dominant border colour, so the adaptive icon fills with the logo's own white.
    const root = await mkdtemp(join(tmpdir(), 'kit-icons-'));
    const logo = join(root, 'logo.png');
    const mark = Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512">' +
        '<rect width="512" height="512" fill="#ffffff"/>' +
        // glyph slabs that touch the left and right plate edges
        '<rect x="0" y="230" width="70" height="52" fill="#203040"/>' +
        '<rect x="442" y="230" width="70" height="52" fill="#203040"/>' +
        '<rect x="180" y="230" width="152" height="52" fill="#203040"/></svg>',
    );
    await sharp(mark).png().toFile(logo);
    // Detection sees past the edge-touching glyphs to the white plate.
    const detected = await logoBackground(logo);
    expect(detected).toBe('#ffffff');
    await renderIcons({ logo, primary: '#404040', root });
    const { readFile } = await import('node:fs/promises');
    // The adaptive-icon background layer colour equals the detected logo background.
    const xml = await readFile(join(root, 'src-capacitor/android/app/src/main/res/values/ic_launcher_background.xml'), 'utf8');
    expect(xml).toContain(`>${detected}<`);
    // Not the brand primary — the pre-fix fallback.
    expect(xml).not.toContain('#404040');
    await rm(root, { recursive: true, force: true });
  }, 60_000);
});
