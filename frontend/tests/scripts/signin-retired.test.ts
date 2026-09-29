/**
 * What #688 took out stays out (idss ADR 0282 as amended 2026-09-29, "What
 * retires"). A locked panel unlocks through the sign-in door, so the wallet has
 * ONE unlock mechanism: no code path handles `matou://unlock`, no card renders a
 * sealing-key fingerprint, and nothing reads `ek=` off a code.
 *
 * Read from the source itself, so a second mechanism cannot come back quietly.
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import routes from 'src/router/routes';

const FRONTEND = fileURLToPath(new URL('../..', import.meta.url));
const ROOTS = ['src', 'src-electron', 'src-capacitor/android/app/src/main', 'src-capacitor/ios/App/App'];
const TEXT = /\.(ts|vue|js|mjs|java|kt|swift|xml|plist|json)$/;

function walk(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'build' || name === 'Pods') continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path, out);
    else if (TEXT.test(name)) out.push(path);
  }
  return out;
}

const sources = ROOTS.flatMap((root) => walk(join(FRONTEND, root))).map((path) => ({
  path: relative(FRONTEND, path),
  text: readFileSync(path, 'utf8'),
}));

function filesMatching(pattern: RegExp): string[] {
  return sources.filter((s) => pattern.test(s.text)).map((s) => s.path);
}

describe('the retired unlock path (#688)', () => {
  it('reads real source', () => {
    expect(sources.length).toBeGreaterThan(100);
    expect(sources.some((s) => s.path === 'src/lib/signin/link.ts')).toBe(true);
  });

  it('no code path handles matou://unlock', () => {
    expect(filesMatching(/matou:\/\/unlock/)).toEqual([]);
    expect(filesMatching(/parseUnlockLink|isUnlockLink|unlockLinkToLocation|useUnlock\b|postUnlock/)).toEqual([]);
    expect(filesMatching(/UnlockCard|SigninUnlockPage|signin-unlock/)).toEqual([]);
  });

  it('the app has no unlock route', () => {
    const flat = JSON.stringify(routes, (_k, v: unknown) => (typeof v === 'function' ? undefined : v));
    expect(flat).not.toContain('"/unlock"');
    expect(flat).not.toContain('signin-unlock');
  });

  it('the retired files are gone', () => {
    for (const gone of [
      'src/composables/useUnlock.ts',
      'src/lib/signin/unlock.ts',
      'src/components/signin/UnlockCard.vue',
      'src/pages/SigninUnlockPage.vue',
    ]) {
      expect(existsSync(join(FRONTEND, gone)), gone).toBe(false);
    }
  });

  it('no card renders a sealing-key fingerprint, and nothing computes one', () => {
    expect(filesMatching(/sealing-key-fingerprint|tab-sealing-key|sealingKeyFingerprint|fingerprintOf/)).toEqual([]);
  });

  it('nothing reads ek off a code', () => {
    const signin = sources.filter((s) => /^src\/(lib\/signin|composables|pages|components\/signin)\//.test(s.path));
    const readers = signin.filter((s) => /\(\s*'ek'\s*\)|\.ek\b|\bek:/.test(s.text)).map((s) => s.path);
    expect(readers).toEqual([]);
    expect(filesMatching(/\bsealingKey\b/)).toEqual([]);
  });
});
