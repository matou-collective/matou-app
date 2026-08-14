# Sandcastle swarm — one-time admin setup

The Sandcastle swarm (`.sandcastle/`, `.forgejo/workflows/`) is code-complete
once its branch is merged, but it does nothing until a human completes the
steps below on git.matou.nz and Mattermost. Nothing here touches the
`matou-workstation` runner — it's already registered org-wide. Design:
`superpowers/specs/2026-07-31-sandcastle-swarm-design.md`.

## One-time admin steps (in order)

1. **Make Forgejo primary.** Add a `forgejo` remote
   (`git@git.matou.nz:Matou/matou-app.git` or the https equivalent) and push
   `main` (and the open feature branch). Then, in Repo Settings, set up
   **push-mirror → GitLab** (needs a GitLab access token) so GitLab keeps
   tracking the repo automatically from Forgejo.
2. In Repo Settings → Units: enable **Actions**; enable **issue
   dependencies**.
3. Create this label set (`bug`/`enhancement` already exist):
   - `needs-triage`
   - `needs-info`
   - `ready-for-agent`
   - `ready-for-human`
   - `wontfix`
   - `no-triage`
   - `agent-blocked`
   - `awaiting-verification`

   **Labels must be created at the repo level** (Matou/matou-app → Issues → Labels), not org-level — the poller and resume sweep resolve label IDs via the repo labels API (`/repos/.../labels`), which does not return org-level labels, so org-created labels would break the first approval.
4. Confirm these five org Actions secrets exist (they do — shared with
   `ourcloud`, same channel and bot):
   - `SWARM_FORGEJO_TOKEN`
   - `CLAUDE_CODE_OAUTH_TOKEN`
   - `MATTERMOST_URL`
   - `MATTERMOST_BOT_TOKEN`
   - `MATTERMOST_CHANNEL_ID`

   Confirm `SWARM_FORGEJO_TOKEN`'s PAT scopes cover PR creation
   (`write:repository` includes it).
5. **Confirm the runner has the synced Claude skills.** The `/triage` skill
   `triage.yml`'s headless `claude -p "/triage ..."` depends on does **not**
   live in this repo — it lives at `~/.claude/skills/triage` on the
   `matou-workstation` runner host, synced there from an operator's machine
   by `ourcloud`'s `.forgejo/runner/sync-skills.sh` (`$HOME/.claude/skills/`
   and `$HOME/.agents/skills/` → the runner, via `rsync --delete`). Confirm
   it's present before relying on triage; re-sync after any skill change
   with `bash .forgejo/runner/sync-skills.sh` run from an `ourcloud`
   checkout. Without this, `triage.yml` runs but its `/triage` invocation
   fails.
6. Nothing else to do on the workstation runner — it's registered at the org
   level and already picks up any repo with Actions enabled; step 5 above is
   the only runner-side dependency this port adds.

## Live smoke test

Run in order once the steps above are done, including step 5 (skill sync) —
without it, `triage.yml` fires on the cron/issue-open trigger but its
`/triage` call fails and step 2 below never happens:

1. File a test issue from the app's in-app reporter (bug or enhancement).
2. `triage.yml` should post an `awaiting-verification` Mattermost thread
   (`:mag: **Verify #<n>**`) within its `:05/:35` cron window.
3. Reply **approve** in that thread.
4. `verify.yml` (`:10` cron) should promote the issue to `ready-for-agent`
   within ~10 minutes.
5. `swarm.yml` should pick it up (label event, near-immediate) and open a PR
   referencing `closes #<n>`.
6. Merge the PR — confirm the issue closes and the GitLab mirror updates.
7. Repeat steps 1–3 with a **reject** reply instead — confirm the issue
   closes as `wontfix` and no PR is opened.
