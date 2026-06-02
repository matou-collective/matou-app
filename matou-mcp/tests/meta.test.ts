import { describe, it, expect, vi } from "vitest";
import { statusReport } from "../src/tools/meta.js";
import { MatouClient } from "../src/backend.js";
import { MemberDirectory } from "../src/members.js";

function ctxWith(healthBody: string) {
  const fetchFn = vi.fn(async () => ({ ok: true, status: 200, text: async () => healthBody }));
  return {
    client: new MatouClient("http://127.0.0.1:9080", "EBEN", fetchFn as any),
    config: { baseUrl: "http://127.0.0.1:9080", actingAid: "EBEN", env: "test" as const, readonly: false },
    members: new MemberDirectory([{ aid: "EBEN", name: "Ben" }]),
  };
}

describe("statusReport", () => {
  it("reports env, acting identity, and health", async () => {
    const report = await statusReport(ctxWith('{"status":"healthy"}'));
    expect(report).toMatchObject({
      env: "test",
      actingAid: "EBEN",
      actingName: "Ben",
      baseUrl: "http://127.0.0.1:9080",
      readonly: false,
      health: "healthy",
    });
  });
});
