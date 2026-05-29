import { describe, it, expect, vi } from "vitest";
import { submitForReview } from "../src/tools/workflow.js";
import { MatouClient } from "../src/backend.js";
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
