import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type MatouEnv = "dev" | "test" | "prod" | "unknown";

type ReadFile = (path: string) => string;
const defaultRead: ReadFile = (p) => readFileSync(p, "utf8");

/** Prefix the backend writes on an encrypted identity.json (internal/identity/crypto.go). */
const ENCRYPTED_IDENTITY_MAGIC = "MATOU-IDENC1";

/**
 * The packaged app's backend data dir. Electron's userData base differs per OS
 * (frontend/src-electron/kit-paths.ts): ~/.config on Linux,
 * ~/Library/Application Support on macOS, %APPDATA% on Windows. The app folder
 * is the kit productName ("Matou" for stock builds). MATOU_DATA_DIR overrides
 * it — e.g. for a kit-branded build with a different productName.
 */
export function matouDataDir(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
): string {
  if (env.MATOU_DATA_DIR) return env.MATOU_DATA_DIR;
  let appData: string;
  if (platform === "darwin") appData = join(home, "Library", "Application Support");
  else if (platform === "win32") appData = env.APPDATA || join(home, "AppData", "Roaming");
  else appData = env.XDG_CONFIG_HOME || join(home, ".config");
  return join(appData, "Matou", "matou-data");
}

/**
 * Resolve the acting AID for RBAC-gated tools:
 *   1. MATOU_USER_AID env override
 *   2. the running backend's identity (GET /api/v1/identity) — works even
 *      when identity.json is encrypted at rest
 *   3. a plaintext identity.json in the app data dir
 */
export async function resolveActingAid(
  fetchAid: () => Promise<string | undefined> = async () => undefined,
  readFile: ReadFile = defaultRead,
): Promise<string> {
  const override = process.env.MATOU_USER_AID;
  if (override) return override;
  const fromBackend = await fetchAid();
  if (fromBackend) return fromBackend;
  const path = join(matouDataDir(), "identity.json");
  let raw: string;
  try {
    raw = readFile(path);
  } catch (e) {
    throw new Error(`Couldn't read ${path} — set MATOU_USER_AID. (${(e as Error).message})`);
  }
  if (raw.startsWith(ENCRYPTED_IDENTITY_MAGIC)) {
    throw new Error(
      "identity.json is encrypted and the backend reported no identity — sign in to the Matou app, or set MATOU_USER_AID.",
    );
  }
  try {
    const aid = JSON.parse(raw).aid;
    if (!aid || typeof aid !== "string") throw new Error("no aid field");
    return aid;
  } catch (e) {
    throw new Error(`Couldn't read identity.json — set MATOU_USER_AID. (${(e as Error).message})`);
  }
}

export function detectEnv(baseUrl: string): MatouEnv {
  const m = baseUrl.match(/:(\d+)/);
  if (!m) return "unknown";
  if (m[1] === "8080") return "dev";
  if (m[1] === "9080") return "test";
  return "prod";
}

/** Fixed dev/test fallback token — mirrors the backend's DevAPIToken. */
const DEV_API_TOKEN = "matou-dev";

/**
 * Resolve the API token the backend's TokenGuard requires on mutating requests:
 *   - MATOU_API_TOKEN env override, else
 *   - dev/test backends: the fixed dev/test constant (their token), else
 *   - the 0600 api-token file the packaged app's backend writes into its
 *     data dir.
 *
 * The env matters: the token file only ever holds the *packaged* app's
 * random token. Once the AppImage has run once the file exists, and reading
 * it against a dev/test backend (which expects the constant) would 401
 * every mutation with a misleading error.
 */
export function resolveApiToken(env: MatouEnv, readFile: ReadFile = defaultRead): string {
  const override = process.env.MATOU_API_TOKEN;
  if (override) return override;
  if (env === "dev" || env === "test") return DEV_API_TOKEN;
  const path = join(matouDataDir(), "api-token");
  try {
    const token = readFile(path).trim();
    if (token) return token;
  } catch {
    // File absent (app not run yet) — fall back to the constant.
  }
  return DEV_API_TOKEN;
}
