// Renders every icon/splash asset from the kit logo with sharp. Pure: writes
// under `root`, returns the paths written.
import sharp from 'sharp';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

const ELECTRON_SIZES = [16, 32, 48, 64, 128, 256, 512];
const LEGACY = { mdpi: 48, hdpi: 72, xhdpi: 96, xxhdpi: 144, xxxhdpi: 192 };
const FOREGROUND = { mdpi: 108, hdpi: 162, xhdpi: 216, xxhdpi: 324, xxxhdpi: 432 };
const SPLASH = [
  ['drawable', 480, 320], ['drawable-port-mdpi', 320, 480], ['drawable-port-hdpi', 480, 800], ['drawable-port-xhdpi', 720, 1280],
  ['drawable-port-xxhdpi', 960, 1600], ['drawable-port-xxxhdpi', 1280, 1920], ['drawable-land-mdpi', 480, 320], ['drawable-land-hdpi', 800, 480],
  ['drawable-land-xhdpi', 1280, 720], ['drawable-land-xxhdpi', 1600, 960], ['drawable-land-xxxhdpi', 1920, 1280],
];
const FAVICONS = [16, 32, 96, 128];

const roundedRect = (size, colour, radius) =>
  Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}"><rect width="${size}" height="${size}" rx="${radius}" ry="${radius}" fill="${colour}"/></svg>`);
const circle = (size, colour) =>
  Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}"><circle cx="${size / 2}" cy="${size / 2}" r="${size / 2}" fill="${colour}"/></svg>`);

async function logoPng(logo, size) {
  // Fit the logo inside size×size, transparent padding, keeps aspect.
  return sharp(logo, { density: 384 }).resize(size, size, { fit: 'inside', withoutEnlargement: false }).png().toBuffer();
}

async function tile(logo, primary, size, { shape = 'rounded', logoScale = 0.7 } = {}) {
  const inner = Math.round(size * logoScale);
  const mark = await logoPng(logo, inner);
  const bg = shape === 'circle' ? circle(size, primary) : roundedRect(size, primary, Math.round(size * 0.22));
  return sharp(bg).composite([{ input: mark, gravity: 'centre' }]).png().toBuffer();
}

async function transparentWithMark(logo, size, logoScale) {
  const mark = await logoPng(logo, Math.round(size * logoScale));
  return sharp({ create: { width: size, height: size, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } }).composite([{ input: mark, gravity: 'centre' }]).png().toBuffer();
}

async function splash(logo, primary, w, h) {
  const min = Math.min(w, h); const t = await tile(logo, primary, Math.round(min * 0.42));
  return sharp({ create: { width: w, height: h, channels: 3, background: '#ffffff' } }).composite([{ input: t, gravity: 'centre' }]).png().toBuffer();
}

export async function renderIcons({ logo, primary, root }) {
  const written = [];
  const out = async (rel, buf) => { const p = join(root, rel); await mkdir(dirname(p), { recursive: true }); await writeFile(p, buf); written.push(p); };

  for (const s of ELECTRON_SIZES) await out(`src-electron/icons/${s}x${s}.png`, await tile(logo, primary, s));
  await out('src-electron/icons/linux-512x512.png', await tile(logo, primary, 512));
  await out('src-electron/icons/icon.png', await tile(logo, primary, 1024));

  const res = 'src-capacitor/android/app/src/main/res';
  for (const [d, s] of Object.entries(LEGACY)) {
    await out(`${res}/mipmap-${d}/ic_launcher.png`, await tile(logo, primary, s));
    await out(`${res}/mipmap-${d}/ic_launcher_round.png`, await tile(logo, primary, s, { shape: 'circle' }));
    await out(`${res}/mipmap-${d}/ic_launcher_foreground.png`, await transparentWithMark(logo, FOREGROUND[d], 0.44));
  }
  await out(`${res}/values/ic_launcher_background.xml`, `<?xml version="1.0" encoding="utf-8"?>\n<resources>\n    <color name="ic_launcher_background">${primary}</color>\n</resources>\n`);
  for (const [d, w, h] of SPLASH) await out(`${res}/${d}/splash.png`, await splash(logo, primary, w, h));

  for (const s of FAVICONS) await out(`public/icons/favicon-${s}x${s}.png`, await tile(logo, primary, s));
  await out('src/assets/kit/logo.png', await logoPng(logo, 512));
  return written;
}
