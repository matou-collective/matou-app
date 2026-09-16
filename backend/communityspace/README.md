# communityspace

The single, importable home of the convention for creating a Matou community's
three any-sync spaces:

- keys derived from the founder's mnemonic at space indexes **1** (community),
  **2** (read-only) and **3** (admin);
- the header seeds and the ACL owner (the mnemonic index-0 account key);
- the three-space orchestration.

It exists so that **the app and the platform that hosts it run the same code**.
Before it, community-space creation was reachable only through this backend's
own org-setup wiring, in a module path (`github.com/matou-dao/backend`) that
resolves nowhere and under `internal/`, where no other module may import it.
IDSS founding must create a community's spaces identically, so the convention
was extracted here (issue #530).

## What it depends on

Only the any-sync client libraries (`github.com/anyproto/any-sync/util/crypto`
and its transitive crypto deps). Importing it does **not** pull this backend's
server dependencies — no HTTP router, no store, no KERI. A consumer supplies its
own network-connected client through the `SpaceCreator` port.

## Entry point

```go
spaces, err := communityspace.CreateCommunitySpaces(ctx, creator, mnemonic, ownerAID)
// spaces.CommunitySpaceID / .CommunityReadOnlySpaceID / .AdminSpaceID
```

`creator` is any `SpaceCreator` — a client built from the coordinator address.
This backend passes its `*anysync.SDKClient`; IDSS founding passes the
platform's client. `CreateCommunitySpaces` opens no HTTP listener, reads no
process-wide config and writes no local store.

## Release / mirror push — who and when

This module is a **nested public module** of the `matou-app` repo. External
consumers (IDSS) fetch it from the public GitHub mirror
`github.com/matou-collective/matou-app`, which requires **no credentials**.

Nested Go modules are versioned with a **path-prefixed tag**:

```
backend/communityspace/vX.Y.Z
```

An external `go get` then resolves
`github.com/matou-collective/matou-app/backend/communityspace@vX.Y.Z`.

**The release step (a repo maintainer, at the point an IDSS release needs a new
version):**

1. Merge the change to `main` on the Forgejo origin (`git.matou.nz/Matou/matou-app`).
2. Tag it: `git tag backend/communityspace/vX.Y.Z && git push origin backend/communityspace/vX.Y.Z`.
3. The Forgejo **push-mirror → GitHub** carries the tag to
   `github.com/matou-collective/matou-app` (Repo Settings → push-mirror must have
   *sync tags* enabled). **The mirror can lag** — it was observed a week behind
   origin when this module was written — so before cutting an IDSS release that
   pins a new version, the maintainer must confirm the tag is present on the
   GitHub mirror (or trigger a manual mirror sync) rather than assume it
   propagated.

Within this repo the backend resolves the module through a `replace` directive
(see `backend/go.mod`), so day-to-day development needs no tag or mirror.
