# Release observability — "did the build for tag `vX.Y.Z` run, and where?"

A `v0.6.0` release investigation (#335, 2026-09-03) burned ~2 hours on a
30-second question — *did the tag build run?* — because the answer had moved
and nobody had written down where. This is the runbook so it stays a
30-second question.

## The one fact that resolves most confusion

**Release installers are built on GitHub Actions, not on Forgejo.** Since the
release-builds migration (`docs/plans/2026-08-31-github-release-builds-spec.md`,
WP2), a `v*` tag builds every installer on GitHub-hosted runners.
`git.matou.nz` (Forgejo) stays the source of truth and the PR/CI host; it does
**not** build releases.

| Workflow | Repo | Triggers | Builds |
| --- | --- | --- | --- |
| `.github/workflows/build.yml` (`Matou App Build`) | GitHub `matou-collective/matou-app` | `push` tag `v*`, `workflow_dispatch` | desktop (mac/linux/windows), Android AAB+APK, iOS IPA; publishes to Play open testing + TestFlight; attaches mobile installers to a **draft** GitHub release |
| `.forgejo/workflows/android.yml` | Forgejo `Matou/matou-app` | `pull_request`, `workflow_dispatch` — **not tags** | debug APK on PRs; a manual release-AAB *smoke* build on dispatch. Play upload does **not** live here. |

So on a `v*` tag, **Forgejo doing nothing is correct behaviour.** `scripts/release.sh`
pushes the tag to *both* remotes (`origin` = Forgejo, `github`); only the
GitHub push matters for the release build (`scripts/release.sh:56-59`).

## Checklist: what happened to the release for `vX.Y.Z`

Look on **GitHub**, in this order — none of this needs the Forgejo actions API:

1. **The build run** — GitHub → Actions → `Matou App Build`, filter to the tag.
   Each job's step summary carries the evidence (versionCode/Name, signatures,
   iOS smoke `/health`, attached-asset table). Or:
   `gh run list --repo matou-collective/matou-app --workflow build.yml`.
2. **The draft release + its assets** — the `release` job attaches the mobile
   installers to a draft release (tags only, gated on the Android job
   succeeding). `gh release view vX.Y.Z --repo matou-collective/matou-app`.
   The release stays a **draft** for a human to publish after checking Play /
   TestFlight — a draft with assets means the build ran and succeeded.
3. **Play (Android)** — the `Publish AAB to Play open testing` step runs on
   tags only (`build.yml`, `if: github.ref_type == 'tag'`). Promotion to
   production stays manual. See `docs/mobile/PLAY_STORE.md`.
4. **TestFlight (iOS)** — the `Upload to TestFlight` step runs on a tag (or a
   dispatch with `testflight=true`). A flaky iOS job does **not** withhold the
   other assets; it is called out in the release job's summary instead.

If step 1 shows no run for the tag at all, check that the tag actually reached
GitHub (`git ls-remote github refs/tags/vX.Y.Z`) — `scripts/release.sh` pushes
it, but a hand-made tag pushed only to `origin` never triggers a GitHub build.

## Why the Forgejo actions API is *not* on that checklist

During #335 the Forgejo actions endpoints were found to be degraded under swarm
load, so do not lean on them to answer release questions:

- `GET /repos/{o}/{r}/actions/runs` and `/actions/tasks` (full-scan listings)
  time out / 504 under swarm load (task table ~49k rows, a runner pickup every
  ~30s across 5+ repos).
- Filtered queries respond (`?status=waiting`, per-run
  `GET /actions/runs/{id}` in ~1s), but the run objects come back with null
  `path` / `display_title` / `head_sha` / `started_at`, so a run cannot be
  attributed to a workflow via the API, and `?head_sha=` filtering misses runs.
- `/actions/runs/{id}/jobs` and `/actions/artifacts` → 404 in this Forgejo
  version. Android runs set no commit status, so `commits/{sha}/status` is
  blind to them.

The remediation for that degradation (prune/index the actions DB, throttle the
swarm's workflow churn, and give the release path an automated queryable
signal) is tracked on #335 and its follow-ups — it touches the live shared
`git.matou.nz` host, not this repo's code.

## When adding a new release target

Keep this table and checklist honest: a new platform job in `build.yml` should
leave a signal a human can query without the Forgejo actions API — a step
summary, a draft-release asset, or a store upload — not a run that is only
visible in the Actions UI.
