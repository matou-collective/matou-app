{{ENRICH:rehearsal-drive-intro}}

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
