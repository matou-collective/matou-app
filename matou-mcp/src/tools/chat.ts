import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolContext } from "../context.js";
import { defineTool } from "../register.js";

interface Channel {
  id: string;
  name: string;
}
interface SendMessageArgs {
  channel: string;
  content: string;
  reply_to?: string;
}

async function resolveChannelId(ctx: ToolContext, channel: string): Promise<string> {
  const { channels } = await ctx.client.get<{ channels: Channel[] }>("/api/v1/chat/channels");
  const direct = (channels ?? []).find((c) => c.id === channel);
  if (direct) return direct.id;
  const byName = (channels ?? []).find((c) => c.name.toLowerCase() === channel.toLowerCase());
  if (!byName) {
    const names = (channels ?? []).map((c) => c.name).join(", ");
    throw new Error(`No channel matching "${channel}". Available: ${names || "(none)"}.`);
  }
  return byName.id;
}

export async function sendMessage(ctx: ToolContext, args: SendMessageArgs): Promise<unknown> {
  const channelId = await resolveChannelId(ctx, args.channel);
  const body: Record<string, unknown> = { content: args.content };
  if (args.reply_to) body.replyTo = args.reply_to;
  return ctx.client.post(`/api/v1/chat/channels/${channelId}/messages`, body);
}

export function registerChatTools(server: McpServer, ctx: ToolContext): void {
  defineTool(
    server,
    ctx,
    { name: "list_channels", description: "List chat channels (id, name).", schema: {}, mutating: false },
    async () => {
      const { channels } = await ctx.client.get<{ channels: Channel[] }>("/api/v1/chat/channels");
      return channels;
    },
  );

  defineTool(
    server,
    ctx,
    {
      name: "send_message",
      description:
        "Post a message to a chat channel (by name or id). Posts as the running app's identity. Use reply_to to thread.",
      schema: { channel: z.string(), content: z.string(), reply_to: z.string().optional() },
      mutating: true,
    },
    (args) => sendMessage(ctx, args as unknown as SendMessageArgs),
  );
}
