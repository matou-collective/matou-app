import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolContext } from "../context.js";
import { defineTool } from "../register.js";
import { MatouApiError, type FileRef } from "../backend.js";
import { REVIEW_DECISIONS, validateEnum, buildDerivationNote } from "../rules.js";

interface SubmitArgs {
  contribution_id: string;
  completion_notes: string;
  actual_hours?: number;
  actual_amount?: number;
  evidence_urls?: string[];
  acceptance_notes?: string[];
  time_report_path?: string;
  attachment_paths?: string[];
}

export async function submitForReview(ctx: ToolContext, args: SubmitArgs): Promise<unknown> {
  const path = `/api/v1/contributions/${args.contribution_id}/submit-evidence`;
  const payload: Record<string, unknown> = { completion_notes: args.completion_notes };
  if (args.evidence_urls) payload.evidence_urls = args.evidence_urls;
  if (args.acceptance_notes) payload.acceptance_notes = args.acceptance_notes;
  if (args.actual_amount !== undefined) payload.actual_cost = args.actual_amount;
  if (args.actual_hours !== undefined) payload.actual_duration = args.actual_hours;
  // Upload any local files first and embed them as FileRefs.
  if (args.time_report_path) {
    payload.time_report_file = await ctx.client.uploadFile(args.time_report_path, "time_report");
  }
  if (args.attachment_paths && args.attachment_paths.length > 0) {
    const refs: FileRef[] = [];
    for (const p of args.attachment_paths) refs.push(await ctx.client.uploadFile(p, "attachment"));
    payload.attachment_files = refs;
  }
  try {
    return await ctx.client.post(path, payload, { rbac: true });
  } catch (err) {
    const fractional = args.actual_hours !== undefined && !Number.isInteger(args.actual_hours);
    const isDecodeErr =
      err instanceof MatouApiError &&
      err.status === 400 &&
      /invalid request body/i.test(String((err.body as { error?: string })?.error ?? ""));
    if (!isDecodeErr || !fractional) throw err;
    const rounded = Math.round(args.actual_hours as number);
    const note = buildDerivationNote(args.actual_hours as number, args.actual_amount);
    const retry = { ...payload, actual_duration: rounded, completion_notes: `${args.completion_notes}\n\n${note}` };
    const result = (await ctx.client.post(path, retry, { rbac: true })) as Record<string, unknown>;
    return {
      ...result,
      _note: `Backend rejected fractional hours; stored ${rounded}h and recorded the exact figure in completion notes.`,
    };
  }
}

export function registerWorkflowTools(server: McpServer, ctx: ToolContext): void {
  defineTool(
    server,
    ctx,
    {
      name: "offer_contribution",
      description:
        "Offer a contribution to a member (name/AID). Handles created->confirmed->offered. Requires a deadline; pass `deadline` (YYYY-MM-DD) if the contribution has none.",
      schema: { contribution_id: z.string(), to: z.string(), deadline: z.string().optional() },
      mutating: true,
    },
    async (args) => {
      const id = args.contribution_id as string;
      const c = await ctx.client.get<{ status: string; deadline?: string | null }>(`/api/v1/contributions/${id}`);
      const aid = ctx.members.resolve(args.to as string);
      const name = ctx.members.name(aid) ?? (args.to as string);
      if (!c.deadline && !args.deadline) {
        throw new Error("This contribution has no deadline; offering requires one. Pass `deadline` (YYYY-MM-DD).");
      }
      if (args.deadline) {
        await ctx.client.put(`/api/v1/contributions/${id}`, { deadline: args.deadline }, { rbac: true });
      }
      if (c.status === "created") {
        await ctx.client.post(`/api/v1/contributions/${id}/transition`, { status: "confirmed" }, { rbac: true });
      } else if (c.status !== "confirmed" && c.status !== "shared") {
        throw new Error(`Can only offer from created/confirmed/shared; current status is "${c.status}".`);
      }
      return ctx.client.post(`/api/v1/contributions/${id}/offer`, { offered_to: aid, offered_to_name: name }, { rbac: true });
    },
  );

  defineTool(
    server,
    ctx,
    {
      name: "assign_contribution",
      description:
        "Assign a contribution directly to a member (name/AID). Works from status confirmed/shared. " +
        "To re-open a needs_review/incomplete contribution back to assigned, use review_contribution " +
        "(decision: incomplete) then the transition endpoint, not this tool.",
      schema: { contribution_id: z.string(), to: z.string() },
      mutating: true,
    },
    async (args) => {
      const aid = ctx.members.resolve(args.to as string);
      // Backend HandleAssign expects `user_id` (NOT `assigned_contributor_id`).
      return ctx.client.post(
        `/api/v1/contributions/${args.contribution_id as string}/assign`,
        { user_id: aid },
        { rbac: true },
      );
    },
  );

  defineTool(
    server,
    ctx,
    {
      name: "submit_for_review",
      description:
        "Submit an ASSIGNED contribution for review. Before calling, first `get_contribution` to read its " +
        "`deliverables` and `acceptance_criteria`, then structure the submission to match them:\n" +
        "• completion_notes — describe the work and explicitly name how each DELIVERABLE was produced.\n" +
        "• acceptance_notes — one entry PER acceptance criterion, stating how it was met (same order as the criteria).\n" +
        "• actual_hours / actual_amount — actual time and cost (amount = hours × rate).\n" +
        "ALWAYS prompt the user to provide, for THIS contribution, (a) a time report and (b) any supporting " +
        "attachments, then pass them as local file paths: `time_report_path` and `attachment_paths` (uploaded " +
        "automatically). `evidence_urls` is for links (e.g. GitLab MRs/commits). " +
        "Auto-handles backends that only accept whole hours.",
      schema: {
        contribution_id: z.string(),
        completion_notes: z.string(),
        actual_hours: z.number().optional(),
        actual_amount: z.number().optional(),
        evidence_urls: z.array(z.string()).optional(),
        acceptance_notes: z.array(z.string()).optional(),
        time_report_path: z.string().optional(),
        attachment_paths: z.array(z.string()).optional(),
      },
      mutating: true,
    },
    (args) => submitForReview(ctx, args as unknown as SubmitArgs),
  );

  defineTool(
    server,
    ctx,
    {
      name: "review_contribution",
      description: "Review a contribution that needs review. decision must be one of: approved, incomplete, declined.",
      schema: { contribution_id: z.string(), decision: z.string(), review_notes: z.string().optional(), quality_rating: z.number().optional() },
      mutating: true,
    },
    async (args) => {
      validateEnum("decision", args.decision as string, REVIEW_DECISIONS);
      const body: Record<string, unknown> = { decision: args.decision, review_notes: args.review_notes ?? "" };
      if (args.quality_rating !== undefined) body.quality_rating = args.quality_rating;
      return ctx.client.post(`/api/v1/contributions/${args.contribution_id as string}/review`, body, { rbac: true });
    },
  );

  defineTool(
    server,
    ctx,
    {
      name: "sign_off_contribution",
      description: "Sign off an approved contribution (approved -> signed_off).",
      schema: { contribution_id: z.string() },
      mutating: true,
    },
    async (args) => ctx.client.post(`/api/v1/contributions/${args.contribution_id as string}/sign-off`, {}, { rbac: true }),
  );

  defineTool(
    server,
    ctx,
    {
      name: "archive_contribution",
      description: "Archive a contribution. IRREVERSIBLE — the contribution is removed from active views.",
      schema: { contribution_id: z.string() },
      mutating: true,
    },
    async (args) => ctx.client.post(`/api/v1/contributions/${args.contribution_id as string}/archive`, {}, { rbac: true }),
  );
}
