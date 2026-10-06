import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { basename, extname } from "node:path";
import { detectEnv, type MatouEnv } from "./identity.js";

export interface FetchResponse {
  ok: boolean;
  status: number;
  text: () => Promise<string>;
}
export type FetchFn = (url: string, init?: Record<string, unknown>) => Promise<FetchResponse>;

/** A reference to a file already uploaded to the backend (matches the Go FileRef). */
export interface FileRef {
  file_ref: string;
  file_name: string;
  content_type: string;
  size: number;
  category: string;
  uploaded_by: string;
  uploaded_at: string;
}

// Minimal extension -> MIME map for the common evidence/time-report formats.
const MIME_BY_EXT: Record<string, string> = {
  ".csv": "text/csv",
  ".md": "text/markdown",
  ".txt": "text/plain",
  ".pdf": "application/pdf",
  ".json": "application/json",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
};

export class MatouApiError extends Error {
  constructor(message: string, readonly status: number, readonly body: unknown) {
    super(message);
    this.name = "MatouApiError";
  }
}

function mapError(status: number, body: unknown): string {
  const backendMsg =
    body && typeof body === "object" && "error" in body ? String((body as Record<string, unknown>).error) : "";
  switch (status) {
    case 401:
      // TokenGuard 401s carry "invalid or missing API token" — a different
      // problem (wrong bearer token) than a missing X-User-AID identity.
      if (backendMsg.includes("API token")) {
        return `API token rejected by the backend — set MATOU_API_TOKEN (or check the api-token file matches this backend). ${backendMsg}`.trim();
      }
      return `Identity not configured — open the Matou app or set MATOU_USER_AID. ${backendMsg}`.trim();
    case 403:
      return `You lack the role required (need project_lead / steward / founding_member). ${backendMsg}`.trim();
    case 409:
      return `Conflict: ${backendMsg || "operation not allowed in current state"}`;
    default:
      return backendMsg || `Request failed with status ${status}`;
  }
}

export class MatouClient {
  constructor(
    private readonly baseUrl: string,
    private readonly actingAid: string,
    private readonly fetchFn: FetchFn = fetch as unknown as FetchFn,
    private readonly apiToken: string = "",
  ) {}

  /** Headers common to every request: JSON + the API token (when configured). */
  private baseHeaders(): Record<string, string> {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (this.apiToken) headers["Authorization"] = `Bearer ${this.apiToken}`;
    return headers;
  }

  get<T>(path: string): Promise<T> {
    return this.request<T>("GET", path);
  }
  post<T>(path: string, body: unknown, opts?: { rbac?: boolean }): Promise<T> {
    return this.request<T>("POST", path, body, opts?.rbac);
  }
  put<T>(path: string, body: unknown, opts?: { rbac?: boolean }): Promise<T> {
    return this.request<T>("PUT", path, body, opts?.rbac);
  }
  del<T>(path: string, opts?: { rbac?: boolean }): Promise<T> {
    return this.request<T>("DELETE", path, undefined, opts?.rbac);
  }

  /**
   * Upload a local file to the backend (multipart POST /api/v1/files/upload) and
   * return a FileRef ready to embed in a submit-evidence payload. `category` is a
   * free-form tag, e.g. "time_report" or "attachment".
   */
  async uploadFile(filePath: string, category: string, now: string = new Date().toISOString()): Promise<FileRef> {
    const data = readFileSync(filePath);
    const fileName = basename(filePath);
    const guessed = MIME_BY_EXT[extname(fileName).toLowerCase()] ?? "application/octet-stream";
    const form = new FormData();
    // Blob copy keeps types happy across the Buffer/ArrayBuffer boundary.
    form.append("file", new Blob([new Uint8Array(data)], { type: guessed }), fileName);
    // Note: no Content-Type header — fetch sets the multipart boundary itself.
    const uploadHeaders: Record<string, string> = { "X-User-AID": this.actingAid };
    if (this.apiToken) uploadHeaders["Authorization"] = `Bearer ${this.apiToken}`;
    const res = await this.fetchFn(`${this.baseUrl}/api/v1/files/upload`, {
      method: "POST",
      // Note: no Content-Type — fetch sets the multipart boundary itself.
      headers: uploadHeaders,
      body: form,
    });
    const text = await res.text();
    let parsed: Record<string, unknown> = {};
    try {
      parsed = text ? (JSON.parse(text) as Record<string, unknown>) : {};
    } catch {
      parsed = {};
    }
    if (!res.ok || !parsed.fileRef) {
      throw new MatouApiError(mapError(res.status, parsed), res.status, parsed);
    }
    return {
      file_ref: String(parsed.fileRef),
      file_name: fileName,
      content_type: String(parsed.contentType ?? guessed),
      size: Number(parsed.size ?? data.length),
      category,
      uploaded_by: this.actingAid,
      uploaded_at: now,
    };
  }

  private async request<T>(method: string, path: string, body?: unknown, rbac = false): Promise<T> {
    const headers = this.baseHeaders();
    if (rbac) headers["X-User-AID"] = this.actingAid;
    const res = await this.fetchFn(`${this.baseUrl}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let parsed: unknown = undefined;
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = text;
      }
    }
    const hasErrorField = parsed && typeof parsed === "object" && "error" in parsed;
    if (!res.ok || hasErrorField) {
      throw new MatouApiError(mapError(res.status, parsed), res.status, parsed);
    }
    return parsed as T;
  }
}

export function discoverPortFromSs(ssOutput: string): number | null {
  return discoverPortsFromSs(ssOutput)[0] ?? null;
}

/** Every loopback port the matou-backend process listens on, per `ss -tlnp`. */
export function discoverPortsFromSs(ssOutput: string): number[] {
  const ports: number[] = [];
  for (const line of ssOutput.split("\n")) {
    if (!line.includes("matou-backend")) continue;
    const m = line.match(/127\.0\.0\.1:(\d+)\b/);
    if (m) ports.push(Number(m[1]));
  }
  return [...new Set(ports)];
}

/**
 * Parse `lsof -nP -iTCP -sTCP:LISTEN` output (macOS) for the matou-backend
 * loopback listener. The column layout differs from `ss`: COMMAND is the first
 * token and the address lives in the trailing NAME column, so we match line by
 * line rather than reuse the `ss` regex. lsof truncates COMMAND to ~9 chars by
 * default ("matou-bac"), so match on that prefix.
 */
export function discoverPortFromLsof(lsofOutput: string): number | null {
  return discoverPortsFromLsof(lsofOutput)[0] ?? null;
}

/** Every loopback port the matou-backend process listens on, per `lsof`. */
export function discoverPortsFromLsof(lsofOutput: string): number[] {
  const ports: number[] = [];
  for (const line of lsofOutput.split("\n")) {
    if (!/^matou-bac/.test(line)) continue;
    const m = line.match(/\b127\.0\.0\.1:(\d+)\b/);
    if (m) ports.push(Number(m[1]));
  }
  return [...new Set(ports)];
}

/** The platform-native listener query and its parser. */
function listenerDiscovery(): { run: () => string; parse: (out: string) => number[] } {
  if (process.platform === "darwin") {
    return {
      run: () => execFileSync("lsof", ["-nP", "-iTCP", "-sTCP:LISTEN", "+c", "0"], { encoding: "utf8" }),
      parse: discoverPortsFromLsof,
    };
  }
  return {
    run: () => execFileSync("ss", ["-tlnp"], { encoding: "utf8" }),
    parse: discoverPortsFromSs,
  };
}

/**
 * True when a /health body is the Matou API's own health response
 * (`{"status":"healthy",...}`, backend/internal/api/health.go). The backend
 * process also listens on helper ports (e.g. the KERI proxy) whose /health
 * answers differently, so "first matou-backend port" is not enough (#588).
 */
export function isMatouApiHealth(body: string): boolean {
  try {
    const parsed = JSON.parse(body) as Record<string, unknown>;
    return parsed?.status === "healthy";
  } catch {
    return false;
  }
}

export async function resolveBackend(
  fetchFn: FetchFn = fetch as unknown as FetchFn,
  runListeners?: () => string,
): Promise<{ baseUrl: string; env: MatouEnv }> {
  const override = process.env.MATOU_BACKEND_URL;
  if (override) {
    const baseUrl = override.replace(/\/$/, "");
    const res = await fetchFn(`${baseUrl}/health`);
    if (!res.ok) throw new Error(`Matou backend at ${baseUrl} is not healthy (status ${res.status}).`);
    return { baseUrl, env: detectEnv(baseUrl) };
  }

  const { run, parse } = listenerDiscovery();
  const runCmd = runListeners ?? run;
  // A missing command (e.g. no `ss` on macOS) or a failed query must fall
  // through to the actionable error below, not surface a raw ENOENT.
  let ports: number[] = [];
  try {
    ports = parse(runCmd());
  } catch {
    ports = [];
  }
  if (ports.length === 0) {
    throw new Error("No running matou-backend found — is the Matou app open? Or set MATOU_BACKEND_URL.");
  }
  for (const port of ports) {
    const baseUrl = `http://127.0.0.1:${port}`;
    try {
      const res = await fetchFn(`${baseUrl}/health`);
      if (res.ok && isMatouApiHealth(await res.text())) {
        return { baseUrl, env: detectEnv(baseUrl) };
      }
    } catch {
      // Port closed or not HTTP — try the next one.
    }
  }
  throw new Error(
    `matou-backend is listening on ${ports.join(", ")} but none answered /health as the Matou API. Set MATOU_BACKEND_URL.`,
  );
}

/**
 * Ask the running backend which identity it holds (GET /api/v1/identity, a
 * read — no API token needed). Returns undefined when unavailable. This is the
 * only way to learn the AID when identity.json is encrypted at rest (#117),
 * which it is whenever the OS keyring is available (always on macOS).
 */
export async function fetchBackendAid(
  baseUrl: string,
  fetchFn: FetchFn = fetch as unknown as FetchFn,
): Promise<string | undefined> {
  try {
    const res = await fetchFn(`${baseUrl}/api/v1/identity`);
    if (!res.ok) return undefined;
    const parsed = JSON.parse(await res.text()) as Record<string, unknown>;
    return typeof parsed.aid === "string" && parsed.aid ? parsed.aid : undefined;
  } catch {
    return undefined;
  }
}
