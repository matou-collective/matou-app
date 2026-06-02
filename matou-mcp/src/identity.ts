import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type MatouEnv = "dev" | "test" | "prod" | "unknown";

type ReadFile = (path: string) => string;
const defaultRead: ReadFile = (p) => readFileSync(p, "utf8");

export function resolveActingAid(readFile: ReadFile = defaultRead): string {
  const override = process.env.MATOU_USER_AID;
  if (override) return override;
  const path = join(homedir(), ".config", "Matou", "matou-data", "identity.json");
  try {
    const aid = JSON.parse(readFile(path)).aid;
    if (!aid || typeof aid !== "string") throw new Error("no aid field");
    return aid;
  } catch (e) {
    throw new Error(`Couldn't read identity.json — set MATOU_USER_AID. (${(e as Error).message})`);
  }
}

export function detectEnv(baseUrl: string): MatouEnv {
  const m = baseUrl.match(/:(\d+)/);
  if (!m) return "unknown";
  if (m[1] === "8080") return "dev";
  if (m[1] === "9080") return "test";
  return "prod";
}
