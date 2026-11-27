// Credential "look" derived from an IDSS `a.display` block (IDSS DDR 0217
// amendment 2026-09-23). A styled credential carries its own name, icon,
// background colour and/or verified image, fixed at issue time. Everything in
// this module is additive: a credential WITHOUT `display` is unaffected, and
// the wallet keeps rendering it exactly as before.
//
// The IDSS icon keys are a curated kebab-case Lucide set (see
// `Matou/idss` `dashboard/src/lib/credentialAppearance.ts` `CURATED_ICONS`),
// but we resolve ANY valid Lucide key here and fall back to the seal for an
// unknown one.

export interface CredentialImage {
  url: string;
  /** Lowercase hex sha256 of the image bytes, fixed at issue. */
  digest: string;
}

export interface CredentialDisplay {
  name: string;
  /** kebab-case Lucide key. */
  icon?: string;
  /** `#rrggbb` background colour. */
  background?: string;
  image?: CredentialImage;
}

/**
 * Parse and validate an `a.display` block from a credential's attributes.
 * Returns undefined when the block is absent or malformed so the caller falls
 * back to the legacy rendering. Only well-formed fields survive — a bad colour
 * or a half-specified image is dropped rather than trusted.
 */
export function parseCredentialDisplay(raw: unknown): CredentialDisplay | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const d = raw as Record<string, unknown>;
  if (typeof d.name !== 'string' || d.name.trim() === '') return undefined;

  const display: CredentialDisplay = { name: d.name };

  if (typeof d.icon === 'string' && d.icon.trim() !== '') {
    display.icon = d.icon.trim();
  }
  if (typeof d.background === 'string' && /^#[0-9a-fA-F]{6}$/.test(d.background)) {
    display.background = d.background;
  }
  const img = d.image;
  if (
    img &&
    typeof img === 'object' &&
    typeof (img as Record<string, unknown>).url === 'string' &&
    typeof (img as Record<string, unknown>).digest === 'string' &&
    (img as Record<string, unknown>).url !== '' &&
    (img as Record<string, unknown>).digest !== ''
  ) {
    display.image = {
      url: (img as Record<string, unknown>).url as string,
      digest: (img as Record<string, unknown>).digest as string,
    };
  }
  return display;
}

/** Title-case a raw committee slug (e.g. `finance-komiti` → `Finance Komiti`). */
export function titleCaseCommittee(committee: string): string {
  return committee
    .split(/[\s_-]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(' ');
}

/**
 * Resolve the card/dialog title for a credential.
 * Priority: `display.name` → title-cased `committee` → the legacy mapping.
 */
export function credentialTitle(
  cred: { display?: CredentialDisplay; committee?: string },
  legacyFallback: string,
): string {
  if (cred.display?.name) return cred.display.name;
  if (cred.committee) return titleCaseCommittee(cred.committee);
  return legacyFallback;
}

/** kebab-case Lucide key → PascalCase export name (`a-arrow-down` → `AArrowDown`). */
export function pascalFromKebab(key: string): string {
  return key
    .split(/[-_]/)
    .filter(Boolean)
    .map((s) => s.charAt(0).toUpperCase() + s.slice(1))
    .join('');
}

// The whole Lucide icon set is loaded once, lazily, into its own async chunk —
// only when a display credential with an icon is first rendered. This keeps the
// icons out of the main bundle while still letting us resolve ANY valid key.
let lucideModulePromise: Promise<Record<string, unknown>> | null = null;
function lucideModule(): Promise<Record<string, unknown>> {
  if (!lucideModulePromise) {
    lucideModulePromise = import('lucide-vue-next') as Promise<Record<string, unknown>>;
  }
  return lucideModulePromise;
}

/**
 * Resolve a kebab-case Lucide key to its `lucide-vue-next` component, or null
 * for an unknown key (the caller then falls back to the seal).
 */
export async function resolveLucideIcon(key: string | undefined): Promise<unknown | null> {
  if (!key) return null;
  const name = pascalFromKebab(key);
  // `Icon` is the generic base export, not a concrete glyph — never a mark.
  if (name === 'Icon' || name === '') return null;
  const mod = await lucideModule();
  const comp = mod[name];
  if (comp && (typeof comp === 'function' || typeof comp === 'object')) return comp;
  return null;
}

/**
 * WCAG relative luminance (0–1) of an `#rrggbb` colour.
 * https://www.w3.org/TR/WCAG20/#relativeluminancedef
 */
export function relativeLuminance(hex: string): number {
  const m = /^#?([0-9a-fA-F]{6})$/.exec(hex);
  if (!m) return 1; // treat an unknown colour as light → dark ink
  const int = parseInt(m[1], 16);
  const channel = (c: number): number => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  const r = channel((int >> 16) & 0xff);
  const g = channel((int >> 8) & 0xff);
  const b = channel(int & 0xff);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** IDSS ink rule: luminance > 0.4 → dark ink, else light ink. */
export function pickInk(background: string): string {
  return relativeLuminance(background) > 0.4 ? '#1f2937' : '#ffffff';
}

/** Strip an optional `sha256:`/`sha256-` prefix and normalise to lowercase hex. */
export function normalizeDigest(digest: string): string {
  return digest.trim().toLowerCase().replace(/^sha256[:-]/, '');
}

/** Lowercase hex sha256 of the given bytes (Web Crypto; available in browser + Node). */
export async function sha256Hex(bytes: ArrayBuffer): Promise<string> {
  const hash = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function bufferToDataUrl(buf: ArrayBuffer, mime: string): string {
  const bytes = new Uint8Array(buf);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  const b64 =
    typeof btoa !== 'undefined'
      ? btoa(binary)
      : Buffer.from(bytes).toString('base64');
  return `data:${mime};base64,${b64}`;
}

// A verified image is fetched ONCE and then cached by its digest, so it shows
// offline on every later sight. In-memory for the session, and mirrored to
// localStorage so it survives an app restart (the digest is content-addressed,
// so the same bytes are always safe to reuse).
const imageMemCache = new Map<string, string>();
const LS_IMAGE_PREFIX = 'matou.credImage.';

function lsGet(key: string): string | null {
  try {
    return typeof localStorage !== 'undefined' ? localStorage.getItem(key) : null;
  } catch {
    return null;
  }
}

function lsSet(key: string, value: string): void {
  try {
    if (typeof localStorage !== 'undefined') localStorage.setItem(key, value);
  } catch {
    /* quota / privacy mode — the in-memory cache still works this session */
  }
}

/**
 * Fetch, verify and cache a credential's image mark. Returns a data URL when
 * the fetched bytes match `image.digest`, or null (fall back to the seal) on a
 * digest mismatch, a fetch failure, or offline-with-no-cache. Safe to call
 * repeatedly: after the first verified sight it resolves from cache — including
 * offline.
 */
export async function loadVerifiedImage(image: CredentialImage): Promise<string | null> {
  const key = normalizeDigest(image.digest);
  if (!key) return null;

  const cached = imageMemCache.get(key) ?? lsGet(LS_IMAGE_PREFIX + key);
  if (cached) {
    imageMemCache.set(key, cached);
    return cached;
  }

  try {
    const res = await fetch(image.url);
    if (!res.ok) return null;
    const buf = await res.arrayBuffer();
    const hex = await sha256Hex(buf);
    if (hex !== key) return null; // digest mismatch → the seal
    const mime = res.headers.get('content-type') || 'image/png';
    const dataUrl = bufferToDataUrl(buf, mime);
    imageMemCache.set(key, dataUrl);
    lsSet(LS_IMAGE_PREFIX + key, dataUrl);
    return dataUrl;
  } catch {
    return null;
  }
}

// Exposed for tests only.
export const __imageCacheForTest = imageMemCache;
