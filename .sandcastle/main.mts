import { run, claudeCode } from "@ai-hero/sandcastle";
import { docker } from "@ai-hero/sandcastle/sandboxes/docker";

// Loop: pick ready tasks one by one, implement, open a PR per issue.
// Task source: .sandcastle/list-ready-tasks.sh via the shell expression in
// prompt.md. Run with: npm run sandcastle

await run({
  name: "worker",

  // Secrets ride in as read-only files under /run/secrets, not env vars —
  // env vars land in `docker inspect .Config.Env`, readable by anyone with
  // Docker API access (see docs/architecture/07-secrets-architecture.md).
  // run-swarm.sh materializes .sandcastle/secrets/* before every run.
  // CLAUDE_CODE_OAUTH_TOKEN stays an env var (the claude CLI has no
  // file-based option) — documented residual exposure, rotate it.
  sandbox: docker({
    mounts: [
      { hostPath: ".sandcastle/secrets", sandboxPath: "/run/secrets", readonly: true },
      // Persistent caches shared by every worker container.
      { hostPath: ".sandcastle/npm-cache", sandboxPath: "/home/agent/.npm", readonly: false },
      { hostPath: ".sandcastle/go-cache", sandboxPath: "/home/agent/go/pkg/mod", readonly: false },
    ],
  }),

  // opus balances capability against subscription quota for continuous use
  // (fable-class models exhaust the usage window fastest under sustained
  // swarm load; the limit guard handles it, but opus stretches the window).
  agent: claudeCode("claude-opus-4-8"),

  promptFile: "./.sandcastle/prompt.md",
  maxIterations: 3,
  branchStrategy: { type: "merge-to-head" },

  hooks: {
    sandbox: {
      // Warm the frontend install before the agent starts; CI=true keeps npm
      // non-interactive; `npm ci` enforces the lockfile. Go modules download
      // lazily into the mounted cache during build/test.
      onSandboxReady: [
        { command: "CI=true npm ci --prefix frontend --cache /home/agent/.npm" },
      ],
    },
  },
});
