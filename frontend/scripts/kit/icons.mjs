// Renders every icon/splash asset from the kit logo with sharp. Pure: writes
// under `root`, returns the paths written.
import sharp from 'sharp';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

const ELECTRON_SIZES = [16, 32, 48, 64, 128, 256, 512];
const LEGACY = { mdpi: 48, hdpi: 72, xhdpi: 96, xxhdpi: 144, xxxhdpi: 192 };
const FOREGROUND = { mdpi: 108, hdpi: 162, xhdpi: 216, xxhdpi: 324, xxxhdpi: 432 };
// Status-bar (notification small icon) sizes: 24dp per density bucket.
const STATUS = { mdpi: 24, hdpi: 36, xhdpi: 48, xxhdpi: 72, xxxhdpi: 96 };
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

async function logoPng(logo, size, background) {
  // Fit the logo inside size×size, keeps aspect. Padding is transparent, or the
  // logo's own background colour when it has one (so a non-square opaque logo
  // still reads as one solid plate).
  const pad = background ? { fit: 'contain', background } : { fit: 'inside' };
  return sharp(logo, { density: 384 }).resize(size, size, { ...pad, withoutEnlargement: false }).png().toBuffer();
}

const TOL = 8;
// The dominant flat colour of a set of pixels, as #rrggbb, or null when no one
// colour holds at least `min` of them (a photo or gradient has no such bucket).
const dominantColour = (pixels, min) => {
  const buckets = [];
  for (const p of pixels) {
    const hit = buckets.find((b) => Math.abs(b.r - p[0]) <= TOL && Math.abs(b.g - p[1]) <= TOL && Math.abs(b.b - p[2]) <= TOL);
    if (hit) hit.n++; else buckets.push({ r: p[0], g: p[1], b: p[2], n: 1 });
  }
  if (!buckets.length) return null;
  const top = buckets.reduce((a, b) => (b.n > a.n ? b : a));
  if (top.n < min) return null;
  return '#' + [top.r, top.g, top.b].map((v) => v.toString(16).padStart(2, '0')).join('');
};

// A round logo is an opaque disc inscribed in the square with transparent
// corners (Coa's kit logo: a 512×512 PNG, opaque disc, transparent corners).
// The founder chose the disc's fill as the colour behind the crop, so return
// the disc's rim colour: the dominant opaque colour on a ring just inside the
// inscribed circle. Returns null when the shape is not a filled disc.
function discRimColour(px, w, h) {
  const cx = w / 2, cy = h / 2, r = Math.min(w, h) / 2;
  // Transparent corners are what makes this a round crop rather than a plate.
  const corners = [px(0, 0), px(w - 1, 0), px(0, h - 1), px(w - 1, h - 1)];
  if (corners.some((p) => p[3] === 255)) return null;
  const rim = [];
  const N = 360;
  for (let i = 0; i < N; i++) {
    const a = (i / N) * 2 * Math.PI;
    const x = Math.round(cx + Math.cos(a) * r * 0.9);
    const y = Math.round(cy + Math.sin(a) * r * 0.9);
    if (x < 0 || y < 0 || x >= w || y >= h) continue;
    rim.push(px(x, y));
  }
  // The disc must actually fill the inscribed circle — a small floating mark
  // leaves this rim transparent, so it stays on the brand primary.
  const opaque = rim.filter((p) => p[3] === 255);
  if (opaque.length < rim.length * 0.9) return null;
  return dominantColour(opaque, opaque.length * 0.75);
}

// The logo's own background colour, or null. An opaque raster whose border is
// dominated by one flat colour (a wordmark exported on white, say) carries its
// background with it. A round logo — a disc on transparent corners — carries the
// disc's rim colour, the fill the founder chose behind the crop. Anything else
// (a floating mark, a photo, a gradient edge) takes the brand primary.
export async function logoBackground(logo) {
  const { data, info } = await sharp(logo, { density: 384 }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const { width: w, height: h, channels: c } = info;
  const px = (x, y) => data.subarray((y * w + x) * c, (y * w + x) * c + 4);
  const ring = [];
  for (let x = 0; x < w; x++) ring.push(px(x, 0), px(x, h - 1));
  for (let y = 1; y < h - 1; y++) ring.push(px(0, y), px(w - 1, y));
  // Any transparency along the edge means the logo is not a solid plate: it may
  // be a round crop, otherwise it floats on the primary.
  if (ring.some((p) => p[3] < 255)) return discRimColour(px, w, h);
  // An opaque plate: take the border's dominant flat colour by a majority vote,
  // so a wordmark whose glyphs reach the plate edge (or a little anti-aliasing)
  // does not hide the background the rest of the ring agrees on.
  return dominantColour(ring, ring.length * 0.75);
}

// Tile shapes. `background` is the plate colour when the kit or logo carries one:
// the whole tile fills with it and the logo (an opaque plate that already fills,
// or a round disc, or a mark) sits on top before the shape is cut. Otherwise the
// mark floats at `logoScale` on the brand primary.
async function tile(logo, primary, size, { shape = 'rounded', logoScale = 0.7, background = null } = {}) {
  const mask = shape === 'circle' ? circle(size, '#000') : roundedRect(size, '#000', Math.round(size * 0.22));
  if (background) {
    const bg = shape === 'circle' ? circle(size, background) : roundedRect(size, background, Math.round(size * 0.22));
    const plate = await logoPng(logo, size, background);
    return sharp(bg).composite([{ input: plate, gravity: 'centre' }, { input: mask, blend: 'dest-in' }]).png().toBuffer();
  }
  const inner = Math.round(size * logoScale);
  const mark = await logoPng(logo, inner);
  const bg = shape === 'circle' ? circle(size, primary) : roundedRect(size, primary, Math.round(size * 0.22));
  return sharp(bg).composite([{ input: mark, gravity: 'centre' }]).png().toBuffer();
}

async function transparentWithMark(logo, size, logoScale, background = null) {
  const mark = await logoPng(logo, Math.round(size * logoScale), background);
  return sharp({ create: { width: size, height: size, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } }).composite([{ input: mark, gravity: 'centre' }]).png().toBuffer();
}

async function statusIcon(logo, size) {
  // Android renders the notification small icon as an alpha silhouette, so
  // build a pure-white copy of the logo mark on transparent, with the ~2dp
  // content padding the platform guidelines ask for at 24dp.
  const inner = Math.round(size * 0.84);
  const fitted = await sharp(logo, { density: 384 }).resize(inner, inner, { fit: 'inside', withoutEnlargement: false }).png().toBuffer();
  const { data, info } = await sharp(fitted).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  for (let i = 0; i < data.length; i += 4) { data[i] = 255; data[i + 1] = 255; data[i + 2] = 255; }
  const white = await sharp(data, { raw: { width: info.width, height: info.height, channels: 4 } }).png().toBuffer();
  return sharp({ create: { width: size, height: size, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } }).composite([{ input: white, gravity: 'centre' }]).png().toBuffer();
}

async function splash(logo, primary, w, h, background) {
  const min = Math.min(w, h); const t = await tile(logo, primary, Math.round(min * 0.42), { background });
  return sharp({ create: { width: w, height: h, channels: 3, background: '#ffffff' } }).composite([{ input: t, gravity: 'centre' }]).png().toBuffer();
}

const HEX_RE = /^#[0-9a-fA-F]{6}$/;

export async function renderIcons({ logo, primary, root, brandBackground = null }) {
  const written = [];
  const out = async (rel, buf) => { const p = join(root, rel); await mkdir(dirname(p), { recursive: true }); await writeFile(p, buf); written.push(p); };
  // The founder's chosen plate colour wins when the kit carries it; otherwise
  // detect it from the logo (round-disc rim or opaque-plate border).
  const background = (typeof brandBackground === 'string' && HEX_RE.test(brandBackground)) ? brandBackground : await logoBackground(logo);
  const opts = { background };
  // Adaptive-icon foreground: the outer 18dp of the 108dp canvas is masked, so
  // the mark must sit inside the central 66dp. A transparent mark is scaled to
  // 44%; an opaque logo carries its own padding, so 72% keeps its content in the
  // safe zone while the matching background colour fills the rest of the tile.
  const foregroundScale = background ? 0.72 : 0.44;

  for (const s of ELECTRON_SIZES) await out(`src-electron/icons/${s}x${s}.png`, await tile(logo, primary, s, opts));
  await out('src-electron/icons/linux-512x512.png', await tile(logo, primary, 512, opts));
  await out('src-electron/icons/icon.png', await tile(logo, primary, 1024, opts));

  const res = 'src-capacitor/android/app/src/main/res';
  for (const [d, s] of Object.entries(LEGACY)) {
    await out(`${res}/mipmap-${d}/ic_launcher.png`, await tile(logo, primary, s, opts));
    await out(`${res}/mipmap-${d}/ic_launcher_round.png`, await tile(logo, primary, s, { shape: 'circle', background }));
    await out(`${res}/mipmap-${d}/ic_launcher_foreground.png`, await transparentWithMark(logo, FOREGROUND[d], foregroundScale, background));
  }
  for (const [d, sz] of Object.entries(STATUS)) await out(`${res}/drawable-${d}/ic_stat_matou.png`, await statusIcon(logo, sz));
  await out(`${res}/values/ic_launcher_background.xml`, `<?xml version="1.0" encoding="utf-8"?>\n<resources>\n    <color name="ic_launcher_background">${background ?? primary}</color>\n</resources>\n`);
  for (const [d, w, h] of SPLASH) await out(`${res}/${d}/splash.png`, await splash(logo, primary, w, h, background));

  for (const s of FAVICONS) await out(`public/icons/favicon-${s}x${s}.png`, await tile(logo, primary, s, opts));
  await out('src/assets/kit/logo.png', await logoPng(logo, 512));
  return written;
}
