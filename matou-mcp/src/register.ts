import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ZodRawShape } from "zod";
import type { ToolContext } from "./context.js";

export interface ToolDef {
  name: string;
  description: string;
  schema: ZodRawShape;
  mutating: boolean;
}

// Registers a tool, hiding mutating tools when readonly. The handler returns any
// value; strings pass through, objects are pretty-printed as JSON text. Errors
// become an isError text result instead of crashing the transport.
export function defineTool(
  server: McpServer,
  ctx: ToolContext,
  def: ToolDef,
  handler: (args: Record<string, unknown>) => Promise<unknown>,
): void {
  if (def.mutating && ctx.config.readonly) return;
  server.tool(def.name, def.description, def.schema, async (args: Record<string, unknown>) => {
    try {
      const result = await handler(args);
      const text = typeof result === "string" ? result : JSON.stringify(result, null, 2);
      return { content: [{ type: "text" as const, text }] };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { content: [{ type: "text" as const, text: `Error: ${msg}` }], isError: true };
    }
  });
}
