import { describe, it, expect, vi } from "vitest";
import { listMyTasks } from "../src/tools/reads.js";
import { MatouClient } from "../src/backend.js";
import { MemberDirectory } from "../src/members.js";

function ctx(responses: Record<string, unknown>) {
  const fetchFn = vi.fn(async (url: string) => {
    const path = url.replace("http://x", "");
    return { ok: true, status: 200, text: async () => JSON.stringify(responses[path] ?? {}) };
  });
  return {
    client: new MatouClient("http://x", "EBEN", fetchFn as any),
    config: { baseUrl: "http://x", actingAid: "EBEN", env: "test" as const, readonly: false },
    members: new MemberDirectory([{ aid: "EBEN", name: "Ben" }]),
  };
}

describe("listMyTasks", () => {
  it("returns only contributions assigned/offered to the acting AID, grouped by status", async () => {
    const c = ctx({
      "/api/v1/projects": { projects: [{ id: "proj_1" }] },
      "/api/v1/projects/proj_1/contributions": {
        contributions: [
          { id: "ctr_a", title: "Mine", status: "assigned", assigned_contributor: "EBEN" },
          { id: "ctr_b", title: "Theirs", status: "assigned", assigned_contributor: "EX" },
          { id: "ctr_c", title: "Offered", status: "offered", offered_to: "EBEN" },
        ],
      },
    });
    const result = (await listMyTasks(c)) as Record<string, unknown[]>;
    expect(result.assigned).toHaveLength(1);
    expect((result.assigned[0] as { id: string }).id).toBe("ctr_a");
    expect(result.offered).toHaveLength(1);
  });
});
