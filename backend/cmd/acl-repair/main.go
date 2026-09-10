// acl-repair: owner-side repair for a member missing from a space ACL.
//
// The community-readonly join is a best-effort step inside
// POST /api/v1/spaces/community/join: if the invite handed to the member had no
// readonly key, the member ends up in the community space only, and every later
// grant-steward-admin call 404s with "no account found … in space <readonly>".
//
// Rather than asking the member to re-join (the join endpoint refuses duplicate
// community joins), the space OWNER adds the member's any-sync identity to the
// readonly ACL directly with an AccountsAdd record. The identity is looked up in
// the community ACL by the KERI AID recorded in the join metadata, and the same
// `{"aid":…,"joinedAt":…}` metadata is written so FindAccountPubKeyByAID and
// AccountAIDMap resolve the account afterwards. The record carries the space
// read key encrypted to the member, so their client can decrypt trees as soon
// as it opens the space.
//
// Owner identity vs. transport peer key (post-#479): the ACL owner identity is
// the mnemonic-derived SIGN key, which is distinct from the per-install device
// (transport) peer.key. Since #479 the {dataDir}/peer.key file is a random
// per-install key used only for the transport peer id — it is NOT an ACL owner.
// The owner identity must therefore be supplied explicitly: the mnemonic (via
// -mnemonic-stdin, the MATOU_OWNER_MNEMONIC env var, or -mnemonic on argv — the
// same derivation NewPeerKeyManager uses) or -sign-key (a users/{aid}/sign.key
// file, plaintext or MATOU_IDENTITY_KEY-sealed). -peer-key is kept for the
// transport peer key only. Without an owner-identity source the tool exits with
// an actionable error rather than signing with a non-owner key.
//
// Nothing is opened locally: ACL records are fetched from and submitted to the
// consensus node through the SDK node client, using a throwaway data dir and
// the owner's transport peer key. The peer key is staged as a plaintext copy in
// the throwaway dir (unsealing it under MATOU_IDENTITY_KEY when the install is
// sealed at rest, #117/#411) so the SDK never opens the real install's file —
// an unopenable device key would otherwise be moved aside and replaced, rotating
// the install's peer id. Run it with the owner's app CLOSED — a second client
// with the same peer id would fight the running one for node connections.
//
//	go run ./cmd/acl-repair \
//	  -config ~/.config/Matou/matou-data/client-production.yml \
//	  -peer-key ~/.config/Matou/matou-data/peer.key \
//	  -mnemonic-stdin \
//	  -from-space <communitySpaceId> -space <readOnlySpaceId> \
//	  -aid <memberAID> -permissions admin [-dry-run]
//
// or, using a stored sign key file instead of the mnemonic:
//
//	go run ./cmd/acl-repair \
//	  -config ~/.config/Matou/matou-data/client-production.yml \
//	  -peer-key ~/.config/Matou/matou-data/peer.key \
//	  -sign-key ~/.config/Matou/matou-data/users/<ownerAID>/sign.key \
//	  -from-space <communitySpaceId> -space <readOnlySpaceId> \
//	  -aid <memberAID> -permissions admin
package main

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"log"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/anyproto/any-sync/commonspace/object/accountdata"
	"github.com/anyproto/any-sync/commonspace/object/acl/list"
	"github.com/anyproto/any-sync/commonspace/object/acl/recordverifier"
	"github.com/anyproto/any-sync/node/nodeclient"
	"github.com/anyproto/any-sync/util/crypto"

	"github.com/matou-dao/backend/internal/anysync"
	"github.com/matou-dao/backend/internal/identity"
)

// Environment variables read by the tool.
const (
	// envOwnerMnemonic supplies the owner mnemonic without putting it on argv
	// (argv is world-readable via ps and lands in shell history).
	envOwnerMnemonic = "MATOU_OWNER_MNEMONIC"
	// envIdentityKey is the at-rest key the app was launched with (#117/#411);
	// needed to open a sealed sign.key / peer.key.
	envIdentityKey = "MATOU_IDENTITY_KEY"
)

func main() {
	cfg := flag.String("config", "", "any-sync client config yml (e.g. {dataDir}/client-production.yml)")
	peerKey := flag.String("peer-key", "", "owner transport peer.key path (e.g. {dataDir}/peer.key) — device peer id only, NOT the ACL owner identity; plaintext or MATOU_IDENTITY_KEY-sealed")
	mnemonic := flag.String("mnemonic", "", "owner BIP39 mnemonic on argv (visible in ps/shell history — prefer -mnemonic-stdin or "+envOwnerMnemonic+"); the ACL owner identity, derived the same way as the app")
	mnemonicStdin := flag.Bool("mnemonic-stdin", false, "read the owner BIP39 mnemonic from the first line of stdin")
	signKeyPath := flag.String("sign-key", "", "path to the owner sign key file (e.g. {dataDir}/users/{ownerAID}/sign.key, or peer.key on a pre-#479 install), plaintext or MATOU_IDENTITY_KEY-sealed; alternative to the mnemonic")
	keyIndex := flag.Uint("key-index", 0, "mnemonic derivation index (default 0)")
	fromSpace := flag.String("from-space", "", "space whose ACL already holds the member (community space id)")
	space := flag.String("space", "", "space to add the member to (community-readonly space id)")
	aid := flag.String("aid", "", "member KERI AID (as recorded in join metadata)")
	perms := flag.String("permissions", "admin", "permissions to grant: reader|writer|admin")
	dryRun := flag.Bool("dry-run", false, "resolve and report only, do not submit the record")
	flag.Parse()

	for name, v := range map[string]string{"config": *cfg, "peer-key": *peerKey, "from-space": *fromSpace, "space": *space, "aid": *aid} {
		if v == "" {
			log.Fatalf("-%s is required", name)
		}
	}
	var permissions list.AclPermissions
	switch *perms {
	case "reader":
		permissions = list.AclPermissionsReader
	case "writer":
		permissions = list.AclPermissionsWriter
	case "admin":
		permissions = list.AclPermissionsAdmin
	default:
		log.Fatalf("unknown -permissions %q", *perms)
	}

	// Resolve the ACL owner identity (sign key) from an explicit source. After
	// #479 the transport peer.key is a random per-install key and is never an
	// ACL owner, so an owner-identity source is mandatory.
	ownerMnemonic, mnemonicSrc, err := readMnemonic(*mnemonic, *mnemonicStdin, os.Getenv(envOwnerMnemonic), os.Stdin)
	if err != nil {
		log.Fatalf("%v", err)
	}
	ownerSign, ownerDesc, err := resolveOwnerSignKey(ownerMnemonic, mnemonicSrc, *signKeyPath, uint32(*keyIndex))
	if err != nil {
		log.Fatalf("%v", err)
	}

	tmp, err := os.MkdirTemp("", "acl-repair-")
	if err != nil {
		log.Fatal(err)
	}
	defer func() { _ = os.RemoveAll(tmp) }()

	// Stage a plaintext copy of the transport peer key in the throwaway dir
	// before the SDK sees it (see stagePeerKey): a sealed peer.key that the
	// SDK cannot open would be moved aside and replaced, rotating the owner's
	// real install's device key from a mis-run ops tool.
	stagedPeerKey, err := stagePeerKey(*peerKey, tmp)
	if err != nil {
		log.Fatalf("-peer-key: %v", err)
	}

	client, err := anysync.NewSDKClient(*cfg, &anysync.ClientOptions{DataDir: tmp, PeerKeyPath: stagedPeerKey})
	if err != nil {
		log.Fatalf("sdk client: %v", err)
	}
	defer func() { _ = client.Close() }()
	fmt.Printf("transport peer id: %s\n", client.GetPeerID())
	fmt.Printf("owner identity: %s (from %s)\n", ownerSign.GetPublic().Account(), ownerDesc)

	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	defer cancel()

	nc := client.GetNodeClient()
	// The ACL identity used to read ACLs and sign the AccountsAdd record is the
	// owner sign key, NOT the transport peer key.
	keys := accountdata.New(ownerSign, ownerSign)

	// 1. Resolve the member's identity from the source space ACL.
	srcACL, err := fetchACL(ctx, nc, keys, *fromSpace)
	if err != nil {
		log.Fatalf("source ACL: %v", err)
	}
	member, srcPerms, err := findByAID(srcACL.AclState(), *aid)
	if err != nil {
		log.Fatalf("source ACL: %v", err)
	}
	fmt.Printf("member %s → identity %s, permissions in %s: %s\n", *aid, member.Account(), short(*fromSpace), permName(srcPerms))

	// 2. Check the target ACL.
	dstACL, err := fetchACL(ctx, nc, keys, *space)
	if err != nil {
		log.Fatalf("target ACL: %v", err)
	}
	st := dstACL.AclState()
	ownerPerms := st.Permissions(keys.SignKey.GetPublic())
	fmt.Printf("target %s: head %s, %d accounts, owner permissions: %s\n",
		short(*space), dstACL.Head().Id, len(st.CurrentAccounts()), permName(ownerPerms))
	if err := ensureCanManageAccounts(ownerPerms, ownerDesc, keys.SignKey.GetPublic().Account(), *space); err != nil {
		log.Fatalf("%v", err)
	}
	if cur := st.Permissions(member); !cur.NoPermissions() {
		log.Fatalf("member already in target ACL with permissions %s — nothing to do (use grant-steward-admin to change level)", permName(cur))
	}
	if _, _, err := findByAID(st, *aid); err == nil {
		log.Fatalf("target ACL already has an account claiming AID %s under a different identity", *aid)
	}

	metadata, _ := json.Marshal(map[string]string{"aid": *aid, "joinedAt": time.Now().UTC().Format(time.RFC3339)})
	if *dryRun {
		fmt.Printf("dry-run: would add %s to %s as %s with metadata %s\n", member.Account(), short(*space), *perms, metadata)
		return
	}

	// 3. Build and submit the AccountsAdd record as the owner.
	rec, err := dstACL.RecordBuilder().BuildAccountsAdd(list.AccountsAddPayload{Additions: []list.AccountAdd{{
		Identity:    member,
		Permissions: permissions,
		Metadata:    metadata,
	}}})
	if err != nil {
		log.Fatalf("build accounts-add: %v", err)
	}
	withID, err := nc.AclAddRecord(ctx, *space, rec)
	if err != nil {
		log.Fatalf("submit accounts-add: %v", err)
	}
	fmt.Printf("accounts-add accepted: new ACL head %s\n", withID.Id)

	// 4. Re-read and confirm.
	dstACL, err = fetchACL(ctx, nc, keys, *space)
	if err != nil {
		log.Fatalf("re-read target ACL: %v", err)
	}
	got, gotPerms, err := findByAID(dstACL.AclState(), *aid)
	if err != nil {
		log.Fatalf("verify: %v", err)
	}
	fmt.Printf("verified: %s is in %s as %s (identity %s)\n", *aid, short(*space), permName(gotPerms), got.Account())
}

// readMnemonic gathers the owner mnemonic from exactly one of: the -mnemonic
// flag (argv), -mnemonic-stdin (first line of stdin), or the
// MATOU_OWNER_MNEMONIC environment variable. It returns the mnemonic and a
// description of the source for messages; the mnemonic itself is never
// included in any error or output. An empty result with a nil error means no
// mnemonic source was given (the caller may still have -sign-key).
func readMnemonic(flagVal string, fromStdin bool, envVal string, stdin io.Reader) (mnemonic, source string, err error) {
	given := 0
	if flagVal != "" {
		given++
	}
	if fromStdin {
		given++
	}
	if envVal != "" {
		given++
	}
	if given > 1 {
		return "", "", errors.New("provide only one mnemonic source: -mnemonic, -mnemonic-stdin or " + envOwnerMnemonic)
	}
	switch {
	case fromStdin:
		line, rerr := bufio.NewReader(stdin).ReadString('\n')
		if rerr != nil && !errors.Is(rerr, io.EOF) {
			return "", "", fmt.Errorf("reading mnemonic from stdin: %w", rerr)
		}
		line = strings.TrimSpace(line)
		if line == "" {
			return "", "", errors.New("-mnemonic-stdin: no mnemonic on the first line of stdin")
		}
		return line, "-mnemonic-stdin", nil
	case envVal != "":
		return strings.TrimSpace(envVal), envOwnerMnemonic, nil
	case flagVal != "":
		return strings.TrimSpace(flagVal), "-mnemonic", nil
	}
	return "", "", nil
}

// resolveOwnerSignKey resolves the ACL owner identity (sign key) from exactly
// one explicit source: a BIP39 mnemonic (derived the same way NewPeerKeyManager
// derives the app's sign key) or a stored sign key file. mnemonicSrc names
// where the mnemonic came from (see readMnemonic). It returns the key and a
// human-readable description of where it came from (used in error messages);
// the description never contains the mnemonic.
//
// It is intentionally strict: after #479 the transport peer.key is a random
// per-install key that is never an ACL owner, so falling back to it would only
// produce a confusing "not an owner" failure at submit time.
func resolveOwnerSignKey(mnemonic, mnemonicSrc, signKeyPath string, keyIndex uint32) (crypto.PrivKey, string, error) {
	switch {
	case mnemonic != "" && signKeyPath != "":
		return nil, "", errors.New("provide only one owner-identity source: a mnemonic OR -sign-key, not both")
	case mnemonic != "":
		if mnemonicSrc == "" {
			mnemonicSrc = "-mnemonic"
		}
		if err := anysync.ValidateMnemonic(mnemonic); err != nil {
			return nil, "", fmt.Errorf("invalid mnemonic from %s: %w", mnemonicSrc, err)
		}
		key, err := anysync.DeriveKeyFromMnemonic(mnemonic, keyIndex)
		if err != nil {
			return nil, "", fmt.Errorf("deriving owner sign key from %s: %w", mnemonicSrc, err)
		}
		return key, fmt.Sprintf("%s (index %d)", mnemonicSrc, keyIndex), nil
	case signKeyPath != "":
		key, err := loadSignKeyFile(signKeyPath)
		if err != nil {
			return nil, "", fmt.Errorf("loading -sign-key %s: %w", signKeyPath, err)
		}
		return key, fmt.Sprintf("-sign-key %s", signKeyPath), nil
	default:
		return nil, "", errors.New("an owner-identity source is required: pass -mnemonic-stdin (or " + envOwnerMnemonic + ", or -mnemonic '<12 words>') or -sign-key <path to users/{ownerAID}/sign.key>. " +
			"After #479 the device peer.key is a random per-install key (transport peer id only) and is NOT the ACL owner, so it cannot sign the repair")
	}
}

// loadSignKeyFile reads a stored owner sign key: the marshalled Ed25519 private
// key written by anysync.PersistUserSignKey (or, on a pre-#479 install, the
// mnemonic-derived peer.key), optionally sealed at rest under
// MATOU_IDENTITY_KEY (#117/#411).
func loadSignKeyFile(path string) (crypto.PrivKey, error) {
	data, err := readKeyFile(path)
	if err != nil {
		return nil, err
	}
	return crypto.UnmarshalEd25519PrivateKeyProto(data)
}

// stagePeerKey reads the owner's transport peer.key (plaintext or
// MATOU_IDENTITY_KEY-sealed, #117/#411), checks it parses as an Ed25519 key, and
// writes a plaintext copy to {tmpDir}/peer.key for the SDK to load. The SDK is
// never pointed at the real install's file: with no encryption key registered
// it treats an unopenable device key as unreadable and replaces it, which
// would rotate the owner's real install's device key from a mis-run ops tool.
func stagePeerKey(path, tmpDir string) (string, error) {
	data, err := readKeyFile(path)
	if err != nil {
		return "", err
	}
	if _, err := crypto.UnmarshalEd25519PrivateKeyProto(data); err != nil {
		return "", fmt.Errorf("%s is not an Ed25519 peer key: %w", path, err)
	}
	staged := filepath.Join(tmpDir, "peer.key")
	if err := os.WriteFile(staged, data, 0600); err != nil {
		return "", fmt.Errorf("staging peer key copy: %w", err)
	}
	return staged, nil
}

// readKeyFile reads a key file that may be sealed at rest under
// MATOU_IDENTITY_KEY (the MATOU-IDENC1 AES-256-GCM scheme of internal/identity,
// #117/#411) and returns the plaintext bytes. A sealed file with
// MATOU_IDENTITY_KEY unset yields an actionable error rather than a cryptic
// unmarshal failure; legacy plaintext files are returned unchanged.
func readKeyFile(path string) ([]byte, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	if !identity.IsSealed(data) {
		return data, nil
	}
	keyMaterial := os.Getenv(envIdentityKey)
	if keyMaterial == "" {
		return nil, fmt.Errorf("%s is sealed at rest (#117) but %s is not set — export the same key material the app was launched with", path, envIdentityKey)
	}
	plain, err := identity.Open(data, []byte(keyMaterial))
	if err != nil {
		return nil, fmt.Errorf("decrypting sealed key file %s (wrong %s or corrupt file): %w", path, envIdentityKey, err)
	}
	return plain, nil
}

// ensureCanManageAccounts fails loudly, naming which key was tried, when the
// resolved owner identity lacks account-management rights in the target ACL —
// so a non-owner key is caught here instead of as an opaque submit rejection.
func ensureCanManageAccounts(perms list.AclPermissions, ownerDesc, account, space string) error {
	if perms.CanManageAccounts() {
		return nil
	}
	return fmt.Errorf("signing identity %s (from %s) has permissions %q in target ACL %s — an AccountsAdd needs admin/owner and would be rejected. "+
		"After #479 the device peer.key is not the ACL owner; supply the mnemonic-derived identity via -mnemonic-stdin / "+envOwnerMnemonic+" or -sign-key {dataDir}/users/{ownerAID}/sign.key",
		account, ownerDesc, permName(perms), short(space))
}

func fetchACL(ctx context.Context, nc nodeclient.NodeClient, keys *accountdata.AccountKeys, spaceID string) (list.AclList, error) {
	recs, err := nc.AclGetRecords(ctx, spaceID, "")
	if err != nil {
		return nil, fmt.Errorf("get records for %s: %w", spaceID, err)
	}
	if len(recs) == 0 {
		return nil, fmt.Errorf("no ACL records for %s", spaceID)
	}
	storage, err := list.NewInMemoryStorage(recs[0].Id, recs)
	if err != nil {
		return nil, err
	}
	return list.BuildAclListWithIdentity(keys, storage, recordverifier.New())
}

// findByAID mirrors MatouACLManager.FindAccountPubKeyByAID on an in-memory ACL.
func findByAID(st *list.AclState, aid string) (crypto.PubKey, list.AclPermissions, error) {
	var mdKeys []crypto.PrivKey
	for _, k := range st.Keys() {
		if k.MetadataPrivKey != nil {
			mdKeys = append(mdKeys, k.MetadataPrivKey)
		}
	}
	needle := []byte(`"aid":"` + aid + `"`)
	for _, acc := range st.CurrentAccounts() {
		if len(acc.RequestMetadata) == 0 || acc.Permissions.NoPermissions() {
			continue
		}
		raw := acc.RequestMetadata
		for _, k := range mdKeys {
			if dec, err := k.Decrypt(raw); err == nil {
				raw = dec
				break
			}
		}
		if bytes.Contains(raw, needle) {
			return acc.PubKey, acc.Permissions, nil
		}
	}
	return nil, 0, fmt.Errorf("no account found for AID %s", aid)
}

func short(id string) string {
	if len(id) > 16 {
		return id[:16] + "…"
	}
	return id
}

func permName(p list.AclPermissions) string {
	switch {
	case p.IsOwner():
		return "owner"
	case p.CanManageAccounts():
		return "admin"
	case p.CanWrite():
		return "writer"
	case p.NoPermissions():
		return "none"
	default:
		return "reader"
	}
}
