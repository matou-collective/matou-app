package app

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	"gopkg.in/yaml.v3"

	"github.com/anyproto/any-sync/commonspace/object/tree/objecttree"

	"github.com/matou-dao/backend/internal/anystore"
	"github.com/matou-dao/backend/internal/anysync"
	"github.com/matou-dao/backend/internal/api"
	"github.com/matou-dao/backend/internal/auth"
	"github.com/matou-dao/backend/internal/config"
	"github.com/matou-dao/backend/internal/contributions"
	"github.com/matou-dao/backend/internal/email"
	"github.com/matou-dao/backend/internal/identity"
	"github.com/matou-dao/backend/internal/keri"
	"github.com/matou-dao/backend/internal/notifications"
	"github.com/matou-dao/backend/internal/pushrelayclient"
	bgSync "github.com/matou-dao/backend/internal/sync"
	matouTypes "github.com/matou-dao/backend/internal/types"
)

// App is a running backend instance: an HTTP server bound to a listener plus the
// ordered set of resources (any-sync SDK client, local store, sync worker) that
// must be released on shutdown. Start builds one from Options; Shutdown tears it
// down in reverse order. cmd/server drives it from a process; cmd/mobile drives
// it in-process on a device.
type App struct {
	listener net.Listener
	server   *http.Server

	// closers run in reverse of registration order on Shutdown, reproducing the
	// `defer X.Close()` unwinding main.go used to rely on.
	closers []func() error

	// serveErr carries the result of server.Serve so Wait can block on it.
	serveErr chan error
}

// Start builds the full backend from opts and begins serving HTTP on a freshly
// bound listener. It reproduces the wiring cmd/server/main.go performed inline,
// but returns errors instead of calling log.Fatalf so callers (cmd/server and
// cmd/mobile) decide how to surface failures. On any error every resource opened
// so far is released before returning, so a failed Start leaks nothing.
//
// Binding uses net.Listen, so opts.Port == 0 selects a free port; the chosen
// port is then available via App.Port. Startup progress is written to stdout
// only when opts.PrintBanner is set.
func Start(ctx context.Context, opts Options) (*App, error) {
	// Banner/progress output goes to stdout only when requested; cmd/mobile
	// leaves PrintBanner false so an embedded backend stays silent.
	out := io.Writer(io.Discard)
	if opts.PrintBanner {
		out = os.Stdout
	}

	// Production runs as a bundled app (Electron desktop, or an embedded mobile
	// host with no process environment). Bundled CORS accepts file://, capacitor://
	// and any localhost origin — the desktop launcher already exports
	// MATOU_CORS_MODE=bundled, but cmd/mobile boots in-process with no env, so
	// app.Start sets it here for prod. This is the one sanctioned os.Setenv: the
	// CORS middleware reads MATOU_CORS_MODE per request, so it must be set before
	// the server serves. Setting it to the same value the desktop already exports
	// leaves Electron behaviour unchanged.
	if opts.IsProd() {
		_ = os.Setenv("MATOU_CORS_MODE", "bundled")
	}

	// Resources opened during Start; released in reverse on any early return so
	// a failed Start leaks nothing. On success ownership transfers to the App.
	var closers []func() error
	success := false
	defer func() {
		if !success {
			for i := len(closers) - 1; i >= 0; i-- {
				_ = closers[i]()
			}
		}
	}()

	switch {
	case opts.IsTest():
		fmt.Fprintln(out, "MATOU DAO Backend Server (TEST)")
	case opts.IsProd():
		fmt.Fprintln(out, "MATOU DAO Backend Server (PRODUCTION)")
	default:
		fmt.Fprintln(out, "MATOU DAO Backend Server")
	}
	fmt.Fprintln(out, "============================")
	fmt.Fprintln(out)

	if opts.ConfigServerToken == "" {
		log.Println("[Config] WARNING: MATOU_CONFIG_SERVER_TOKEN is not set - " +
			"org config will not mirror to the config server, and email relay (if configured) will fail")
	}

	// Initialize data directory first (needed for org config)
	if err := os.MkdirAll(opts.DataDir, 0755); err != nil {
		return nil, fmt.Errorf("failed to create data directory: %w", err)
	}

	// Persist the per-launch API token (0600) for legitimate same-OS-user local
	// tooling (matou-mcp, scripts). TokenGuard requires it on mutations.
	if tokenPath, tokenErr := api.WriteTokenFile(opts.DataDir, opts.APIToken); tokenErr != nil {
		log.Printf("[Security] failed to write API token file: %v", tokenErr)
	} else {
		log.Printf("[Security] API token written to %s", tokenPath)
	}

	// Load server configuration (SMTP, KERI URLs, etc.)
	fmt.Fprintln(out, "Loading configuration...")
	cfg, err := config.Load("", "")
	if err != nil {
		return nil, fmt.Errorf("failed to load config: %w", err)
	}

	// Options.Port already encodes the per-environment default, the test shift to
	// 9080 and the MATOU_SERVER_PORT override, so it is authoritative here.
	cfg.Server.Port = opts.Port

	// Options.Host is authoritative for the bind address too: cmd/server resolves
	// it to "localhost" (unchanged desktop behaviour), while cmd/mobile pins it to
	// 127.0.0.1 for the on-device loopback listener.
	if opts.Host != "" {
		cfg.Server.Host = opts.Host
	}

	// Initialize org config handler - single source of truth for organization identity
	// The callback updates the in-memory config when org config is saved via API
	orgConfigHandler := api.NewOrgConfigHandler(opts.DataDir, func(orgData *api.OrgConfigData) {
		admins := make([]config.AdminInfo, len(orgData.Admins))
		for i, a := range orgData.Admins {
			admins[i] = config.AdminInfo{AID: a.AID, Name: a.Name, OOBI: a.OOBI}
		}
		cfg.SetOrgConfig(orgData.Organization.AID, orgData.Organization.Name, admins, orgData.CommunitySpaceID)
		log.Printf("[Config] Updated in-memory config from org-config.yaml\n")
	})

	// Load org config into main config if available
	if orgConfigHandler.IsConfigured() {
		orgData := orgConfigHandler.GetConfig()
		admins := make([]config.AdminInfo, len(orgData.Admins))
		for i, a := range orgData.Admins {
			admins[i] = config.AdminInfo{AID: a.AID, Name: a.Name, OOBI: a.OOBI}
		}
		cfg.SetOrgConfig(orgData.Organization.AID, orgData.Organization.Name, admins, orgData.CommunitySpaceID)
	}

	fmt.Fprintf(out, "  Configuration loaded\n")
	if cfg.IsOrgConfigured() {
		fmt.Fprintf(out, "   Organization: %s\n", cfg.Bootstrap.Organization.Name)
		fmt.Fprintf(out, "   Org AID: %s\n", cfg.GetOrgAID())
		fmt.Fprintf(out, "   Admin AID: %s\n", cfg.GetAdminAID())
	} else {
		fmt.Fprintln(out, "   Organization: Not configured (run frontend setup)")
	}
	fmt.Fprintln(out)

	// Initialize user identity (per-user mode)
	fmt.Fprintln(out, "Initializing user identity...")
	userIdentity := identity.NewEncrypted(opts.DataDir, opts.IdentityEncryptionKey)
	if userIdentity.IsConfigured() {
		fmt.Fprintf(out, "  Identity loaded from disk\n")
		fmt.Fprintf(out, "   AID: %s\n", userIdentity.GetAID())
		fmt.Fprintf(out, "   Peer ID: %s\n", userIdentity.GetPeerID())
	} else {
		fmt.Fprintln(out, "  No identity configured yet (will be set via /api/v1/identity/set)")
	}
	fmt.Fprintln(out)

	// Initialize any-sync client
	fmt.Fprintln(out, "Initializing any-sync client...")

	anysyncConfigPath := opts.AnysyncConfigPath

	// Serves the full fetched client config over the loopback API so the
	// Capacitor frontend can source it locally (issue #99). Populated below
	// once the startup fetch succeeds; stays empty (503) when the fetch is
	// skipped, which only happens on dev/test where the frontend hits the
	// config server directly anyway.
	clientConfigHandler := api.NewClientConfigHandler()

	// Push-relay URL sourced from the fetched client config (issue #329). The
	// embedded backend on Android has no process environment, so MATOU_PUSH_RELAY_URL
	// can't reach it — it learns the relay URL from the same config-server body it
	// already fetches here. Env still wins in the push block below; this is the
	// fallback and stays empty when the fetch is skipped (dev/test) or the body
	// carries no push_relay_url key.
	var configPushRelayURL string

	// In production, always fetch fresh config from the config server.
	// For dev/test, fetch only if the config file doesn't exist.
	shouldFetch := opts.IsProd() || os.IsNotExist(func() error { _, statErr := os.Stat(anysyncConfigPath); return statErr }())
	if shouldFetch {
		fmt.Fprintf(out, "  Fetching any-sync config from config server %s...\n", opts.ConfigServerURL)
		rawConfig, fetchErr := fetchAndSaveAnySyncConfig(opts.ConfigServerURL, anysyncConfigPath)
		if fetchErr != nil {
			// In production, try using cached config if fetch fails
			if opts.IsProd() {
				if _, statErr := os.Stat(anysyncConfigPath); statErr == nil {
					fmt.Fprintf(out, "  Config server unreachable, using cached config at %s\n", anysyncConfigPath)
				} else {
					return nil, fmt.Errorf("failed to fetch any-sync config from config server: %w\n\n"+
						"Ensure the config server is running at %s", fetchErr, opts.ConfigServerURL)
				}
			} else {
				return nil, fmt.Errorf("failed to fetch any-sync config from config server: %w\n\n"+
					"Ensure the config server is running at %s", fetchErr, opts.ConfigServerURL)
			}
		} else {
			clientConfigHandler.SetRaw(rawConfig)
			configPushRelayURL = pushRelayURLFromConfig(rawConfig)
			fmt.Fprintf(out, "  Config saved to %s\n", anysyncConfigPath)
		}
	}

	// If identity is persisted with mnemonic, derive peer key for SDK initialization
	sdkOpts := &anysync.ClientOptions{
		DataDir:     opts.DataDir,
		PeerKeyPath: opts.DataDir + "/peer.key",
	}
	if userIdentity.IsConfigured() {
		sdkOpts.Mnemonic = userIdentity.GetMnemonic()
		fmt.Fprintln(out, "  Using mnemonic-derived peer key from persisted identity")
	}

	sdkClient, err := anysync.NewSDKClient(anysyncConfigPath, sdkOpts)
	if err != nil {
		return nil, fmt.Errorf("failed to create any-sync SDK client: %w", err)
	}
	closers = append(closers, sdkClient.Close)
	var anysyncClient anysync.AnySyncClient = sdkClient

	fmt.Fprintf(out, "  any-sync client initialized\n")
	fmt.Fprintf(out, "   Network ID: %s\n", anysyncClient.GetNetworkID())
	fmt.Fprintf(out, "   Coordinator: %s\n", anysyncClient.GetCoordinatorURL())
	fmt.Fprintf(out, "   Peer ID: %s\n", anysyncClient.GetPeerID())

	// Validate any-sync network connectivity
	fmt.Fprint(out, "  Validating network connectivity...")
	if pingErr := sdkClient.Ping(); pingErr != nil {
		fmt.Fprintln(out, " FAILED")
		configFile := "client-dev.yml"
		infraSuffix := ""
		if opts.IsTest() {
			configFile = "client-test.yml"
			infraSuffix = "-test"
		} else if opts.IsProd() {
			configFile = "client-production.yml"
		}
		return nil, fmt.Errorf("\nCannot connect to any-sync network: %w\n\n"+
			"Troubleshooting:\n"+
			"  1. Check that any-sync infrastructure is running:\n"+
			"     cd ../matou-infrastructure/any-sync && make health%s\n"+
			"  2. Ensure config/%-22s matches the running network.\n"+
			"     To update: cp ../matou-infrastructure/any-sync/etc%s/client.yml config/%s",
			pingErr, infraSuffix, configFile, infraSuffix, configFile)
	}
	fmt.Fprintln(out, " OK")
	fmt.Fprintln(out)

	// Initialize local storage
	fmt.Fprintln(out, "Initializing local storage (anystore)...")

	store, err := anystore.NewLocalStore(anystore.DefaultConfig(opts.DataDir))
	if err != nil {
		return nil, fmt.Errorf("failed to create local store: %w", err)
	}
	closers = append(closers, store.Close)

	// Ensure chat indexes for anystore persistence
	if err := store.EnsureChatIndexes(ctx); err != nil {
		return nil, fmt.Errorf("failed to create chat indexes: %w", err)
	}

	fmt.Fprintf(out, "  Local storage initialized (with chat indexes)\n")
	fmt.Fprintf(out, "   Data directory: %s\n", opts.DataDir)
	fmt.Fprintln(out)

	// Determine community space ID: prefer runtime config from identity, fall back to org config
	communitySpaceID := orgConfigHandler.GetCommunitySpaceID()
	orgAID := orgConfigHandler.GetOrgAID()
	if userIdentity.GetCommunitySpaceID() != "" {
		communitySpaceID = userIdentity.GetCommunitySpaceID()
	}
	if userIdentity.GetOrgAID() != "" {
		orgAID = userIdentity.GetOrgAID()
	}

	// Load additional space IDs from persisted identity
	communityReadOnlySpaceID := ""
	adminSpaceID := ""
	if userIdentity.GetCommunityReadOnlySpaceID() != "" {
		communityReadOnlySpaceID = userIdentity.GetCommunityReadOnlySpaceID()
	}
	if userIdentity.GetAdminSpaceID() != "" {
		adminSpaceID = userIdentity.GetAdminSpaceID()
	}

	// Initialize space manager
	fmt.Fprintln(out, "Initializing space manager...")
	spaceManager := anysync.NewSpaceManager(anysyncClient, &anysync.SpaceManagerConfig{
		CommunitySpaceID:         communitySpaceID,
		CommunityReadOnlySpaceID: communityReadOnlySpaceID,
		AdminSpaceID:             adminSpaceID,
		OrgAID:                   orgAID,
	}, sdkClient.GetTreeManager())
	spaceStore := anystore.NewSpaceStoreAdapter(store)

	fmt.Fprintf(out, "  Space manager initialized\n")
	fmt.Fprintf(out, "   Community Space ID: %s\n", communitySpaceID)
	fmt.Fprintln(out)

	// Verify community space (log warning if not configured)
	if communitySpaceID == "" {
		fmt.Fprintln(out, "  Warning: Community space ID not configured")
		fmt.Fprintln(out, "     Memberships will only be stored in private spaces")
	}

	// Initialize KERI client (config-only, no KERIA connection needed)
	fmt.Fprintln(out, "Initializing KERI client...")
	keriClient, err := keri.NewClient(&keri.Config{
		OrgAID:   orgConfigHandler.GetOrgAID(),
		OrgAlias: orgConfigHandler.GetOrgName(), // Use name as alias
		OrgName:  orgConfigHandler.GetOrgName(),
	})
	if err != nil {
		return nil, fmt.Errorf("failed to create KERI client: %w", err)
	}

	fmt.Fprintf(out, "  KERI client initialized\n")
	if !orgConfigHandler.IsConfigured() {
		fmt.Fprintln(out, "   Note: Organization not configured yet - credential validation disabled")
	}
	fmt.Fprintf(out, "   Note: Credential issuance handled by frontend (signify-ts)\n")
	fmt.Fprintln(out)

	// Initialize type registry
	fmt.Fprintln(out, "Initializing type registry...")
	typeRegistry := matouTypes.NewRegistry()
	typeRegistry.Bootstrap()
	fmt.Fprintf(out, "  Type registry initialized with %d types\n", len(typeRegistry.All()))
	fmt.Fprintln(out)

	// Create event broker for SSE
	eventBroker := api.NewEventBroker()

	// Peer-side write-rule validation (GH#19 part 1): exclude forged high-stakes
	// changes (contribution sign-off/reward, project completion, plan/proposal
	// sign-off, role changes) that a modified peer writes directly into shared
	// spaces from this node's derived state. Any-sync ACLs are only
	// space-scoped and cannot express per-object rules, so this runs at
	// state-reconstruction time. Verdicts are deterministic: author → AID via
	// ACL join records (first-bound wins, record order) → role as-of the
	// change's timestamp via the CommunityProfile role history. The validator
	// is installed BEFORE the listener is registered with the space manager
	// so no tree update is ever processed unvalidated; the resolver is
	// populated by a background refresher (single pass over profile trees).
	writeRuleResolver := anysync.NewHistoryRoleResolver()
	writeRuleRecorder := anysync.NewLoggingRejectionRecorder(200)
	// GH#19 part 2: high-stakes proof-backed transitions (contribution
	// sign-off/reward, project completion, plan sign-off) are gated on
	// cryptographic KERI action-proof verification when crypto enforcement is on.
	// The key snapshot is populated by the refresher below from the same
	// KERIA key-state source signed-auth uses. Enforcement is gated by
	// MATOU_REQUIRE_SIGNED_AUTH (default OFF) — the same signal that makes
	// X-User-AID trustworthy — so environments without live KERIA keep the
	// interim role-based behaviour and are never broken by a missing proof.
	writeRuleKeys := anysync.NewStaticKeyProvider()
	enforceProofs := signedAuthEnforced()
	// Project-scoped write rules (issue #166): a Contribution/Plan sign-off is
	// gated on the signer's role on the OWNING project, resolved from this
	// snapshot of per-project assignments (rebuilt by the refresher below,
	// alongside the role snapshot). A project not yet in the snapshot falls back
	// to the community-role gate, so no legitimate sign-off is dropped on lag.
	writeRuleProjects := anysync.NewProjectAssignmentStore()
	writeRuleValidator := anysync.NewWriteRuleValidator(writeRuleResolver, writeRuleKeys, writeRuleRecorder, enforceProofs).
		WithProjectAssignments(writeRuleProjects)
	spaceManager.ObjectTreeManager().SetChangeValidator(writeRuleValidator)

	// Create push-based listener for P2P chat changes (replaces polling)
	chatListener := anysync.NewTreeUpdateListener(
		&chatPersisterAdapter{store: store},
		&eventBrokerAdapter{broker: eventBroker},
	)
	chatListener.SetChangeValidator(writeRuleValidator)
	// Bind proof-backed transitions to their space during listener-path
	// validation (anti-cross-space-replay). Resolves a tree id to its space via
	// the tree index; returns "" (space check skipped) if not yet indexed.
	chatListener.SetSpaceResolver(func(treeId string) string {
		return spaceManager.TreeManager().SpaceForTree(treeId)
	})
	spaceManager.SetObjectTreeListener(chatListener)

	// Wire up FreshTreeReader so the listener can rebuild trees with updated ACL keys
	// when the cached tree was built before the joiner's InviteJoin was applied.
	chatListener.SetFreshTreeReader(func(treeId string) (objecttree.ObjectTree, error) {
		utm := spaceManager.TreeManager()
		ctx := context.Background()

		// Fast path: tree is already indexed.
		if spaceId := utm.SpaceForTree(treeId); spaceId != "" {
			return utm.BuildFreshTree(ctx, spaceId, treeId)
		}

		// Slow path: tree arrived via P2P sync between BuildSpaceIndex runs, so
		// the index doesn't know about it. Re-index every known space, then
		// look up again. If still missing, try each known space directly.
		for _, sid := range utm.KnownSpaceIDs() {
			_ = utm.BuildSpaceIndex(ctx, sid)
		}
		if spaceId := utm.SpaceForTree(treeId); spaceId != "" {
			return utm.BuildFreshTree(ctx, spaceId, treeId)
		}
		for _, sid := range utm.KnownSpaceIDs() {
			if tree, err := utm.BuildFreshTree(ctx, sid, treeId); err == nil {
				return tree, nil
			}
		}
		return nil, fmt.Errorf("no space found for tree %s (probed %d spaces)", treeId, len(utm.KnownSpaceIDs()))
	})

	// Create API handlers
	credHandler := api.NewCredentialsHandler(keriClient, store)
	syncHandler := api.NewSyncHandler(keriClient, store, spaceManager, spaceStore, userIdentity)
	trustHandler := api.NewTrustHandler(store, orgConfigHandler.GetOrgAID(), spaceManager)
	healthHandler := api.NewHealthHandler(store, spaceStore, orgConfigHandler.GetOrgAID, orgConfigHandler.GetAdminAID)
	spacesHandler := api.NewSpacesHandler(spaceManager, store, userIdentity, spaceManager.FileManager())
	emailSender := email.NewSender(cfg.SMTP, opts.ConfigServerToken)
	invitesHandler := api.NewInvitesHandler(emailSender)
	bookingHandler := api.NewBookingHandler(emailSender)
	notificationsHandler := api.NewNotificationsHandler(emailSender)
	identityHandler := api.NewIdentityHandler(userIdentity, sdkClient, spaceManager, spaceStore)
	eventsHandler := api.NewEventsHandler(eventBroker)
	profilesHandler := api.NewProfilesHandler(spaceManager, userIdentity, typeRegistry, spaceManager.FileManager(), eventBroker)
	multisigHandler := api.NewMultisigHandler(spaceManager)
	noticesHandler := api.NewNoticesHandler(spaceManager, userIdentity, typeRegistry, eventBroker)
	filesHandler := api.NewFilesHandler(spaceManager.FileManager(), spaceManager)
	chatHandler := api.NewChatHandler(spaceManager, userIdentity, eventBroker, store, chatListener)
	commentCursorsHandler := api.NewCommentCursorsHandler(spaceManager, userIdentity)

	// Initialize contributions system
	fmt.Fprintln(out, "Initializing contributions system...")
	contribStoreAdapter := anysync.NewObjectStoreAdapter(spaceManager.ObjectTreeManager(), sdkClient, userIdentity)
	contribService := contributions.NewService(contribStoreAdapter)
	// Validate proposal writes against the org's persisted Proposal schema
	// (custom required fields, enum edits) in addition to the built-in checks.
	contribService.SetRegistry(typeRegistry)
	notifBroadcaster := notifications.NewSSEBrokerAdapter(eventBroker)
	notifEmailAdapter := notifications.NewEmailAdapter(emailSender)
	notifService := notifications.NewService(notifBroadcaster, notifEmailAdapter)
	contribNotifier := &contribNotifierAdapter{svc: notifService}

	profileRoleLookup := contributions.NewProfileRoleLookup(contribStoreAdapter, communityReadOnlySpaceID)
	// The backend boots before an identity (and its read-only space) exists, so the
	// captured communityReadOnlySpaceID is empty until a restart. Consult the live
	// identity so the admin's Founding Member role resolves as soon as the read-only
	// space is created — e.g. during org-setup's re-set of its own identity (#174).
	profileRoleLookup.SetSpaceIDResolver(userIdentity.GetCommunityReadOnlySpaceID)

	// Push notifications (docs/architecture/08-push-notifications.md §8): a third
	// notifications sink beside SSE and email that wakes backgrounded Android
	// devices via a push-relay. Dark unless MATOU_PUSH_RELAY_URL names the relay,
	// so dev/test and the Electron build are unaffected. Only the sender's own
	// node fires a push (PushSender skips p2p-replicated events), and recipients
	// are the community-space ACL members that may read the channel (its
	// AllowedRoles gate, §4), minus the sender. Relay calls authenticate with a
	// KERI-signed session, but the backend cannot sign: the frontend signs a
	// relay-issued challenge over the loopback push/relay-challenge+relay-session
	// endpoints and the backend spends the resulting token (#277). Until the
	// WebView mints one, register/notify drop with ErrNoSession — logged once,
	// never fatal.
	var pushHandler *api.PushHandler
	// Env wins (dev/test override); when unset, fall back to the push_relay_url the
	// backend learned from the fetched client config (issue #329). Both absent →
	// relayURL is empty and push stays dark.
	relayURL := strings.TrimSpace(os.Getenv("MATOU_PUSH_RELAY_URL"))
	if relayURL == "" {
		relayURL = configPushRelayURL
	}
	if relayURL != "" {
		// The relay carries device FCM tokens and full recipient-AID lists, so
		// plain http to a non-loopback host is refused unless explicitly opted
		// into — same rule and escape-hatch shape as the KERIA key-state URL below.
		var relayOpts []pushrelayclient.Option
		if os.Getenv("MATOU_PUSH_RELAY_ALLOW_HTTP") == "1" {
			relayOpts = append(relayOpts, pushrelayclient.AllowInsecureHTTP())
		}
		relayClient, err := pushrelayclient.New(relayURL, relayOpts...)
		if err != nil {
			// Leave push dark rather than crash: every other subsystem is fine
			// and notifications still reach the app over SSE.
			log.Printf("[Push] invalid push relay URL %q: %v — push notifications disabled", relayURL, err)
		} else {
			fmt.Fprintf(out, "Push relay configured: %s\n", relayURL)
			aclMembers := notifications.ChannelMembersFunc(func(channelID string) ([]string, error) {
				ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
				defer cancel()
				aidMap, err := spaceManager.ACLManager().AccountAIDMap(ctx, communitySpaceID)
				if err != nil {
					return nil, err
				}
				aids := make([]string, 0, len(aidMap))
				for _, aid := range aidMap {
					aids = append(aids, aid)
				}
				return aids, nil
			})
			// A channel's AllowedRoles gate: the cached channel record, falling
			// back to the community tree when the cache has not seen it yet.
			channelAllowedRoles := func(channelID string) ([]string, error) {
				ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
				defer cancel()
				if store != nil {
					if ch, err := store.GetChannel(ctx, channelID); err == nil {
						return ch.AllowedRoles, nil
					}
				}
				obj, err := spaceManager.ObjectTreeManager().ReadLatestByID(ctx, communitySpaceID, channelID)
				if err != nil {
					return nil, fmt.Errorf("reading channel %s: %w", channelID, err)
				}
				var data struct {
					AllowedRoles []string `json:"allowedRoles,omitempty"`
				}
				if err := json.Unmarshal(obj.Data, &data); err != nil {
					return nil, fmt.Errorf("parsing channel %s: %w", channelID, err)
				}
				return data.AllowedRoles, nil
			}
			// Same role resolver the write rules use, so push eligibility and
			// read eligibility cannot drift apart.
			rolesForAID := func(aid string) ([]string, error) {
				roles, err := profileRoleLookup.GetUserRoles(aid)
				if err != nil {
					return nil, err
				}
				names := make([]string, 0, len(roles))
				for _, r := range roles {
					names = append(names, string(r))
				}
				return names, nil
			}
			memberResolver := notifications.NewRoleGatedMembers(aclMembers, channelAllowedRoles, rolesForAID)
			pushSender := notifications.NewPushSender(relayClient, memberResolver)
			eventBroker.AddSink(func(e api.SSEEvent) {
				pushSender.Broadcast(notifications.SSEEvent{Type: e.Type, Data: e.Data})
			})
			pushHandler = api.NewPushHandler(relayClient, userIdentity)
		}
	}

	rolePolicyProvider := contributions.NewStorePolicyProvider(contribStoreAdapter, communityReadOnlySpaceID, 5*time.Second)
	// The read-only space ID is empty until an identity exists (first run /
	// org setup happens after boot), so resolve it live rather than freezing
	// the boot-time value.
	rolePolicyProvider.SetSpaceIDResolver(userIdentity.GetCommunityReadOnlySpaceID)
	contributions.SetPolicyProvider(rolePolicyProvider)
	rolePolicyHandler := api.NewRolePolicyHandler(
		rolePolicyProvider,
		api.NewSpacePolicyWriter(spaceManager, communityReadOnlySpaceID),
		contribStoreAdapter,
		communityReadOnlySpaceID,
		profileRoleLookup.IsAdminAID,
	)
	rolePolicyHandler.SetSpaceIDResolver(userIdentity.GetCommunityReadOnlySpaceID)
	orgConfigRoleLookup := api.NewOrgConfigAdminLookup(orgConfigHandler)
	credentialRoleLookup := api.NewCredentialRoleLookup(store)
	identityRoleLookup := api.NewIdentityRoleLookup(userIdentity)
	roleLookup := api.NewCompositeRoleLookup(profileRoleLookup, orgConfigRoleLookup, credentialRoleLookup, identityRoleLookup)

	// Signed-challenge authentication (issue #18): make X-User-AID trustworthy.
	// The backend resolves an AID's current signing keys read-only from KERIA's
	// CESR/OOBI endpoint, verifies a signed challenge, and mints a short-lived
	// session token checked per request. Enforcement is gated by
	// MATOU_REQUIRE_SIGNED_AUTH (default OFF); the Playwright e2e config sets it
	// ON against real KERIA infrastructure. NEEDS LIVE VERIFICATION: the exact
	// KERIA key-state URL is deployment-specific and verified by the e2e run.
	keyStateURLTemplate := opts.KeyStateURL
	if keyStateURLTemplate == "" {
		keyStateURLTemplate = strings.TrimRight(cfg.KERI.CESRURL, "/") + "/oobi/{aid}"
	}
	var resolverOpts []auth.ResolverOption
	if os.Getenv("MATOU_KERIA_KEYSTATE_ALLOW_HTTP") == "1" {
		resolverOpts = append(resolverOpts, auth.AllowInsecureHTTP())
	}
	var keyStateResolver auth.KeyStateResolver
	if kr, err := auth.NewKERIAResolver(keyStateURLTemplate, 5*time.Minute, resolverOpts...); err != nil {
		log.Printf("[Auth] invalid key-state URL template %q: %v — falling back to static resolver", keyStateURLTemplate, err)
		keyStateResolver = auth.NewStaticKeyStateResolver()
	} else {
		keyStateResolver = kr
	}
	authVerifier := auth.NewVerifier(keyStateResolver, nil, auth.NewSessionStore(opts.SessionTTL))
	authHandler := api.NewAuthHandler(authVerifier)

	// Revoke sessions when an AID's key state rotates: a session-verified KEL
	// sync for the caller's own AID triggers a re-resolve from the authoritative
	// key-state source (never the request body).
	syncHandler.SetRotationHook(authVerifier.OnRotation)

	// Grant community_admin role to all configured org admins.
	// Also register a callback so admin AIDs are updated whenever org config changes
	// (e.g. when org setup runs after server start).
	setAdminAIDsFromConfig := func(orgData *api.OrgConfigData) {
		adminAIDs := make([]string, 0, len(orgData.Admins))
		for _, a := range orgData.Admins {
			if a.AID != "" {
				adminAIDs = append(adminAIDs, a.AID)
			}
		}
		profileRoleLookup.SetAdminAIDs(adminAIDs)
		log.Printf("[RBAC] Updated admin AIDs: %v", adminAIDs)
	}
	if orgConfigHandler.IsConfigured() {
		setAdminAIDsFromConfig(orgConfigHandler.GetConfig())
	}
	orgConfigHandler.AddOnUpdate(setAdminAIDsFromConfig)

	// Write-rule role refresher: rebuilds the resolver snapshot from synced
	// state — ACL join records of the community space and one listing pass
	// over the CommunityProfile trees of the read-only space — every 30s, off
	// the tree-processing hot path. Stopped via the app's closers on Shutdown.
	refreshWriteRuleRoles := func(ctx context.Context) {
		defer func() {
			if rec := recover(); rec != nil {
				log.Printf("[write-rules] role refresh panicked: %v", rec)
			}
		}()
		if communitySpaceID == "" || communityReadOnlySpaceID == "" {
			return
		}
		accountAID, err := spaceManager.ACLManager().AccountAIDMap(ctx, communitySpaceID)
		if err != nil {
			log.Printf("[write-rules] account→AID refresh failed: %v", err)
			return
		}
		history, err := spaceManager.ObjectTreeManager().CollectRoleHistories(ctx, communityReadOnlySpaceID)
		if err != nil {
			log.Printf("[write-rules] role history refresh failed: %v", err)
			return
		}
		adminAIDs := make(map[string]bool)
		if orgConfigHandler.IsConfigured() {
			for _, a := range orgConfigHandler.GetConfig().Admins {
				if a.AID != "" {
					adminAIDs[a.AID] = true
				}
			}
		}
		writeRuleResolver.Replace(anysync.RoleSnapshot{AccountAID: accountAID, History: history, AdminAIDs: adminAIDs})

		// Project-scoped write rules (issue #166): refresh the per-project
		// assignment snapshot from the community space's Project + Contribution
		// objects. Best-effort — a failed pass leaves the previous snapshot in
		// place and the rules fall back to the community-role gate.
		if assignments, err := spaceManager.ObjectTreeManager().CollectProjectAssignments(ctx, communitySpaceID); err != nil {
			log.Printf("[write-rules] project-assignment refresh failed: %v", err)
		} else {
			writeRuleProjects.Replace(assignments)
		}

		// GH#19 part 2: when proof enforcement is on, refresh the signing-key
		// snapshot the proof verifier reads. Resolve each known member/admin
		// AID's current KEL signing key off the hot path (a network fetch, so
		// never done under a tree lock). Best-effort: an AID that fails to
		// resolve is simply absent from the snapshot, and a proof from it then
		// fails closed. NEEDS LIVE VERIFICATION: requires a reachable KERIA
		// key-state endpoint (see the signed-auth wiring below); the e2e run is
		// the verification per the ticket's acceptance criteria.
		if enforceProofs {
			aids := make(map[string]bool, len(accountAID)+len(adminAIDs))
			for _, aid := range accountAID {
				if aid != "" {
					aids[aid] = true
				}
			}
			for aid := range adminAIDs {
				aids[aid] = true
			}
			keySnap := make(map[string][]string, len(aids))
			for aid := range aids {
				keys, err := keyStateResolver.CurrentKeys(ctx, aid)
				if err != nil {
					log.Printf("[write-rules] key-state refresh failed for %s: %v", aid, err)
					continue
				}
				keySnap[aid] = keys
			}
			writeRuleKeys.Replace(keySnap)

			// GH#19 part 3 (#112): when the resolver can serve full KEL history,
			// snapshot each AID's establishment key states so the proof verifier
			// can validate a proof against the signing key as of its KEL sn —
			// surviving a later legitimate rotation (AnchoredKeyProvider). Absent
			// history, SigningKeysAt falls back to current keys (fail-closed on
			// rotation), so this is a best-effort enrichment. NEEDS LIVE
			// VERIFICATION: exercised only against a reachable KERIA endpoint.
			if hr, ok := keyStateResolver.(auth.KeyHistoryResolver); ok {
				histSnap := make(map[string][]auth.EstablishmentKeyState, len(aids))
				for aid := range aids {
					hist, err := hr.KeyHistory(ctx, aid)
					if err != nil {
						log.Printf("[write-rules] key-history refresh failed for %s: %v", aid, err)
						continue
					}
					histSnap[aid] = hist
				}
				writeRuleKeys.ReplaceHistory(histSnap)
			}
			// Credential/TEL binding (#112) is available as a seam
			// (WriteRuleValidator.WithCredentialVerifier + SnapshotCredentialVerifier)
			// and exercised by fixture tests, but is not wired here: there is no
			// synced representation of credential TEL/revocation status in-repo
			// yet (revocation happens client-side via KERIA), so a live snapshot
			// cannot yet distinguish revoked from active credentials. Attaching an
			// empty/incomplete verifier would fail-closed on legitimate
			// transitions, so the check stays opt-in until the TEL snapshot source
			// lands (tracked in docs/RBAC.md).
		}
	}
	refreshCtx, stopRefresh := context.WithCancel(ctx)
	refreshDone := make(chan struct{})
	go func() {
		defer close(refreshDone)
		refreshWriteRuleRoles(refreshCtx)
		ticker := time.NewTicker(30 * time.Second)
		defer ticker.Stop()
		for {
			select {
			case <-refreshCtx.Done():
				return
			case <-ticker.C:
				refreshWriteRuleRoles(refreshCtx)
			}
		}
	}()
	closers = append(closers, func() error { stopRefresh(); <-refreshDone; return nil })

	// Mirror org config writes to the legacy config server for backward
	// compatibility (older clients / multi-session dev still read it). The
	// backend is the primary source of truth (OrgConfigHandler above), so a
	// failure here is logged and swallowed rather than surfaced to the caller.
	// This used to be a direct unauthenticated POST from the browser
	// (frontend/src/api/config.ts); it moved server-side because the admin
	// token must not be exposed to the browser.
	//
	// The onUpdate chain runs inline in the config-save request, so the
	// mirror client needs a timeout: against a remote config server an
	// un-timeout-ed connect would stall POST /api/v1/org/config.
	mirrorClient := &http.Client{Timeout: 10 * time.Second}
	orgConfigHandler.AddOnUpdate(func(orgData *api.OrgConfigData) {
		if mirrorErr := api.MirrorToConfigServer(mirrorClient, opts.ConfigServerURL, opts.ConfigServerToken, opts.IsTest(), orgData); mirrorErr != nil {
			log.Printf("[Config] Config-server mirror write failed (non-critical): %v", mirrorErr)
		} else if opts.ConfigServerToken != "" {
			log.Printf("[Config] Mirrored org config to config server")
		}
	})

	// Read counterpart to the mirror: on a cache miss the org-config GET handler
	// fetches org config from the config server server-side, so a fresh mobile
	// install reaches onboarding without the WebView ever touching the remote
	// plain-http host (issue #265; mirrors the #99 client-config flow). The
	// timeout is kept under the frontend's 5s org-config fetch so the loopback
	// request doesn't outlive the WebView's own AbortSignal.
	orgConfigHandler.SetConfigServerSource(&http.Client{Timeout: 4 * time.Second}, opts.ConfigServerURL, opts.IsTest())

	proposalsHandler := api.NewProposalsHandler(contribService, spaceManager, contribNotifier)
	proposalsHandler.SetRegistry(typeRegistry)
	projectsHandler := api.NewProjectsHandler(contribService, spaceManager, contribNotifier)
	decisionPlansHandler := api.NewDecisionPlansHandler(contribService, spaceManager, contribNotifier)
	implPlansHandler := api.NewImplementationPlansHandler(contribService, spaceManager)
	milestonesHandler := api.NewMilestonesHandler(contribService, spaceManager)
	contributionsHandler := api.NewContributionsHandler(contribService, spaceManager, contribNotifier)

	// Wire event broker to contribution, project, and plan handlers for SSE broadcasts
	contributionsHandler.SetBroker(eventBroker)
	projectsHandler.SetBroker(eventBroker)
	implPlansHandler.SetBroker(eventBroker)
	fmt.Fprintln(out, "  Contributions system initialized")
	fmt.Fprintln(out)

	// Create HTTP server
	mux := http.NewServeMux()

	// Health check endpoint (with sync/trust status)
	mux.HandleFunc("/health", api.CORSHandler(healthHandler.HandleHealth))

	// Info endpoint
	mux.HandleFunc("/info", api.CORSHandler(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		fmt.Fprintf(w, `{
			"organization": {
				"name": "%s",
				"aid": "%s",
				"configured": %t
			},
			"admin": {
				"aid": "%s"
			},
			"anysync": {
				"networkId": "%s",
				"coordinator": "%s"
			}
		}`,
			orgConfigHandler.GetOrgName(),
			orgConfigHandler.GetOrgAID(),
			orgConfigHandler.IsConfigured(),
			orgConfigHandler.GetAdminAID(),
			anysyncClient.GetNetworkID(),
			anysyncClient.GetCoordinatorURL(),
		)
	}))

	// Register API routes
	credHandler.RegisterRoutes(mux, roleLookup)
	syncHandler.RegisterRoutes(mux, roleLookup)
	trustHandler.RegisterRoutes(mux)
	spacesHandler.RegisterRoutes(mux, roleLookup)
	invitesHandler.RegisterRoutes(mux)
	bookingHandler.RegisterRoutes(mux)
	identityHandler.RegisterRoutes(mux, roleLookup)
	eventsHandler.RegisterRoutes(mux)
	profilesHandler.RegisterRoutes(mux, roleLookup)
	multisigHandler.RegisterRoutes(mux)
	noticesHandler.RegisterRoutes(mux)
	filesHandler.RegisterRoutes(mux)
	chatHandler.RegisterRoutes(mux)
	commentCursorsHandler.Routes(mux)
	notificationsHandler.RegisterRoutes(mux)
	if pushHandler != nil {
		pushHandler.RegisterRoutes(mux)
	}
	authHandler.RegisterRoutes(mux)
	proposalsHandler.RegisterRoutes(mux, roleLookup)
	projectsHandler.RegisterRoutes(mux, roleLookup)
	decisionPlansHandler.RegisterRoutes(mux, roleLookup)
	implPlansHandler.RegisterRoutes(mux, roleLookup)
	milestonesHandler.RegisterRoutes(mux, roleLookup)
	contributionsHandler.RegisterRoutes(mux, roleLookup)
	rolePolicyHandler.RegisterRoutes(mux, roleLookup)
	orgConfigHandler.RegisterRoutes(mux, roleLookup)
	clientConfigHandler.RegisterRoutes(mux)

	// Bind the listener before starting the sync worker so a bind failure aborts
	// cleanly. net.Listen honours port 0 by picking a free port, which App.Port
	// then reports back (used by tests and by any dynamic-port host).
	addr := fmt.Sprintf("%s:%d", cfg.Server.Host, opts.Port)
	listener, err := net.Listen("tcp", addr)
	if err != nil {
		return nil, fmt.Errorf("failed to listen on %s: %w", addr, err)
	}

	fmt.Fprintf(out, "Starting HTTP server on %s\n", listener.Addr().String())
	fmt.Fprintln(out)

	// Start background sync worker
	syncWorkerConfig := bgSync.DefaultConfig()
	syncWorkerConfig.CommunitySpaceID = communitySpaceID
	syncWorker := bgSync.NewWorker(syncWorkerConfig, spaceManager, store, eventBroker)
	syncWorker.Start()
	closers = append(closers, func() error { syncWorker.Stop(); return nil })

	// Wrap with middleware: request logger → localhost guard → CORS → token
	// guard → signed-auth. LocalhostGuard blocks other machines; TokenGuard
	// blocks other local processes from issuing mutating requests without the
	// per-launch token (or a session minted through it — see
	// TokenGuardWithSessions). CORS sits outside both guards so 401 responses
	// carry Access-Control-Allow-Origin — a browser then surfaces the 401 + JSON
	// body instead of an opaque "Failed to fetch". Preflight OPTIONS is answered
	// by CORSMiddleware before either guard sees it. SignedAuthMiddleware
	// (gated by MATOU_REQUIRE_SIGNED_AUTH) sits innermost so it can set the
	// verified X-User-AID before any route/RBAC runs.
	handler := api.RequestLogger(api.LocalhostGuard(api.CORSMiddleware(
		api.TokenGuardWithSessions(opts.APIToken, authHandler.Sessions(),
			api.SignedAuthMiddleware(authHandler.Sessions(), opts.APIToken, mux)))))

	app := newServing(listener, handler, closers)
	success = true
	return app, nil
}

// newServing wraps an already-bound listener in an App and begins serving
// handler in a background goroutine. closers are released (reverse order) by
// Shutdown. Factored out of Start so tests can exercise the listen/serve/
// shutdown lifecycle without the full backend wiring.
func newServing(listener net.Listener, handler http.Handler, closers []func() error) *App {
	app := &App{
		listener: listener,
		server:   &http.Server{Handler: handler},
		closers:  closers,
		serveErr: make(chan error, 1),
	}
	go func() {
		app.serveErr <- app.server.Serve(listener)
	}()
	return app
}

// Port returns the TCP port the server is listening on. When Options.Port was 0
// this is the free port net.Listen selected.
func (a *App) Port() int {
	if tcp, ok := a.listener.Addr().(*net.TCPAddr); ok {
		return tcp.Port
	}
	return 0
}

// Addr returns the listener's network address (host:port).
func (a *App) Addr() string {
	return a.listener.Addr().String()
}

// Wait blocks until the server stops serving and returns the reason. A graceful
// Shutdown is reported as nil (http.ErrServerClosed is not an error to callers).
func (a *App) Wait() error {
	err := <-a.serveErr
	if errors.Is(err, http.ErrServerClosed) {
		return nil
	}
	return err
}

// Shutdown gracefully stops the HTTP server, then releases every resource opened
// by Start in reverse of the order they were opened — mirroring the `defer
// X.Close()` unwinding cmd/server/main.go relied on. The first error encountered
// is returned; remaining closers still run.
func (a *App) Shutdown(ctx context.Context) error {
	var firstErr error
	if err := a.server.Shutdown(ctx); err != nil {
		firstErr = err
	}
	for i := len(a.closers) - 1; i >= 0; i-- {
		if err := a.closers[i](); err != nil && firstErr == nil {
			firstErr = err
		}
	}
	return firstErr
}

// signedAuthEnforced reports whether the KERI crypto stack is required, gating
// GH#19 part-2 proof enforcement on the same MATOU_REQUIRE_SIGNED_AUTH signal
// that makes X-User-AID trustworthy (see api.signedAuthEnabled). Default OFF, so
// environments without live KERIA keep the interim role-based write rules.
func signedAuthEnforced() bool {
	switch strings.ToLower(strings.TrimSpace(os.Getenv("MATOU_REQUIRE_SIGNED_AUTH"))) {
	case "1", "true", "yes", "on":
		return true
	default:
		return false
	}
}

// fetchAndSaveAnySyncConfig fetches the full client config from the config
// server, writes the any-sync fragment to disk as YAML, and returns the raw
// JSON body it fetched. The raw body is retained (via ClientConfigHandler) so
// the frontend can source the full config over the loopback API on Capacitor,
// where the WebView's cleartext policy blocks a direct config-server fetch
// (issue #99).
func fetchAndSaveAnySyncConfig(configServerURL, targetPath string) ([]byte, error) {
	resp, err := http.Get(configServerURL + "/api/client-config")
	if err != nil {
		return nil, fmt.Errorf("failed to reach config server at %s: %w", configServerURL, err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("config server returned status %d", resp.StatusCode)
	}

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, fmt.Errorf("failed to read response body: %w", err)
	}

	var envelope map[string]json.RawMessage
	if err := json.Unmarshal(body, &envelope); err != nil {
		return nil, fmt.Errorf("failed to parse JSON response: %w", err)
	}

	anysyncRaw, ok := envelope["anysync"]
	if !ok {
		return nil, fmt.Errorf("config server response missing \"anysync\" key")
	}

	var clientConfig interface{}
	if err := json.Unmarshal(anysyncRaw, &clientConfig); err != nil {
		return nil, fmt.Errorf("failed to parse anysync config: %w", err)
	}

	yamlData, err := yaml.Marshal(clientConfig)
	if err != nil {
		return nil, fmt.Errorf("failed to marshal config to YAML: %w", err)
	}

	if err := os.MkdirAll(filepath.Dir(targetPath), 0755); err != nil {
		return nil, fmt.Errorf("failed to create config directory: %w", err)
	}

	if err := os.WriteFile(targetPath, yamlData, 0644); err != nil {
		return nil, fmt.Errorf("failed to write config file: %w", err)
	}

	return body, nil
}

// pushRelayURLFromConfig extracts the top-level "push_relay_url" string from the
// raw client-config JSON body the backend fetched from the config server (issue
// #329). It is the embedded-backend fallback for MATOU_PUSH_RELAY_URL, which the
// Android build can't set. Returns "" when the body is absent, unparseable, or
// carries no such key — leaving push dark, exactly as before.
func pushRelayURLFromConfig(raw []byte) string {
	if len(raw) == 0 {
		return ""
	}
	var envelope struct {
		PushRelayURL string `json:"push_relay_url"`
	}
	if err := json.Unmarshal(raw, &envelope); err != nil {
		return ""
	}
	return strings.TrimSpace(envelope.PushRelayURL)
}

// eventBrokerAdapter adapts api.EventBroker to anysync.EventBroadcaster.
type eventBrokerAdapter struct {
	broker *api.EventBroker
}

func (a *eventBrokerAdapter) Broadcast(event anysync.SSEEvent) {
	a.broker.Broadcast(api.SSEEvent{
		Type: event.Type,
		Data: event.Data,
	})
}

// chatPersisterAdapter adapts anystore.LocalStore to anysync.ChatPersister.
// It converts ObjectPayload to anystore types, breaking the circular import.
type chatPersisterAdapter struct {
	store *anystore.LocalStore
}

func (a *chatPersisterAdapter) PersistChatObject(ctx context.Context, p *anysync.ObjectPayload) error {
	switch p.Type {
	case "ChatChannel":
		var data struct {
			Name         string   `json:"name"`
			Description  string   `json:"description,omitempty"`
			Icon         string   `json:"icon,omitempty"`
			Photo        string   `json:"photo,omitempty"`
			CreatedAt    string   `json:"createdAt"`
			CreatedBy    string   `json:"createdBy"`
			IsArchived   bool     `json:"isArchived,omitempty"`
			AllowedRoles []string `json:"allowedRoles,omitempty"`
		}
		if err := json.Unmarshal(p.Data, &data); err != nil {
			return err
		}
		return a.store.UpsertChannel(ctx, &anystore.ChatChannel{
			ID: p.ID, Name: data.Name, Description: data.Description,
			Icon: data.Icon, Photo: data.Photo, CreatedAt: data.CreatedAt,
			CreatedBy: data.CreatedBy, IsArchived: data.IsArchived,
			AllowedRoles: data.AllowedRoles, Version: p.Version,
		})

	case "ChatMessage":
		var data struct {
			ChannelID   string          `json:"channelId"`
			SenderAID   string          `json:"senderAid"`
			SenderName  string          `json:"senderName"`
			Content     string          `json:"content"`
			Attachments json.RawMessage `json:"attachments,omitempty"`
			ReplyTo     string          `json:"replyTo,omitempty"`
			SentAt      string          `json:"sentAt"`
			EditedAt    string          `json:"editedAt,omitempty"`
			DeletedAt   string          `json:"deletedAt,omitempty"`
		}
		if err := json.Unmarshal(p.Data, &data); err != nil {
			return err
		}
		return a.store.UpsertMessage(ctx, &anystore.ChatMessage{
			ID: p.ID, ChannelID: data.ChannelID, SenderAID: data.SenderAID,
			SenderName: data.SenderName, Content: data.Content,
			Attachments: data.Attachments, ReplyTo: data.ReplyTo,
			SentAt: data.SentAt, EditedAt: data.EditedAt,
			DeletedAt: data.DeletedAt, Version: p.Version,
		})

	case "MessageReaction":
		var data struct {
			MessageID   string   `json:"messageId"`
			Emoji       string   `json:"emoji"`
			ReactorAIDs []string `json:"reactorAids"`
		}
		if err := json.Unmarshal(p.Data, &data); err != nil {
			return err
		}
		return a.store.UpsertReaction(ctx, &anystore.ChatReaction{
			ID: p.ID, MessageID: data.MessageID, Emoji: data.Emoji,
			ReactorAIDs: data.ReactorAIDs, Version: p.Version,
		})
	}
	return nil
}

// contribNotifierAdapter bridges api.ContribNotifier to notifications.Service.
type contribNotifierAdapter struct {
	svc *notifications.Service
}

func (a *contribNotifierAdapter) Notify(n *api.ContribNotification) error {
	return a.svc.Notify(&notifications.Notification{
		Type:        notifications.NotificationType(n.Type),
		RecipientID: n.RecipientID,
		Title:       n.Title,
		Message:     n.Message,
		EntityID:    n.EntityID,
		EntityType:  n.EntityType,
		Channel:     notifications.ChannelInApp,
	})
}
