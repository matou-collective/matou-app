import { describe, it, expect, vi } from "vitest";
import { defineTool } from "../src/register.js";
import { MatouClient } from "../src/backend.js";
import { MemberDirectory } from "../src/members.js";

function fakeServer() {
  const tools: string[] = [];
  const server = { tool: vi.fn((name: string) => { tools.push(name); }) };
  return { server, tools };
}
function ctx(readonly: boolean) {
  return {
    client: new MatouClient("http://x", "EBEN", (async () => ({ ok: true, status: 200, text: async () => "{}" })) as any),
    config: { baseUrl: "http://x", actingAid: "EBEN", env: "test" as const, readonly },
    members: new MemberDirectory([]),
  };
}

describe("defineTool readonly gating", () => {
  it("registers a mutating tool when not readonly", () => {
    const { server, tools } = fakeServer();
    defineTool(server as any, ctx(false) as any, { name: "m", description: "d", schema: {}, mutating: true }, async () => "ok");
    expect(tools).toContain("m");
  });
  it("skips a mutating tool when readonly", () => {
    const { server, tools } = fakeServer();
    defineTool(server as any, ctx(true) as any, { name: "m", description: "d", schema: {}, mutating: true }, async () => "ok");
    expect(tools).not.toContain("m");
  });
  it("always registers a non-mutating tool", () => {
    const { server, tools } = fakeServer();
    defineTool(server as any, ctx(true) as any, { name: "r", description: "d", schema: {}, mutating: false }, async () => "ok");
    expect(tools).toContain("r");
  });
});
