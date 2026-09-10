# acl-repair

Owner-side repair for a member that is missing from a space ACL.

When a community-readonly join is only half-completed (the invite handed to the
member carried no readonly key), the member ends up in the community space but
not the readonly space, and every later `grant-steward-admin` call 404s with
`no account found … in space <readonly>`. Instead of asking the member to
re-join (the join endpoint refuses a duplicate community join), the space
**owner** runs this tool to add the member's any-sync identity to the readonly
ACL directly with an `AccountsAdd` record. The member's identity and its
`{"aid":…}` metadata are copied from the community ACL, so
`FindAccountPubKeyByAID` resolves the account afterwards, and the record carries
the space read key encrypted to the member.

## Owner identity vs. transport peer key

The ACL owner identity is the **mnemonic-derived sign key**, which since #479 is
distinct from the per-install device (transport) `peer.key`. `{dataDir}/peer.key`
is a random per-install key used only for the any-sync peer id — it is **not**
an ACL owner. You must therefore point the tool at the owner identity explicitly:

- `-mnemonic '<12 words>'` — derives the sign key exactly as the app does
  (`NewPeerKeyManager`), or
- `-sign-key <path>` — a stored sign key file, e.g.
  `{dataDir}/users/{ownerAID}/sign.key` (plaintext, or sealed under
  `MATOU_IDENTITY_KEY` once #411 lands).

`-peer-key` is still required, but only supplies the transport peer key used to
connect to the consensus node. Run the tool with the owner's app **closed** — a
second client with the same transport peer id would fight the running one for
node connections.

If no owner-identity source is given, the tool exits with an actionable error
rather than signing with a non-owner key. If the resolved identity is not an
admin/owner in the target ACL, it fails loudly (naming the key it tried) instead
of letting the `AccountsAdd` be rejected at submit time.

## Usage

```bash
# With the owner mnemonic:
go run ./cmd/acl-repair \
  -config ~/.config/Matou/matou-data/client-production.yml \
  -peer-key ~/.config/Matou/matou-data/peer.key \
  -mnemonic '<12 words>' \
  -from-space <communitySpaceId> \
  -space <readOnlySpaceId> \
  -aid <memberAID> \
  -permissions admin \
  [-dry-run]

# Or with a stored sign key file:
go run ./cmd/acl-repair \
  -config ~/.config/Matou/matou-data/client-production.yml \
  -peer-key ~/.config/Matou/matou-data/peer.key \
  -sign-key ~/.config/Matou/matou-data/users/<ownerAID>/sign.key \
  -from-space <communitySpaceId> \
  -space <readOnlySpaceId> \
  -aid <memberAID> \
  -permissions admin
```

### Flags

| Flag | Required | Description |
|------|----------|-------------|
| `-config` | yes | any-sync client config yml (e.g. `{dataDir}/client-production.yml`) |
| `-peer-key` | yes | owner transport `peer.key` path (device peer id only, **not** the ACL owner) |
| `-mnemonic` | one of | owner BIP39 mnemonic — the ACL owner identity |
| `-sign-key` | one of | path to the owner sign key file (plaintext or `MATOU_IDENTITY_KEY`-sealed) |
| `-key-index` | no | mnemonic derivation index (default `0`) |
| `-from-space` | yes | space whose ACL already holds the member (community space id) |
| `-space` | yes | space to add the member to (community-readonly space id) |
| `-aid` | yes | member KERI AID (as recorded in join metadata) |
| `-permissions` | no | `reader` \| `writer` \| `admin` (default `admin`) |
| `-dry-run` | no | resolve and report only, do not submit the record |

Provide exactly one of `-mnemonic` / `-sign-key`.
