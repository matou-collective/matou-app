import { describe, it, expect, vi } from "vitest";
import { sendMessage } from "../src/tools/chat.js";
import { MatouClient } from "../src/backend.js";
import { MemberDirectory } from "../src/members.js";

function ctx(channels: { id: string; name: string }[]) {
  const calls: any[] = [];
  const fetchFn = vi.fn(async (url: string, init: any) => {
    calls.push({ url, init });
    if (url.endsWith("/api/v1/chat/channels")) {
      return { ok: true, status: 200, text: async () => JSON.stringify({ channels }) };
    }
    return { ok: true, status: 200, text: async () => '{"ok":true}' };
  });
  return {
    ctx: {
      client: new MatouClient("http://x", "EBEN", fetchFn as any),
      config: { baseUrl: "http://x", actingAid: "EBEN", env: "test" as const, readonly: false },
      members: new MemberDirectory([]),
    },
    calls,
  };
}

describe("sendMessage", () => {
  it("resolves a channel by name and posts content to its messages endpoint", async () => {
    const { ctx: c, calls } = ctx([{ id: "ch_general", name: "general" }]);
    await sendMessage(c, { channel: "general", content: "hi" });
    expect(calls[1].url).toBe("http://x/api/v1/chat/channels/ch_general/messages");
    expect(JSON.parse(calls[1].init.body).content).toBe("hi");
  });

  it("throws when the channel name is unknown", async () => {
    const { ctx: c } = ctx([{ id: "ch_general", name: "general" }]);
    await expect(sendMessage(c, { channel: "random", content: "hi" })).rejects.toThrowError(/No channel/);
  });
});
