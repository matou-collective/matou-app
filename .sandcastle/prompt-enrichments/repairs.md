- Commit and push fixes to `.sandcastle/`, `.forgejo/`, `pnpm-lock.yaml`
  (root workspace), `frontend/package-lock.json`, root config plumbing. Work
  in a FRESH clone:
  `git clone ~/swarm/Matou/matou-app /tmp/heal-fix && cd /tmp/heal-fix`,
  fix, rebase on origin/main, push to main. Never force-push, never revert
  a human's commit.
- Regenerate a lockfile from its own manifest (`pnpm install --lockfile-only`
  at the root, `npm install --package-lock-only` in `frontend/`).
- Clean stuck git state in the workdir (abort rebase, `reset --hard
  origin/main`) — ONLY if `swarm-lock.txt` says `free`.
- Verify your fix: re-run the failing command, or
  `POST $FORGEJO_API/../../actions/workflows/<file>/dispatches {"ref":"main"}`.
- Label management on issues you file or that this incident already owns
  (e.g. add `ready-for-agent`) — never relabel unrelated issues.
