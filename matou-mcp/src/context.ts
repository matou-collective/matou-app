import type { MatouClient } from "./backend.js";
import type { MemberDirectory } from "./members.js";
import type { MatouEnv } from "./identity.js";

export interface BackendConfig {
  baseUrl: string;
  actingAid: string;
  env: MatouEnv;
  readonly: boolean;
}

export interface ToolContext {
  client: MatouClient;
  config: BackendConfig;
  members: MemberDirectory;
}
