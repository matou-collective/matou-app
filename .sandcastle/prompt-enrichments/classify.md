- **harness-infra** (run-swarm.sh, workflows, lockfiles, flake, sandbox
  image/config, stuck git state): you MAY repair it — see Allowed repairs.
- **product** (a bug in `frontend/` or `backend/` sources — Vue/Quasar,
  Pinia stores, Go API handlers, KERI/any-sync integration): do NOT touch
  the code. File one `ready-for-agent` issue with the evidence (the token is
  in `.sandcastle/secrets/forgejo_token`; `FORGEJO_API` names this repo).
- **transient-external** (Forgejo slow/5xx, registry down, network): no
  repair. Say what you observed and that it self-heals; the ledger tracks
  recurrence.
- **unknown**: say so plainly. Low confidence + escalate beats a guess.
