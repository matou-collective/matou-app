import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolContext } from "../context.js";
import { defineTool } from "../register.js";

interface Contribution {
  id: string;
  title: string;
  status: string;
  milestone_id?: string;
  assigned_contributor?: string;
  offered_to?: string;
}

async function allContributions(ctx: ToolContext): Promise<Contribution[]> {
  const { projects } = await ctx.client.get<{ projects: { id: string }[] }>("/api/v1/projects");
  const out: Contribution[] = [];
  for (const p of projects ?? []) {
    const { contributions } = await ctx.client.get<{ contributions: Contribution[] }>(
      `/api/v1/projects/${p.id}/contributions`,
    );
    out.push(...(contributions ?? []));
  }
  return out;
}

export async function listMyTasks(ctx: ToolContext): Promise<Record<string, Contribution[]>> {
  const aid = ctx.config.actingAid;
  const mine = (await allContributions(ctx)).filter(
    (c) => c.assigned_contributor === aid || c.offered_to === aid,
  );
  const grouped: Record<string, Contribution[]> = {};
  for (const c of mine) (grouped[c.status] ??= []).push(c);
  return grouped;
}

export function registerReadTools(server: McpServer, ctx: ToolContext): void {
  defineTool(
    server,
    ctx,
    { name: "list_projects", description: "List all projects (id, title, status, lead, steward).", schema: {}, mutating: false },
    async () => {
      const { projects } = await ctx.client.get<{ projects: unknown[] }>("/api/v1/projects");
      return projects;
    },
  );

  defineTool(
    server,
    ctx,
    {
      name: "get_project",
      description: "Get a project with its implementation plan, milestones, and contributions.",
      schema: { project_id: z.string() },
      mutating: false,
    },
    async (args) => {
      const id = args.project_id as string;
      const [project, plans, contributions] = await Promise.all([
        ctx.client.get(`/api/v1/projects/${id}`),
        ctx.client.get(`/api/v1/implementation-plans?project_id=${id}`),
        ctx.client.get(`/api/v1/projects/${id}/contributions`),
      ]);
      return { project, plans, contributions };
    },
  );

  defineTool(
    server,
    ctx,
    {
      name: "list_contributions",
      description: "List a project's contributions, optionally filtered by status, assignee (name/AID), or milestone_id.",
      schema: {
        project_id: z.string(),
        status: z.string().optional(),
        assignee: z.string().optional(),
        milestone_id: z.string().optional(),
      },
      mutating: false,
    },
    async (args) => {
      const { contributions } = await ctx.client.get<{ contributions: Contribution[] }>(
        `/api/v1/projects/${args.project_id as string}/contributions`,
      );
      let rows = contributions ?? [];
      if (args.status) rows = rows.filter((c) => c.status === args.status);
      if (args.milestone_id) rows = rows.filter((c) => c.milestone_id === args.milestone_id);
      if (args.assignee) {
        const aid = ctx.members.resolve(args.assignee as string);
        rows = rows.filter((c) => c.assigned_contributor === aid);
      }
      return rows;
    },
  );

  defineTool(
    server,
    ctx,
    { name: "get_contribution", description: "Get a single contribution by id.", schema: { contribution_id: z.string() }, mutating: false },
    async (args) => ctx.client.get(`/api/v1/contributions/${args.contribution_id as string}`),
  );

  defineTool(
    server,
    ctx,
    { name: "list_my_tasks", description: "List contributions assigned or offered to you, grouped by status.", schema: {}, mutating: false },
    () => listMyTasks(ctx),
  );

  defineTool(
    server,
    ctx,
    {
      name: "resolve_member",
      description: "List members and their AIDs, or resolve one name/AID. Pass `query` to resolve, omit to list all.",
      schema: { query: z.string().optional() },
      mutating: false,
    },
    async (args) => {
      if (args.query) {
        const aid = ctx.members.resolve(args.query as string);
        return { aid, name: ctx.members.name(aid) ?? "(unknown)" };
      }
      return ctx.members.list();
    },
  );
}
