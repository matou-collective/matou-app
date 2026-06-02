import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolContext } from "../context.js";
import { defineTool } from "../register.js";
import { CONTRIBUTION_TYPES, PRIORITIES, validateEnum } from "../rules.js";

interface AddContributionArgs {
  project_id: string;
  milestone_id?: string;
  title: string;
  description: string;
  contribution_type: string;
  priority?: string;
  objectives: string[];
  deliverables: string[];
  acceptance_criteria?: string[];
  skill_requirements?: string[];
  assignee?: string;
  budget?: string;
  deadline?: string;
  estimated_hours?: number;
}

export async function addContribution(ctx: ToolContext, args: AddContributionArgs): Promise<unknown> {
  validateEnum("contribution_type", args.contribution_type, CONTRIBUTION_TYPES);
  if (args.priority) validateEnum("priority", args.priority, PRIORITIES);
  const payload: Record<string, unknown> = {
    project_id: args.project_id,
    title: args.title,
    description: args.description,
    contribution_type: args.contribution_type,
    priority: args.priority ?? "medium",
    objectives: args.objectives,
    deliverables: args.deliverables,
    created_by: ctx.config.actingAid,
  };
  if (args.milestone_id) payload.milestone_id = args.milestone_id;
  if (args.acceptance_criteria) payload.acceptance_criteria = args.acceptance_criteria;
  if (args.skill_requirements) payload.skill_requirements = args.skill_requirements;
  if (args.budget) payload.budget = args.budget;
  if (args.deadline) payload.deadline = args.deadline;
  if (args.estimated_hours !== undefined) payload.estimated_duration = args.estimated_hours;
  if (args.assignee) payload.assigned_contributor_id = ctx.members.resolve(args.assignee);
  return ctx.client.post("/api/v1/contributions", payload, { rbac: true });
}

export function registerCreateTools(server: McpServer, ctx: ToolContext): void {
  defineTool(
    server,
    ctx,
    {
      name: "create_project",
      description:
        "Create a project. Optionally create its implementation plan in the same call (create_plan=true). lead/steward accept a name or AID.",
      schema: {
        title: z.string(),
        description: z.string(),
        lead: z.string().optional(),
        steward: z.string().optional(),
        create_plan: z.boolean().optional(),
      },
      mutating: true,
    },
    async (args) => {
      const project = await ctx.client.post<{ id: string }>(
        "/api/v1/projects",
        { title: args.title, description: args.description, created_by: ctx.config.actingAid },
        { rbac: true },
      );
      let plan: unknown = undefined;
      if (args.create_plan) {
        const planBody: Record<string, unknown> = { project_id: project.id, total_budget: "" };
        if (args.lead) planBody.project_lead = ctx.members.resolve(args.lead as string);
        if (args.steward) planBody.project_steward_id = ctx.members.resolve(args.steward as string);
        plan = await ctx.client.post("/api/v1/implementation-plans", planBody, { rbac: true });
      }
      return { project, plan };
    },
  );

  defineTool(
    server,
    ctx,
    {
      name: "add_milestone",
      description:
        "Add a milestone (title, duration) to an implementation plan. Set dates separately with set_milestone_dates AFTER adding contributions.",
      schema: { plan_id: z.string(), title: z.string(), duration: z.string() },
      mutating: true,
    },
    async (args) =>
      ctx.client.post(
        `/api/v1/implementation-plans/${args.plan_id as string}/milestones`,
        { title: args.title, duration: args.duration },
        { rbac: true },
      ),
  );

  defineTool(
    server,
    ctx,
    {
      name: "set_milestone_dates",
      description:
        "Set a milestone's start/end dates (ISO YYYY-MM-DD). IMPORTANT: call this AFTER all the milestone's contributions are created — creating a contribution afterwards wipes milestone dates.",
      schema: { milestone_id: z.string(), start_date: z.string().optional(), end_date: z.string().optional() },
      mutating: true,
    },
    async (args) => {
      const body: Record<string, unknown> = {};
      if (args.start_date) body.start_date = args.start_date;
      if (args.end_date) body.end_date = args.end_date;
      return ctx.client.put(`/api/v1/milestones/${args.milestone_id as string}`, body, { rbac: true });
    },
  );

  defineTool(
    server,
    ctx,
    {
      name: "add_contribution",
      description:
        "Add a contribution to a project/milestone. contribution_type must be one of: " +
        CONTRIBUTION_TYPES.join(", ") +
        ". assignee accepts a name or AID.",
      schema: {
        project_id: z.string(),
        milestone_id: z.string().optional(),
        title: z.string(),
        description: z.string(),
        contribution_type: z.string(),
        priority: z.string().optional(),
        objectives: z.array(z.string()),
        deliverables: z.array(z.string()),
        acceptance_criteria: z.array(z.string()).optional(),
        skill_requirements: z.array(z.string()).optional(),
        assignee: z.string().optional(),
        budget: z.string().optional(),
        deadline: z.string().optional(),
        estimated_hours: z.number().optional(),
      },
      mutating: true,
    },
    (args) => addContribution(ctx, args as unknown as AddContributionArgs),
  );
}
