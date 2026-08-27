1. **One issue per iteration.** Do not touch other issues' territory.
   Before implementing, check for prior work:
   `curl -sf -H "Authorization: token $(cat /run/secrets/forgejo_token)" "$FORGEJO_API/pulls?state=all&limit=50"` —
   - An **open** PR from `agent/issue-<NUMBER>` already resolves this issue →
     do NOT open a duplicate. Verify the PR still addresses the issue, comment
     your verification on the issue, and stop.
   - A **closed but unmerged** PR from `agent/issue-<NUMBER>` exists → a human
     closed prior agent work without landing it. That is a
     `needs_human_decision` moment, NOT an invitation to redo it: swap the
     issue's label `ready-for-agent` → `ready-for-human`, comment on the issue
     linking the closed PR and asking whether to revive or abandon it, and
     stop working this issue — the resume sweep owns it from there.
     (Lesson of PR #21→#22: a re-served agent force-pushed over the closed
     PR's branch and destroyed unmerged work.)
2. **Reproduce before fixing** where feasible: for frontend logic bugs write
   a failing Vitest test first; for backend bugs a failing Go test. If the
   bug can't be reproduced without live infrastructure, say so in the PR
   body and reason from the code.
3. **Feature e2e spec — user-facing changes only.** Before implementing,
   create `frontend/tests/e2e/features/issue-<NUMBER>.spec.ts`. Import ONLY
   from `./fixtures` (`test`, `expect` — fixtures provide `adminPage` and
   `memberPage` as logged-in sessions, plus `snap`). Never register, log in,
   or create the org manually. Call `await snap(page, '<label>')` at each
   state that demonstrates the feature — these screenshots are what the
   human reviewer sees in Mattermost. You cannot RUN e2e here; validate
   syntax with:
   `cd frontend && npx playwright test --list tests/e2e/features/issue-<NUMBER>.spec.ts`
   For backend-only / docs / CI issues, skip the spec and put
   `**Feature e2e:** skipped — <reason>` in the PR body (exact marker — the
   pipeline reports it to Mattermost).
4. **Stay in scope.** Fix what the issue reports. No drive-by refactors, no
   dependency changes unless the fix requires one — and a dependency change
   ships its lockfile update (`package-lock.json` / `go.sum`) in the same
   commit.
5. **The human gate's guidance is the contract.** Each issue reached you only
   after a human verification pass; its comments carry the acceptance
   criteria, prior blocked-run rulings, and the reporter's context table (app
   version, platform, environment). Treat those as the pass/fail bar the
   reviewer will check — satisfy every clause, and do not re-litigate a
   decision a comment already records.
6. **If you hit anything in `needs_human_decision`, first check the issue's
   comments** — a prior blocked run may already record the human's ruling;
   if so, follow it without asking. **Then try to rule it yourself under
   the two-way-door rule** (ADR 0174 — the factory's inherited audit-trail
   doctrine; this repo carries no ADR file of its own, so the test IS the
   doctrine): if the decision is revertible by a later commit and provable by
   an existing test/e2e-spec/probe, and it is not on the one-way-door list
   (personal credentials, a security-posture widening, a member-facing trust
   accept, data destruction, non-routine spend), post the ruling to the issue
   — "Ruled by agent under ADR 0174 — veto anytime", the ruling, why it is a
   two-way door, and what proves it — and continue the task following it.
   Do not ask a human for a decision you can rule yourself this way.

   Otherwise — a genuine one-way door, or you are not confident the call
   qualifies as two-way — ask a human, **at most once per issue per
   iteration**, giving the Bash tool a 25-minute timeout so the wait is not
   killed mid-poll:

       bash .sandcastle/ask-human.sh "Question about #<NUMBER>: <the decision needed and the options as you see them>"

   The script posts to Mattermost and waits (default 20 min) for a direct
   reply in that message's thread; asks are keyed by the `#<NUMBER>` so a
   re-ask resumes the same thread. **Exit 0**: stdout is the human's answer —
   comment the question *and* answer onto the issue (the durable record), then
   continue the task following it. **Any other outcome** — a non-zero exit or
   the call being killed by a tool timeout: do NOT re-ask. Go straight to the
   blocked path in "When you are blocked" below — swap `ready-for-agent` →
   `ready-for-human`, comment what you need, and move on; a late reply is not
   lost, because the next ask for that issue resumes the same thread.
