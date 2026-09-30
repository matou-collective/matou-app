# KERIA 0.4.0 integration harness

Proves the steward-peer design (docs/superpowers/specs/2026-09-30-steward-peer-registry-design.md)
against the KERIA IDSS runs. Isolated compose project `stewardpeer`, host ports 5911-5913
(the witnesses are only reachable inside the compose network, on their stock 5642-5647); it never
touches the dev (39xx) or test (49xx) stacks.

    cd frontend/tests/infra
    npm install                            # own signify-ts 0.3.0 + tsx (first time)
    docker compose -f keria-0.4/docker-compose.yml up -d
    npx tsx steward-peer.infra.ts          # MODE=held (default) or MODE=fresh
    docker compose -f keria-0.4/docker-compose.yml down -v

Gotcha: KERIA 0.4.0 must be started with `--name keria` — `--name agent` makes every OOBI empty.

Runs need their own `signify-ts@0.3.0` + `tsx` (`npm install` in this directory; `package.json` here
is separate from `frontend/package.json`) because the frontend's libsodium 0.7.x has a broken ESM entry.
The script exits 1 if any check fails.

## Findings

Native `/multisig/iss` gate (KERIA 0.4.0, 1-of-2 group, index-1 member issues, exn sent to keys[0]):

- keys[0] DOES get a `/multisig/iss` notification.
- Multiplexor auto-parse alone does NOT yield `et=iss` on keys[0]: `credentials().state(regk, X)` is 404
  after the exn; the TEL iss event sits in the anchorless escrow and KERIA logs `MissingAnchorError`
  every few hundred ms (about 93 lines in ~8s for one credential). It is noise, not a wedge.
- An explicit replay (`POST /identifiers/{G}/credentials` with the member's sig + keys[0]'s own sig)
  converges to `et=iss` and the escrow noise stops (0 lines in the following 6s).
- KERIA does not self-recover a replay whose anchoring ixn is ahead of the target's KEL after a KEL push;
  the caller must re-POST (check e2).

App-module gate (Task 7: `replicate.ts` + `replay.ts` driven with the same deps as `KERIClient.sendOrgAct` /
`replayOrgAct`):

- member issues X → `/multisig/iss` → keys[0] `replayAct(parseActExn(getRequest(note.a.d)))` = `applied`, `et=iss`,
  no escrow noise afterwards; keys[0] revokes → `/multisig/rev` → member replays = `applied`, `et=rev`.
- KERIA raises NO second notification when the same sender re-sends an exn with an identical embed set (same `e.d`):
  the Multiplexor dedups on the embeds. A receiver must not mark a note read before its replay lands (a retry by
  re-send will be silent), and a history re-push of an identical `iss` act will not surface as a new note.
  Re-processing the original exn (`getRequest` again) is idempotent: `already`.
