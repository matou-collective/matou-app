import { describe, it, expect, vi } from "vitest";
import {
  discoverPortFromSs,
  discoverPortFromLsof,
  discoverPortsFromLsof,
  discoverPortsFromSs,
  fetchBackendAid,
  isMatouApiHealth,
  MatouClient,
  MatouApiError,
  resolveBackend,
} from "../src/backend.js";

const SS = `LISTEN 0 4096 127.0.0.1:46505 0.0.0.0:* users:(("matou-backend",pid=1,fd=25))`;

// `lsof -nP -iTCP -sTCP:LISTEN +c 0` on macOS.
const LSOF = `COMMAND         PID  USER   FD   TYPE             DEVICE SIZE/OFF NODE NAME
matou-backend 54837 matou   25u  IPv4 0x1a2b3c4d5e6f7080      0t0  TCP 127.0.0.1:54837 (LISTEN)
matou-backend 54837 matou   26u  IPv4 0x1a2b3c4d5e6f7081      0t0  TCP 127.0.0.1:54846 (LISTEN)`;

const HEALTHY = JSON.stringify({ status: "healthy", organization: "EORG" });

function fakeFetch(status: number, body: string) {
  return vi.fn(async () => ({ ok: status >= 200 && status < 300, status, text: async () => body }));
}

describe("discoverPortFromSs", () => {
  it("extracts the matou-backend port", () => {
    expect(discoverPortFromSs(SS)).toBe(46505);
  });
  it("returns null when not present", () => {
    expect(discoverPortFromSs("LISTEN 0 4096 127.0.0.1:9080 ...")).toBeNull();
  });
});

describe("discoverPortFromLsof", () => {
  it("extracts the first matou-backend loopback port from lsof output", () => {
    expect(discoverPortFromLsof(LSOF)).toBe(54837);
  });
  it("handles the truncated COMMAND column (no +c 0)", () => {
    const truncated = `matou-bac 54837 matou 25u IPv4 0x0 0t0 TCP 127.0.0.1:54837 (LISTEN)`;
    expect(discoverPortFromLsof(truncated)).toBe(54837);
  });
  it("ignores other processes' listeners", () => {
    const other = `sshd 900 root 3u IPv4 0x0 0t0 TCP 127.0.0.1:22 (LISTEN)`;
    expect(discoverPortFromLsof(other)).toBeNull();
  });
});

describe("MatouClient", () => {
  it("adds X-User-AID on rbac calls", async () => {
    const f = fakeFetch(200, '{"id":"proj_1"}');
    const c = new MatouClient("http://x", "EBEN", f as any);
    await c.post("/api/v1/projects", { title: "t" }, { rbac: true });
    const init = (f.mock.calls[0] as any)[1];
    expect(init.headers["X-User-AID"]).toBe("EBEN");
  });
  it("sends the API token as a bearer header when configured", async () => {
    const f = fakeFetch(200, "{}");
    const c = new MatouClient("http://x", "EBEN", f as any, "tok-42");
    await c.post("/api/v1/projects", { title: "t" }, { rbac: true });
    const init = (f.mock.calls[0] as any)[1];
    expect(init.headers["Authorization"]).toBe("Bearer tok-42");
    expect(init.headers["X-User-AID"]).toBe("EBEN");
  });
  it("omits the Authorization header when no token is configured", async () => {
    const f = fakeFetch(200, "{}");
    const c = new MatouClient("http://x", "EBEN", f as any);
    await c.get("/api/v1/projects");
    const init = (f.mock.calls[0] as any)[1];
    expect(init.headers["Authorization"]).toBeUndefined();
  });
  it("maps a 401 to a helpful message", async () => {
    const c = new MatouClient("http://x", "EBEN", fakeFetch(401, '{"error":"X-User-AID header required"}') as any);
    await expect(c.get("/api/v1/projects")).rejects.toThrowError(/Identity not configured/);
  });
  it("throws when a 200 body carries an error field", async () => {
    const c = new MatouClient("http://x", "EBEN", fakeFetch(200, '{"error":"bad"}') as any);
    await expect(c.get("/x")).rejects.toBeInstanceOf(MatouApiError);
  });
});

describe("resolveBackend", () => {
  it("uses MATOU_BACKEND_URL override and health-checks it", async () => {
    process.env.MATOU_BACKEND_URL = "http://127.0.0.1:9080/";
    const f = fakeFetch(200, "ok");
    const out = await resolveBackend(f as any, () => "");
    expect(out.baseUrl).toBe("http://127.0.0.1:9080");
    expect(out.env).toBe("test");
    delete process.env.MATOU_BACKEND_URL;
  });

  it("auto-discovers the backend from lsof output on macOS", async () => {
    const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
    Object.defineProperty(process, "platform", { value: "darwin", configurable: true });
    try {
      const f = fakeFetch(200, HEALTHY);
      const out = await resolveBackend(f as any, () => LSOF);
      expect(out.baseUrl).toBe("http://127.0.0.1:54837");
      expect((f.mock.calls[0] as any)[0]).toBe("http://127.0.0.1:54837/health");
    } finally {
      Object.defineProperty(process, "platform", platform);
    }
  });

  it("falls through to the actionable error when the discovery command is missing", async () => {
    delete process.env.MATOU_BACKEND_URL;
    const f = fakeFetch(200, "ok");
    const runListeners = () => {
      throw Object.assign(new Error("spawnSync ss ENOENT"), { code: "ENOENT" });
    };
    await expect(resolveBackend(f as any, runListeners)).rejects.toThrowError(/set MATOU_BACKEND_URL/);
  });

  it("skips matou-backend helper ports whose /health is not the Matou API", async () => {
    // #588: the backend listens on several ports; one answers a generic
    // health message, only one is the API.
    delete process.env.MATOU_BACKEND_URL;
    const f = vi.fn(async (url: string) => {
      const body = url.includes(":54837/")
        ? JSON.stringify({ message: "Health is okay" })
        : HEALTHY;
      return { ok: true, status: 200, text: async () => body };
    });
    const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
    Object.defineProperty(process, "platform", { value: "darwin", configurable: true });
    try {
      const out = await resolveBackend(f as any, () => LSOF);
      expect(out.baseUrl).toBe("http://127.0.0.1:54846");
    } finally {
      Object.defineProperty(process, "platform", platform);
    }
  });

  it("names the ports it tried when none is the Matou API", async () => {
    delete process.env.MATOU_BACKEND_URL;
    const f = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    });
    // SS is `ss` output, so pin the Linux parser — on a macOS host the
    // platform default would pick the lsof parser and find no ports.
    const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
    Object.defineProperty(process, "platform", { value: "linux", configurable: true });
    try {
      await expect(resolveBackend(f as any, () => SS)).rejects.toThrowError(/46505.*set MATOU_BACKEND_URL/i);
    } finally {
      Object.defineProperty(process, "platform", platform);
    }
  });
});

describe("multi-port parsers", () => {
  it("returns every matou-backend loopback port from lsof, deduped", () => {
    expect(discoverPortsFromLsof(LSOF + "\n" + LSOF.split("\n")[1])).toEqual([54837, 54846]);
  });
  it("returns every matou-backend loopback port from ss", () => {
    const two = SS + "\n" + SS.replace("46505", "46510");
    expect(discoverPortsFromSs(two)).toEqual([46505, 46510]);
  });
});

describe("isMatouApiHealth", () => {
  it("accepts the API's health body and rejects others", () => {
    expect(isMatouApiHealth(HEALTHY)).toBe(true);
    expect(isMatouApiHealth('{"message":"Health is okay"}')).toBe(false);
    expect(isMatouApiHealth("ok")).toBe(false);
  });
});

describe("fetchBackendAid", () => {
  it("reads the aid from GET /api/v1/identity", async () => {
    const f = fakeFetch(200, JSON.stringify({ configured: true, aid: "EBACKEND" }));
    expect(await fetchBackendAid("http://127.0.0.1:1", f as any)).toBe("EBACKEND");
    expect((f.mock.calls[0] as any)[0]).toBe("http://127.0.0.1:1/api/v1/identity");
  });
  it("returns undefined when the backend has no identity or errors", async () => {
    expect(await fetchBackendAid("http://x", fakeFetch(200, '{"configured":false}') as any)).toBeUndefined();
    expect(await fetchBackendAid("http://x", fakeFetch(500, "") as any)).toBeUndefined();
  });
});

