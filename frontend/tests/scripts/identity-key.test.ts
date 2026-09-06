import { describe, it, expect, vi } from 'vitest';

import { resolveIdentityKey } from '../../src-electron/identity-key';
import type { SafeStorageLike, FsLike, KeyLogger } from '../../src-electron/identity-key';

/**
 * In-memory stand-in for Electron's safeStorage. "Sealing" is a reversible
 * tag so the round trip is observable without the OS keyring.
 */
function fakeSafeStorage(available = true): SafeStorageLike & { available: boolean } {
  return {
    available,
    isEncryptionAvailable() {
      return this.available;
    },
    encryptString(plaintext: string): Buffer {
      return Buffer.from('SEALED:' + plaintext, 'utf-8');
    },
    decryptString(encrypted: Buffer): string {
      const s = encrypted.toString('utf-8');
      if (!s.startsWith('SEALED:')) throw new Error('bad blob');
      return s.slice('SEALED:'.length);
    },
  };
}

/** In-memory fs over a single-file map, tracking write mode. */
function fakeFs(): FsLike & { files: Map<string, Buffer>; modes: Map<string, number>; mkdirs: string[] } {
  const files = new Map<string, Buffer>();
  const modes = new Map<string, number>();
  const mkdirs: string[] = [];
  return {
    files,
    modes,
    mkdirs,
    existsSync(p: string) {
      return files.has(p);
    },
    readFileSync(p: string) {
      const b = files.get(p);
      if (!b) throw new Error('ENOENT');
      return b;
    },
    mkdirSync(p: string) {
      mkdirs.push(p);
    },
    writeFileSync(p: string, data: Buffer, opts: { mode: number }) {
      files.set(p, data);
      modes.set(p, opts.mode);
    },
  };
}

const silentLog: KeyLogger = { warn: () => {}, error: () => {} };
const KEY_PATH = '/userData/identity-key.enc';

describe('resolveIdentityKey', () => {
  it('mints, seals and persists a 32-byte key on first launch', () => {
    const ss = fakeSafeStorage();
    const fs = fakeFs();

    const key = resolveIdentityKey(ss, fs, KEY_PATH, silentLog);

    // 32 random bytes as hex → 64 chars.
    expect(key).toMatch(/^[0-9a-f]{64}$/);
    // Sealed blob persisted at the key path with a 0600 mode.
    expect(fs.files.has(KEY_PATH)).toBe(true);
    expect(fs.modes.get(KEY_PATH)).toBe(0o600);
    // Never stored in plaintext.
    expect(fs.files.get(KEY_PATH)!.toString('utf-8')).toBe('SEALED:' + key);
  });

  it('unseals the same key on a returning launch (round trip)', () => {
    const ss = fakeSafeStorage();
    const fs = fakeFs();

    const first = resolveIdentityKey(ss, fs, KEY_PATH, silentLog);
    const writes = fs.files.get(KEY_PATH);

    const second = resolveIdentityKey(ss, fs, KEY_PATH, silentLog);

    expect(second).toBe(first);
    // The second launch must NOT re-write the sealed blob.
    expect(fs.files.get(KEY_PATH)).toBe(writes);
  });

  it('returns "" and warns once when the keyring is unavailable (legacy path)', () => {
    const ss = fakeSafeStorage(false);
    const fs = fakeFs();
    const warn = vi.fn();

    const key = resolveIdentityKey(ss, fs, KEY_PATH, { warn, error: () => {} });

    expect(key).toBe('');
    expect(fs.files.size).toBe(0); // nothing persisted
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('falls back to "" without overwriting an unreadable sealed blob', () => {
    const ss = fakeSafeStorage();
    const fs = fakeFs();
    // A corrupt/foreign blob already on disk.
    const corrupt = Buffer.from('not-sealed', 'utf-8');
    fs.files.set(KEY_PATH, corrupt);
    const error = vi.fn();

    const key = resolveIdentityKey(ss, fs, KEY_PATH, { warn: () => {}, error });

    expect(key).toBe('');
    // The existing blob is preserved so a transient failure can't orphan an
    // already-encrypted identity.json.
    expect(fs.files.get(KEY_PATH)).toBe(corrupt);
    expect(error).toHaveBeenCalledTimes(1);
  });
});
