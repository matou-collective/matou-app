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
// Nothing is opened locally: ACL records are fetched from and submitted to the
// consensus node through the SDK node client, using a throwaway data dir and
// the owner's peer key. Run it with the owner's app CLOSED — a second client
// with the same peer id would fight the running one for node connections.
//
//	go run ./cmd/acl-repair \
//	  -config ~/.config/Matou/matou-data/client-production.yml \
//	  -peer-key ~/.config/Matou/matou-data/peer.key \
//	  -from-space <communitySpaceId> -space <readOnlySpaceId> \
//	  -aid <memberAID> -permissions admin [-dry-run]
package main

import (
	"bytes"
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"log"
	"os"
	"time"

	"github.com/anyproto/any-sync/commonspace/object/accountdata"
	"github.com/anyproto/any-sync/commonspace/object/acl/list"
	"github.com/anyproto/any-sync/commonspace/object/acl/recordverifier"
	"github.com/anyproto/any-sync/node/nodeclient"
	"github.com/anyproto/any-sync/util/crypto"

	"github.com/matou-dao/backend/internal/anysync"
)

func main() {
	cfg := flag.String("config", "", "any-sync client config yml (e.g. {dataDir}/client-production.yml)")
	peerKey := flag.String("peer-key", "", "owner peer.key path (e.g. {dataDir}/peer.key)")
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

	tmp, err := os.MkdirTemp("", "acl-repair-")
	if err != nil {
		log.Fatal(err)
	}
	defer func() { _ = os.RemoveAll(tmp) }()

	client, err := anysync.NewSDKClient(*cfg, &anysync.ClientOptions{DataDir: tmp, PeerKeyPath: *peerKey})
	if err != nil {
		log.Fatalf("sdk client: %v", err)
	}
	defer func() { _ = client.Close() }()
	fmt.Printf("owner identity (peer id): %s\n", client.GetPeerID())

	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	defer cancel()

	nc := client.GetNodeClient()
	owner := client.GetSigningKey()
	keys := accountdata.New(owner, owner)

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
	fmt.Printf("target %s: head %s, %d accounts, owner permissions: %s\n",
		short(*space), dstACL.Head().Id, len(st.CurrentAccounts()), permName(st.Permissions(keys.SignKey.GetPublic())))
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
