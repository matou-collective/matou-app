import { describe, it, expect, vi } from "vitest";
import { discoverPortFromSs, MatouClient, MatouApiError, resolveBackend } from "../src/backend.js";

const SS = `LISTEN 0 4096 127.0.0.1:46505 0.0.0.0:* users:(("matou-backend",pid=1,fd=25))`;

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

describe("MatouClient", () => {
  it("adds X-User-AID on rbac calls", async () => {
    const f = fakeFetch(200, '{"id":"proj_1"}');
    const c = new MatouClient("http://x", "EBEN", f as any);
    await c.post("/api/v1/projects", { title: "t" }, { rbac: true });
    const init = (f.mock.calls[0] as any)[1];
    expect(init.headers["X-User-AID"]).toBe("EBEN");
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
});
