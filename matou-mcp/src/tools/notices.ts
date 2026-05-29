import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolContext } from "../context.js";
import { defineTool } from "../register.js";
import { NOTICE_TYPES, validateEnum } from "../rules.js";

interface CreateNoticeArgs {
  type: string;
  title: string;
  summary: string;
  body?: string;
  publish?: boolean;
  eventStart?: string;
  eventEnd?: string;
  timezone?: string;
  locationText?: string;
  locationUrl?: string;
  rsvpEnabled?: boolean;
  activeFrom?: string;
  activeUntil?: string;
}

export async function createNotice(ctx: ToolContext, args: CreateNoticeArgs): Promise<unknown> {
  validateEnum("type", args.type, NOTICE_TYPES);
  const payload: Record<string, unknown> = {
    type: args.type,
    title: args.title,
    summary: args.summary,
    state: args.publish ? "published" : "draft",
  };
  if (args.body) payload.body = args.body;
  if (args.eventStart) payload.eventStart = args.eventStart;
  if (args.eventEnd) payload.eventEnd = args.eventEnd;
  if (args.timezone) payload.timezone = args.timezone;
  if (args.locationText) payload.locationText = args.locationText;
  if (args.locationUrl) payload.locationUrl = args.locationUrl;
  if (args.rsvpEnabled !== undefined) payload.rsvpEnabled = args.rsvpEnabled;
  if (args.activeFrom) payload.activeFrom = args.activeFrom;
  if (args.activeUntil) payload.activeUntil = args.activeUntil;
  return ctx.client.post("/api/v1/notices", payload);
}

export function registerNoticeTools(server: McpServer, ctx: ToolContext): void {
  defineTool(
    server,
    ctx,
    {
      name: "list_notices",
      description: "List notices. Optional `type` (event/update/announcement) and `view` (upcoming/current/past).",
      schema: { type: z.string().optional(), view: z.string().optional() },
      mutating: false,
    },
    async (args) => {
      const q = new URLSearchParams();
      if (args.type) q.set("type", args.type as string);
      if (args.view) q.set("view", args.view as string);
      const qs = q.toString();
      return ctx.client.get(`/api/v1/notices${qs ? `?${qs}` : ""}`);
    },
  );

  defineTool(
    server,
    ctx,
    {
      name: "create_notice",
      description:
        "Create a notice. type must be one of: event, update, announcement. title and summary required. Set publish=true to publish immediately (default draft). For events add eventStart/eventEnd/timezone/location/rsvp. Posts as the running app's identity.",
      schema: {
        type: z.string(),
        title: z.string(),
        summary: z.string(),
        body: z.string().optional(),
        publish: z.boolean().optional(),
        eventStart: z.string().optional(),
        eventEnd: z.string().optional(),
        timezone: z.string().optional(),
        locationText: z.string().optional(),
        locationUrl: z.string().optional(),
        rsvpEnabled: z.boolean().optional(),
        activeFrom: z.string().optional(),
        activeUntil: z.string().optional(),
      },
      mutating: true,
    },
    (args) => createNotice(ctx, args as unknown as CreateNoticeArgs),
  );

  defineTool(
    server,
    ctx,
    {
      name: "publish_notice",
      description: "Publish an existing draft notice (draft -> published).",
      schema: { notice_id: z.string() },
      mutating: true,
    },
    // NOTE: subpath confirmed via grep of notices.go — case "publish" at line 78.
    async (args) => ctx.client.post(`/api/v1/notices/${args.notice_id as string}/publish`, {}),
  );
}
