import { describe, it, expect, vi } from "vitest";
import { submitForReview, editContribution, registerWorkflowTools } from "../src/tools/workflow.js";
import { MatouClient, MatouApiError } from "../src/backend.js";
import { MemberDirectory } from "../src/members.js";

function ctxSeq(responses: { ok: boolean; status: number; body: string }[]) {
  const calls: any[] = [];
  let i = 0;
  const fetchFn = vi.fn(async (url: string, init: any) => {
    calls.push({ url, init });
    const r = responses[i++];
    return { ok: r.ok, status: r.status, text: async () => r.body };
  });
  const ctx = {
    client: new MatouClient("http://x", "EBEN", fetchFn as any),
    config: { baseUrl: "http://x", actingAid: "EBEN", env: "test" as const, readonly: false },
    members: new MemberDirectory([]),
  };
  return { ctx, calls };
}

describe("submitForReview fractional-hours fallback", () => {
  it("retries with rounded hours and a derivation note when the backend rejects a fraction", async () => {
    const { ctx, calls } = ctxSeq([
      { ok: false, status: 400, body: '{"error":"invalid request body"}' },
      { ok: true, status: 200, body: '{"status":"needs_review","actual_duration":24}' },
    ]);
    const result = (await submitForReview(ctx, {
      contribution_id: "ctr_1",
      completion_notes: "done",
      actual_hours: 24.375,
      actual_amount: 1950,
    })) as Record<string, unknown>;
    const retryBody = JSON.parse(calls[1].init.body);
    expect(retryBody.actual_duration).toBe(24);
    expect(retryBody.actual_cost).toBe(1950);
    expect(retryBody.completion_notes).toMatch(/24.375 hrs @ \$80.00\/hr = \$1950/);
    expect(result._note).toMatch(/fractional hours/);
  });

  it("does not retry for an integer hours value", async () => {
    const { ctx, calls } = ctxSeq([{ ok: false, status: 400, body: '{"error":"invalid request body"}' }]);
    await expect(
      submitForReview(ctx, { contribution_id: "ctr_1", completion_notes: "x", actual_hours: 24 }),
    ).rejects.toThrow();
    expect(calls).toHaveLength(1);
  });
});

function editCtx(members: { aid: string; name: string }[] = []) {
  return (responses: { ok: boolean; status: number; body: string }[]) => {
    const calls: any[] = [];
    let i = 0;
    const fetchFn = vi.fn(async (url: string, init: any) => {
      calls.push({ url, init });
      const r = responses[i++];
      return { ok: r.ok, status: r.status, text: async () => r.body };
    });
    const ctx = {
      client: new MatouClient("http://x", "EBEN", fetchFn as any),
      config: { baseUrl: "http://x", actingAid: "EBEN", env: "test" as const, readonly: false },
      members: new MemberDirectory(members),
    };
    return { ctx, calls };
  };
}

describe("editContribution", () => {
  it("PUTs only the supplied fields with rbac and resolves assignee names", async () => {
    const { ctx, calls } = editCtx([{ aid: "EABC", name: "Hemi" }])([
      { ok: true, status: 200, body: '{"id":"ctr_1","title":"New title"}' },
    ]);
    const result = (await editContribution(ctx, {
      contribution_id: "ctr_1",
      title: "New title",
      deadline: "2026-12-01",
      assignee: "Hemi",
    })) as Record<string, unknown>;
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("http://x/api/v1/contributions/ctr_1");
    expect(calls[0].init.method).toBe("PUT");
    expect(calls[0].init.headers["X-User-AID"]).toBe("EBEN");
    const body = JSON.parse(calls[0].init.body);
    expect(body).toEqual({ title: "New title", deadline: "2026-12-01", assigned_contributor_id: "EABC" });
    expect(body.contribution_type).toBeUndefined();
    expect(body.description).toBeUndefined();
    expect(result.id).toBe("ctr_1");
  });

  it("maps estimated_hours to estimated_duration", async () => {
    const { ctx, calls } = editCtx()([{ ok: true, status: 200, body: "{}" }]);
    await editContribution(ctx, { contribution_id: "ctr_1", estimated_hours: 12 });
    expect(JSON.parse(calls[0].init.body)).toEqual({ estimated_duration: 12 });
  });

  it("throws without hitting the backend when no editable field is supplied", async () => {
    const { ctx, calls } = editCtx()([]);
    await expect(editContribution(ctx, { contribution_id: "ctr_1" })).rejects.toThrow(/at least one field/i);
    expect(calls).toHaveLength(0);
  });

  it("surfaces a backend permission-denied response as an error", async () => {
    const { ctx } = editCtx()([{ ok: false, status: 403, body: '{"error":"permission denied"}' }]);
    await expect(
      editContribution(ctx, { contribution_id: "ctr_1", title: "x" }),
    ).rejects.toBeInstanceOf(MatouApiError);
  });

  it("surfaces a not-found response as an error", async () => {
    const { ctx } = editCtx()([{ ok: false, status: 404, body: '{"error":"contribution not found"}' }]);
    await expect(
      editContribution(ctx, { contribution_id: "missing", title: "x" }),
    ).rejects.toThrow();
  });
});

describe("edit_contribution registration", () => {
  function fakeServer() {
    const tools: string[] = [];
    const server = { tool: vi.fn((name: string) => { tools.push(name); }) };
    return { server, tools };
  }
  function regCtx(readonly: boolean) {
    return {
      client: new MatouClient("http://x", "EBEN", (async () => ({ ok: true, status: 200, text: async () => "{}" })) as any),
      config: { baseUrl: "http://x", actingAid: "EBEN", env: "test" as const, readonly },
      members: new MemberDirectory([]),
    };
  }
  it("exposes edit_contribution as a mutating tool", () => {
    const { server, tools } = fakeServer();
    registerWorkflowTools(server as any, regCtx(false) as any);
    expect(tools).toContain("edit_contribution");
  });
  it("hides edit_contribution when readonly", () => {
    const { server, tools } = fakeServer();
    registerWorkflowTools(server as any, regCtx(true) as any);
    expect(tools).not.toContain("edit_contribution");
  });
});
