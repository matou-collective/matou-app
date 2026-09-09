/**
 * Per-install identity encryption key for the bundled backend (issue #117).
 *
 * The backend encrypts `{dataDir}/identity.json` at rest under a key the shell
 * supplies at spawn via `MATOU_IDENTITY_KEY`. This module owns that key's
 * lifecycle on the Electron side: on first launch it mints 32 random bytes,
 * seals them with the OS keyring via `safeStorage` (the same trust root the
 * secure-storage IPC handlers use) and persists the sealed blob under
 * `userData`; on every later launch it unseals and returns the same key. When
 * the OS keyring is unavailable it returns `''`, so the backend keeps the
 * legacy plaintext `identity.json` — dev, test and keyring-less hosts are
 * unaffected.
 *
 * The logic is dependency-injected (safeStorage, fs, the key path) so it is
 * unit-testable without a running Electron app.
 */
import crypto from 'crypto';
import path from 'path';

/** The slice of Electron's `safeStorage` this module needs. */
export interface SafeStorageLike {
  isEncryptionAvailable(): boolean;
  encryptString(plaintext: string): Buffer;
  decryptString(encrypted: Buffer): string;
}

/** The slice of `node:fs` this module needs. */
export interface FsLike {
  existsSync(p: string): boolean;
  readFileSync(p: string): Buffer;
  mkdirSync(p: string, opts: { recursive: boolean }): void;
  writeFileSync(p: string, data: Buffer, opts: { mode: number }): void;
}

/** Minimal logger (electron-log's `warn`/`error` satisfy this). */
export interface KeyLogger {
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
}

/**
 * Resolve the identity encryption key to hand the backend as
 * `MATOU_IDENTITY_KEY`. Returns the key string, or `''` to signal that the
 * caller should fall back to the legacy plaintext path (omit the env var).
 *
 * Never logs the key material itself.
 */
export function resolveIdentityKey(
  safeStorage: SafeStorageLike,
  fs: FsLike,
  keyPath: string,
  log: KeyLogger,
): string {
  if (!safeStorage.isEncryptionAvailable()) {
    log.warn(
      '[Identity] OS keyring unavailable via safeStorage — the bundled backend will keep identity.json in the legacy plaintext format. Install a keyring (gnome-keyring, kwallet) for at-rest encryption.',
    );
    return '';
  }

  // Returning launch: unseal the stored key.
  if (fs.existsSync(keyPath)) {
    try {
      return safeStorage.decryptString(fs.readFileSync(keyPath));
    } catch (err) {
      // Do NOT overwrite the sealed blob — a transient keyring failure must not
      // orphan an already-encrypted identity.json by minting a fresh key. Fall
      // back to the legacy path for this launch; the next launch retries the
      // unseal.
      log.error('[Identity] Failed to unseal the stored identity key — using the legacy plaintext path this launch:', err);
      return '';
    }
  }

  // First launch: mint 32 random bytes, seal, persist.
  const key = crypto.randomBytes(32).toString('hex');
  try {
    const sealed = safeStorage.encryptString(key);
    fs.mkdirSync(path.dirname(keyPath), { recursive: true });
    fs.writeFileSync(keyPath, sealed, { mode: 0o600 });
  } catch (err) {
    log.error('[Identity] Failed to seal/persist the identity key — using the legacy plaintext path:', err);
    return '';
  }
  return key;
}
