import { execFileSync } from "node:child_process";
import { detectEnv, type MatouEnv } from "./identity.js";

export interface FetchResponse {
  ok: boolean;
  status: number;
  text: () => Promise<string>;
}
export type FetchFn = (url: string, init?: Record<string, unknown>) => Promise<FetchResponse>;

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
  ) {}

  get<T>(path: string): Promise<T> {
    return this.request<T>("GET", path);
  }
  post<T>(path: string, body: unknown, opts?: { rbac?: boolean }): Promise<T> {
    return this.request<T>("POST", path, body, opts?.rbac);
  }
  put<T>(path: string, body: unknown, opts?: { rbac?: boolean }): Promise<T> {
    return this.request<T>("PUT", path, body, opts?.rbac);
  }

  private async request<T>(method: string, path: string, body?: unknown, rbac = false): Promise<T> {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
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
