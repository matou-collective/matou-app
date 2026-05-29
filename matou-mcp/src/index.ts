import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { resolveBackend, MatouClient } from "./backend.js";
import { resolveActingAid } from "./identity.js";
import { MemberDirectory } from "./members.js";
import type { BackendConfig, ToolContext } from "./context.js";
import { registerMetaTools } from "./tools/meta.js";
import { registerReadTools } from "./tools/reads.js";
import { registerCreateTools } from "./tools/create.js";
import { registerWorkflowTools } from "./tools/workflow.js";
import { registerChatTools } from "./tools/chat.js";
import { registerNoticeTools } from "./tools/notices.js";

async function buildContext(): Promise<ToolContext> {
  const { baseUrl, env } = await resolveBackend();
  const actingAid = resolveActingAid();
  const config: BackendConfig = {
    baseUrl,
    actingAid,
    env,
    readonly: process.env.MATOU_READONLY === "1",
  };
  const client = new MatouClient(baseUrl, actingAid);
  const members = await MemberDirectory.load(client);
  return { client, config, members };
}

async function main(): Promise<void> {
  const ctx = await buildContext();
  const server = new McpServer({ name: "matou", version: "0.1.0" });
  registerMetaTools(server, ctx);
  registerReadTools(server, ctx);
  registerCreateTools(server, ctx);
  registerWorkflowTools(server, ctx);
  registerChatTools(server, ctx);
  registerNoticeTools(server, ctx);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error(`[matou-mcp] fatal: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
