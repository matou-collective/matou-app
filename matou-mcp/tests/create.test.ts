import { describe, it, expect, vi } from "vitest";
import { addContribution } from "../src/tools/create.js";
import { MatouClient } from "../src/backend.js";
import { MemberDirectory } from "../src/members.js";

function recordingCtx(responseBody = '{"id":"ctr_new"}') {
  const calls: { url: string; init: any }[] = [];
  const fetchFn = vi.fn(async (url: string, init: any) => {
    calls.push({ url, init });
    return { ok: true, status: 200, text: async () => responseBody };
  });
  const ctx = {
    client: new MatouClient("http://x", "EBEN", fetchFn as any),
    config: { baseUrl: "http://x", actingAid: "EBEN", env: "test" as const, readonly: false },
    members: new MemberDirectory([{ aid: "EENGIE", name: "Engie M" }]),
  };
  return { ctx, calls };
}

describe("addContribution", () => {
  it("validates the contribution_type, resolves the assignee name, and sends X-User-AID", async () => {
    const { ctx, calls } = recordingCtx();
    await addContribution(ctx, {
      project_id: "proj_1",
      milestone_id: "ms_1",
      title: "T",
      description: "D",
      contribution_type: "research_knowledge",
      objectives: ["o"],
      deliverables: ["d"],
      assignee: "Engie M",
    });
    const body = JSON.parse(calls[0].init.body);
    expect(body.assigned_contributor_id).toBe("EENGIE");
    expect(body.created_by).toBe("EBEN");
    expect(calls[0].init.headers["X-User-AID"]).toBe("EBEN");
  });

  it("forwards parent_contribution for a sub-contribution with no milestone", async () => {
    const { ctx, calls } = recordingCtx();
    await addContribution(ctx, {
      project_id: "proj_1",
      parent_contribution: "ctr_parent",
      title: "T",
      description: "D",
      contribution_type: "research_knowledge",
      objectives: ["o"],
      deliverables: ["d"],
    });
    const body = JSON.parse(calls[0].init.body);
    expect(body.parent_contribution).toBe("ctr_parent");
    expect(body.milestone_id).toBeUndefined();
  });

  it("forwards tags to the backend", async () => {
    const { ctx, calls } = recordingCtx();
    await addContribution(ctx, {
      project_id: "proj_1",
      milestone_id: "ms_1",
      title: "T",
      description: "D",
      contribution_type: "research_knowledge",
      objectives: ["o"],
      deliverables: ["d"],
      tags: ["ref:2.1", "phase1"],
    });
    const body = JSON.parse(calls[0].init.body);
    expect(body.tags).toEqual(["ref:2.1", "phase1"]);
  });

  it("omits parent_contribution and tags when not supplied", async () => {
    const { ctx, calls } = recordingCtx();
    await addContribution(ctx, {
      project_id: "proj_1",
      milestone_id: "ms_1",
      title: "T",
      description: "D",
      contribution_type: "research_knowledge",
      objectives: ["o"],
      deliverables: ["d"],
    });
    const body = JSON.parse(calls[0].init.body);
    expect("parent_contribution" in body).toBe(false);
    expect("tags" in body).toBe(false);
  });

  it("rejects an invalid contribution_type before calling the backend", async () => {
    const { ctx, calls } = recordingCtx();
    await expect(
      addContribution(ctx, {
        project_id: "proj_1",
        title: "T",
        description: "D",
        contribution_type: "nonsense",
        objectives: ["o"],
        deliverables: ["d"],
      }),
    ).rejects.toThrowError(/contribution_type must be one of/);
    expect(calls).toHaveLength(0);
  });
});
