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
