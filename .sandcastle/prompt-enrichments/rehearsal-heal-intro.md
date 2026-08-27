This repo's smoke-tier drive (`scripts/smoke-drive/run-smoke-drive.sh`,
matou-app#41) chains real Playwright e2e specs as legs over one journey; its
run directory is `test-results/smoke/<stamp>/`. Beside the harness's own
records it harvests this drive's own evidence: `artifacts/legs.d/` (per-leg
record fragments), `logs/NN-<leg>.txt` (per-leg Playwright output) and
`screenshots/<leg>/*.png` (per-leg screenshots). Its "box" is an ephemeral
LOCAL test stack the drive stands up on the runner host (KERI + any-sync +
a `MATOU_ENV=test` backend on :9080) and tears down — there is no live box or
paid infra of its own, and standing that stack up is not something you may do
here. A **targeted check** in this repo's toolchain is an offline unit run you
can execute on this machine without the live stack: a scoped
`cd frontend && npm run test:script` (Vitest) or `npm run lint`, a
`cd backend && go test ./<package>`, or the drive's own offline seam tests
(`bash scripts/smoke-drive/smoke-drive-lib-test.sh`,
`bash scripts/smoke-drive/run-smoke-drive-test.sh`). The Playwright legs
themselves need the live stack and are NOT a check you can run here — so a
fault that only a full leg re-run could prove is one you file, not self-fix.
