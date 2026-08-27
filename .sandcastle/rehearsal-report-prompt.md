You are diagnosing a RED run of this repo's smoke-tier rehearsal drive
(`scripts/smoke-drive/run-smoke-drive.sh`, ruled in matou-app#41; the driver
and its six-clause contract are documented in
`scripts/smoke-drive/README.md`). The drive chains real Playwright e2e specs
as **legs** over one honest journey: an adaptive base — `a` (org-setup alone)
or `b` (org-setup → registration → invitation, the identity protocol's
founding growth loop) — plus an optional feature-showcase leg reusing
`frontend/tests/e2e/features/issue-<N>.spec.ts`. Its run directory is
`test-results/smoke/<stamp>/`. Beside the harness's own records the run
directory carries this drive's own evidence: `artifacts/legs.d/` (per-leg
record fragments), `logs/NN-<leg>.txt` (per-leg Playwright output) and
`screenshots/<leg>/*.png` (per-leg curated snaps plus Playwright's own
captures — the review currency that shows the feature that was driven). There
is **no live box to ask**: the drive stands up an ephemeral LOCAL test stack on
the runner host (`scripts/clean-test.sh` + the `matou-infrastructure` KERI and
any-sync networks + a `MATOU_ENV=test` backend on :9080) and tears it down, so
a live-box section is never appended here — diagnose from the harvested logs
and screenshots, the ordinary case. The drive stands up no PAID box, and it
declares **no standing known-red frontier**: a red is a real regression unless
`legs.json`'s own skip reasons name that leg as out of scope.

Evidence in the run directory given below: `artifacts/legs.json` (per-leg
records) and `artifacts/verdict.json` (the drive's own verdict marker, when it
got that far) — the two records this harness itself reads — plus whatever else
that drive harvests beside them, named in the paragraph above. Read what
exists; say what's absent.

When a live-box section is appended below, the box that drive stood up is
STILL UP: prefer it as your primary source for what only a live machine can
answer (which unit failed, what's actually listening, the health probe's real
error), and treat the harvested logs above as corroboration/fallback. That
section carries its own access line and its read-only limits — obey them, and
run nothing that mutates the box. If it refuses you, or no such section is
present at all, say so plainly in the body and diagnose from the harvested
logs alone: a box hardened with no inbound shell is an ordinary case, not a
failure.

Produce ONE json object on stdout, nothing else:
{"title": "<issue title, ≤90 chars, starts with the failing leg>",
 "body": "<markdown: the failure, the evidence lines that show it (quote
          them), the suspected layer (product / harness / infra), and what
          plugging it needs>",
 "confident": <true only if the diagnosis names a specific defect a swarm
              agent could act on without a human ruling>}

Do not modify anything. Do not file anything yourself. If the red is a KNOWN
frontier — one this drive's own skip reasons in `legs.json` name as out of
scope, or one the paragraph above names as known-red — say so in the body and
set confident=true.
