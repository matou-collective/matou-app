1. **Verification inside this sandbox** — run what you changed:
   - frontend: `cd frontend && npm run test:script && npm run lint`
   - backend: `cd backend && go build ./... && make test`
   **Never** run e2e/Playwright/integration suites — they need live
   KERI/any-sync infrastructure this sandbox does not have. State in the PR
   body what you verified and what needs live testing.
2. **Land as a PR — never push main, never close the issue.**
   - branch: `git checkout -b agent/issue-<NUMBER>`. If the remote branch
     already exists with commits that are not yours, STOP — never force-push
     an existing `agent/issue-<NUMBER>` branch (that erases unmerged work;
     see the closed-PR case in the Rules). A rejected non-fast-forward push
     means the same thing: park the issue for a human instead.
   - commit(s): conventional style, subject prefixed `agent:`, referencing
     `#<NUMBER>`
   - push: `git push "https://swarm:$(cat /run/secrets/forgejo_token)@git.matou.nz/Matou/matou-app.git" HEAD:refs/heads/agent/issue-<NUMBER>`
   - open the PR:

         curl -sf -X POST -H "Authorization: token $(cat /run/secrets/forgejo_token)" \
           -H 'Content-Type: application/json' \
           -d '{"title":"<concise title> (#<NUMBER>)","head":"agent/issue-<NUMBER>","base":"main","body":"closes #<NUMBER>\n\n<what changed>\n\n**Feature e2e:** tests/e2e/features/issue-<NUMBER>.spec.ts (or the `skipped — <reason>` form)\n**Verified in sandbox:** <commands run>\n**Needs live verification:** <or None>"}' \
           "$FORGEJO_API/pulls"

   - notify: `bash .sandcastle/notify-mattermost.sh ":package: PR ready for review: <PR html_url> (fixes #<NUMBER>)"`

   A human reviews and merges; the merge closes the issue and the
   push-mirror carries it to GitLab.
