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
  const m = ssOutput.match(/127\.0\.0\.1:(\d+)\b[^\n]*matou-backend/);
  return m ? Number(m[1]) : null;
}

export async function resolveBackend(
  fetchFn: FetchFn = fetch as unknown as FetchFn,
  runSs: () => string = () => execFileSync("ss", ["-tlnp"], { encoding: "utf8" }),
): Promise<{ baseUrl: string; env: MatouEnv }> {
  const override = process.env.MATOU_BACKEND_URL;
  let baseUrl: string;
  if (override) {
    baseUrl = override.replace(/\/$/, "");
  } else {
    const port = discoverPortFromSs(runSs());
    if (!port) {
      throw new Error("No running matou-backend found — is the Matou app open? Or set MATOU_BACKEND_URL.");
    }
    baseUrl = `http://127.0.0.1:${port}`;
  }
  const res = await fetchFn(`${baseUrl}/health`);
  if (!res.ok) throw new Error(`Matou backend at ${baseUrl} is not healthy (status ${res.status}).`);
  return { baseUrl, env: detectEnv(baseUrl) };
}
