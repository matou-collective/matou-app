import { describe, it, expect, beforeAll } from "vitest";
import { resolveBackend, MatouClient } from "../src/backend.js";

// Opt-in: only runs when MATOU_SMOKE=1 AND the resolved backend is the test env.
const ENABLED = process.env.MATOU_SMOKE === "1";
const BEN = process.env.MATOU_USER_AID ?? "EM594BWV0KGDsJEeSA8DWwqgAATunu6krZWcXP0yfNqy";

describe.skipIf(!ENABLED)("smoke (test backend only)", () => {
  let client: MatouClient;

  beforeAll(async () => {
    const { baseUrl, env } = await resolveBackend();
    if (env !== "test") {
      throw new Error(`Smoke test refuses to run against env="${env}". Start the test backend (port 9080).`);
    }
    client = new MatouClient(baseUrl, BEN);
  });

  it("creates, reads, and hard-deletes a throwaway project", async () => {
    const project = await client.post<{ id: string }>(
      "/api/v1/projects",
      { title: "MCP smoke", description: "throwaway", created_by: "current-user" },
      { rbac: true },
    );
    expect(project.id).toMatch(/^proj_/);

    const list = await client.get<{ projects: { id: string }[] }>("/api/v1/projects");
    expect(list.projects.some((p) => p.id === project.id)).toBe(true);

    await client.del(`/api/v1/projects/${project.id}`, { rbac: true });
    const after = await client.get<{ projects: { id: string }[] }>("/api/v1/projects");
    expect(after.projects.some((p) => p.id === project.id)).toBe(false);
  });
});
