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
an ACL owner. You must therefore point the tool at the owner identity explicitly,
with exactly one of:

- the owner mnemonic, supplied via **`-mnemonic-stdin`** (first line of stdin),
  the **`MATOU_OWNER_MNEMONIC`** environment variable, or `-mnemonic '<12 words>'`
  on argv. The sign key is derived exactly as the app does (`NewPeerKeyManager`).
  Prefer stdin or the env var: argv is world-readable via `ps` and lands in
  shell history. The mnemonic is never echoed in output or error messages.
- **`-sign-key <path>`** — a stored sign key file, e.g.
  `{dataDir}/users/{ownerAID}/sign.key`. Plaintext, or sealed under
  `MATOU_IDENTITY_KEY` (#117/#411) — export the same `MATOU_IDENTITY_KEY` the
  app was launched with and the tool unseals it in memory.

`-peer-key` is still required, but only supplies the transport peer key used to
connect to the consensus node. The tool stages a plaintext copy of it in its
throwaway data dir (unsealing under `MATOU_IDENTITY_KEY` when the install is
sealed at rest) and points the SDK at the copy, so the real install's
`peer.key` is never opened — or rotated — by the SDK. Run the tool with the
owner's app **closed** — a second client with the same transport peer id would
fight the running one for node connections.

If no owner-identity source is given, the tool exits with an actionable error
rather than signing with a non-owner key. If the resolved identity is not an
admin/owner in the **target** space's ACL, it fails loudly (naming the key it
tried) instead of letting the `AccountsAdd` be rejected at submit time.

### Which flags for which install vintage

| Install vintage | `-peer-key` | Owner identity |
|-----------------|-------------|----------------|
| Post-#479 (device key split; any install booted on a build with #479) | `{dataDir}/peer.key` (random device key) | `-mnemonic-stdin` / `MATOU_OWNER_MNEMONIC`, or `-sign-key {dataDir}/users/{ownerAID}/sign.key` |
| Pre-#479 (never booted a #479 build): `{dataDir}/peer.key` **is** the mnemonic-derived owner key | `{dataDir}/peer.key` | the mnemonic as above, or `-sign-key {dataDir}/peer.key` (same file — it holds the owner key). The per-user copy is named `{dataDir}/users/{ownerAID}/peer.key` on this vintage and works too. |
| Sealed at rest (Electron/mobile builds with #411, `MATOU_IDENTITY_KEY` set at launch) | as above; export `MATOU_IDENTITY_KEY` | as above; `-sign-key` needs `MATOU_IDENTITY_KEY`, the mnemonic does not |

Not sure which vintage? Use the mnemonic — it derives the owner key regardless of
what is on disk. The first boot on a #479 build silently migrates a legacy
`peer.key` to a random device key (the owner key then lives only in
`users/{ownerAID}/sign.key`), so a `-sign-key {dataDir}/peer.key` that used to
work will start failing the owner check after an app upgrade.

## Usage

```bash
# With the owner mnemonic on stdin (keeps it out of ps and shell history):
go run ./cmd/acl-repair \
  -config ~/.config/Matou/matou-data/client-production.yml \
  -peer-key ~/.config/Matou/matou-data/peer.key \
  -mnemonic-stdin \
  -from-space <communitySpaceId> \
  -space <readOnlySpaceId> \
  -aid <memberAID> \
  -permissions admin \
  [-dry-run]

# Or with a stored sign key file (export MATOU_IDENTITY_KEY first if the
# install is sealed at rest):
go run ./cmd/acl-repair \
  -config ~/.config/Matou/matou-data/client-production.yml \
  -peer-key ~/.config/Matou/matou-data/peer.key \
  -sign-key ~/.config/Matou/matou-data/users/<ownerAID>/sign.key \
  -from-space <communitySpaceId> \
  -space <readOnlySpaceId> \
  -aid <memberAID> \
  -permissions admin
```

The mnemonic can also come from the environment (`MATOU_OWNER_MNEMONIC='<12
words>' go run ./cmd/acl-repair ...`) — again, without `-mnemonic` on argv.

### Flags

| Flag | Required | Description |
|------|----------|-------------|
| `-config` | yes | any-sync client config yml (e.g. `{dataDir}/client-production.yml`) |
| `-peer-key` | yes | owner transport `peer.key` path (device peer id only, **not** the ACL owner); plaintext or `MATOU_IDENTITY_KEY`-sealed |
| `-mnemonic-stdin` | one of | read the owner BIP39 mnemonic (the ACL owner identity) from the first line of stdin |
| `-mnemonic` | one of | owner BIP39 mnemonic on argv — visible in `ps` / shell history, prefer `-mnemonic-stdin` or `MATOU_OWNER_MNEMONIC` |
| `-sign-key` | one of | path to the owner sign key file (plaintext or `MATOU_IDENTITY_KEY`-sealed) |
| `-key-index` | no | mnemonic derivation index (default `0`) |
| `-from-space` | yes | space whose ACL already holds the member (community space id) |
| `-space` | yes | space to add the member to (community-readonly space id) |
| `-aid` | yes | member KERI AID (as recorded in join metadata) |
| `-permissions` | no | `reader` \| `writer` \| `admin` (default `admin`) |
| `-dry-run` | no | resolve and report only, do not submit the record |

Provide exactly one owner-identity source: `-mnemonic-stdin`, `MATOU_OWNER_MNEMONIC`,
`-mnemonic`, or `-sign-key`.

### Environment

| Variable | Description |
|----------|-------------|
| `MATOU_OWNER_MNEMONIC` | owner BIP39 mnemonic (alternative to `-mnemonic-stdin` / `-mnemonic`) |
| `MATOU_IDENTITY_KEY` | the at-rest key the app was launched with (#117/#411); required to open a sealed `sign.key` / `peer.key`, ignored for plaintext files |
