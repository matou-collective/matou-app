import { describe, it, expect, vi } from "vitest";
import { createNotice } from "../src/tools/notices.js";
import { MatouClient } from "../src/backend.js";
import { MemberDirectory } from "../src/members.js";

function recordingCtx() {
  const calls: any[] = [];
  const fetchFn = vi.fn(async (url: string, init: any) => {
    calls.push({ url, init });
    return { ok: true, status: 200, text: async () => '{"success":true,"noticeId":"n1"}' };
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

describe("createNotice", () => {
  it("rejects an invalid type before calling the backend", async () => {
    const { ctx, calls } = recordingCtx();
    await expect(
      createNotice(ctx, { type: "memo", title: "T", summary: "S" }),
    ).rejects.toThrowError(/type must be one of: event, update, announcement/);
    expect(calls).toHaveLength(0);
  });

  it("sends an event notice with state published when publish=true", async () => {
    const { ctx, calls } = recordingCtx();
    await createNotice(ctx, {
      type: "event",
      title: "Hui",
      summary: "Monthly hui",
      eventStart: "2026-06-01T18:00:00Z",
      publish: true,
    });
    const body = JSON.parse(calls[0].init.body);
    expect(body.type).toBe("event");
    expect(body.state).toBe("published");
    expect(body.eventStart).toBe("2026-06-01T18:00:00Z");
  });
});
