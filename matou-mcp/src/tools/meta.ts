import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolContext } from "../context.js";
import { defineTool } from "../register.js";

export async function statusReport(ctx: ToolContext): Promise<Record<string, unknown>> {
  let health = "unknown";
  try {
    const h = await ctx.client.get<{ status?: string }>("/health");
    health = h.status ?? "unknown";
  } catch (e) {
    health = `error: ${(e as Error).message}`;
  }
  return {
    baseUrl: ctx.config.baseUrl,
    env: ctx.config.env,
    actingAid: ctx.config.actingAid,
    actingName: ctx.members.name(ctx.config.actingAid) ?? "(unknown)",
    readonly: ctx.config.readonly,
    health,
  };
}

export function registerMetaTools(server: McpServer, ctx: ToolContext): void {
  defineTool(
    server,
    ctx,
    {
      name: "matou_status",
      description:
        "Report the connected Matou backend URL, target environment (prod/dev/test), the acting identity, readonly flag, and health. Use this first to confirm what you are about to read or write.",
      schema: {},
      mutating: false,
    },
    () => statusReport(ctx),
  );
}
