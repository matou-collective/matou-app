package main

import (
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"strconv"

	"gopkg.in/yaml.v3"

	"github.com/matou-dao/backend/internal/anysync"
	"github.com/matou-dao/backend/internal/anystore"
	"github.com/matou-dao/backend/internal/api"
	"github.com/matou-dao/backend/internal/config"
	"github.com/matou-dao/backend/internal/email"
	"github.com/matou-dao/backend/internal/identity"
	"github.com/matou-dao/backend/internal/keri"
	bgSync "github.com/matou-dao/backend/internal/sync"
	matouTypes "github.com/matou-dao/backend/internal/types"
)

// fetchAndSaveAnySyncConfig fetches the any-sync client config from the config
// server and writes it to disk as YAML.
func fetchAndSaveAnySyncConfig(configServerURL, targetPath string) error {
	resp, err := http.Get(configServerURL + "/api/client-config")
	if err != nil {
		return fmt.Errorf("failed to reach config server at %s: %w", configServerURL, err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("config server returned status %d", resp.StatusCode)
	}

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return fmt.Errorf("failed to read response body: %w", err)
	}

	var envelope map[string]json.RawMessage
	if err := json.Unmarshal(body, &envelope); err != nil {
		return fmt.Errorf("failed to parse JSON response: %w", err)
	}

	anysyncRaw, ok := envelope["anysync"]
	if !ok {
		return fmt.Errorf("config server response missing \"anysync\" key")
	}

	var clientConfig interface{}
	if err := json.Unmarshal(anysyncRaw, &clientConfig); err != nil {
		return fmt.Errorf("failed to parse anysync config: %w", err)
	}

	yamlData, err := yaml.Marshal(clientConfig)
	if err != nil {
		return fmt.Errorf("failed to marshal config to YAML: %w", err)
	}

	if err := os.MkdirAll(filepath.Dir(targetPath), 0755); err != nil {
		return fmt.Errorf("failed to create config directory: %w", err)
	}

	if err := os.WriteFile(targetPath, yamlData, 0644); err != nil {
		return fmt.Errorf("failed to write config file: %w", err)
	}

	return nil
}

func main() {
	// Detect environment: "test" uses isolated data, configs, and ports
	// "production" uses production configs (for Electron builds)
	env := os.Getenv("MATOU_ENV")
	isTest := env == "test"
	isProd := env == "production"

	switch {
	case isTest:
		fmt.Println("MATOU DAO Backend Server (TEST)")
	case isProd:
		fmt.Println("MATOU DAO Backend Server (PRODUCTION)")
	default:
		fmt.Println("MATOU DAO Backend Server")
	}
	fmt.Println("============================")
	fmt.Println()

	// Initialize data directory first (needed for org config)
	dataDir := os.Getenv("MATOU_DATA_DIR")
	if dataDir == "" {
		if isTest {
			dataDir = "./data-test"
		} else {
			dataDir = "./data"
		}
	}
	if err := os.MkdirAll(dataDir, 0755); err != nil {
		log.Fatalf("Failed to create data directory: %v", err)
	}

	// Load server configuration (SMTP, KERI URLs, etc.)
	fmt.Println("Loading configuration...")
	cfg, err := config.Load("", "")
	if err != nil {
		log.Fatalf("Failed to load config: %v", err)
	}

	// Test mode uses port 9080 to avoid conflicting with dev server on 8080
	if isTest {
		cfg.Server.Port = 9080
	}

	// Allow port override from environment (used by Electron to allocate dynamic ports)
	if portStr := os.Getenv("MATOU_SERVER_PORT"); portStr != "" {
		if port, parseErr := strconv.Atoi(portStr); parseErr == nil {
			cfg.Server.Port = port
		}
	}

	// Initialize org config handler - single source of truth for organization identity
	// The callback updates the in-memory config when org config is saved via API
	orgConfigHandler := api.NewOrgConfigHandler(dataDir, func(orgData *api.OrgConfigData) {
		admins := make([]config.AdminInfo, len(orgData.Admins))
		for i, a := range orgData.Admins {
			admins[i] = config.AdminInfo{AID: a.AID, Name: a.Name, OOBI: a.OOBI}
		}
		cfg.SetOrgConfig(orgData.Organization.AID, orgData.Organization.Name, admins, orgData.CommunitySpaceID)
		fmt.Printf("[Config] Updated in-memory config from org-config.yaml\n")
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

	fmt.Printf("  Configuration loaded\n")
	if cfg.IsOrgConfigured() {
		fmt.Printf("   Organization: %s\n", cfg.Bootstrap.Organization.Name)
		fmt.Printf("   Org AID: %s\n", cfg.GetOrgAID())
		fmt.Printf("   Admin AID: %s\n", cfg.GetAdminAID())
	} else {
		fmt.Println("   Organization: Not configured (run frontend setup)")
	}
	fmt.Println()

	// Initialize user identity (per-user mode)
	fmt.Println("Initializing user identity...")
	userIdentity := identity.New(dataDir)
	if userIdentity.IsConfigured() {
		fmt.Printf("  Identity loaded from disk\n")
		fmt.Printf("   AID: %s\n", userIdentity.GetAID())
		fmt.Printf("   Peer ID: %s\n", userIdentity.GetPeerID())
	} else {
		fmt.Println("  No identity configured yet (will be set via /api/v1/identity/set)")
	}
	fmt.Println()

	// Initialize any-sync client
	fmt.Println("Initializing any-sync client...")

	// Select config file based on environment
	anysyncConfigPath := os.Getenv("MATOU_ANYSYNC_CONFIG")
	if anysyncConfigPath == "" {
		switch {
		case isTest:
			// Test network uses ports 2001-2006
			anysyncConfigPath = "config/client-test.yml"
		case isProd:
			// Production network uses remote any-sync nodes
			anysyncConfigPath = "config/client-production.yml"
		default:
			// Dev network uses ports 1001-1006
			anysyncConfigPath = "config/client-dev.yml"
		}
	}

	// If the config file doesn't exist, try fetching it from the config server
	if _, err := os.Stat(anysyncConfigPath); os.IsNotExist(err) {
		configServerURL := os.Getenv("MATOU_CONFIG_SERVER_URL")
		if configServerURL == "" {
			switch {
			case isTest:
				configServerURL = "http://localhost:4904"
			case isProd:
				log.Fatalf("any-sync config file not found at %s and MATOU_CONFIG_SERVER_URL is not set for production", anysyncConfigPath)
			default:
				configServerURL = "http://localhost:3904"
			}
		}
		fmt.Printf("  Config file %s not found, fetching from config server %s...\n", anysyncConfigPath, configServerURL)
		if err := fetchAndSaveAnySyncConfig(configServerURL, anysyncConfigPath); err != nil {
			log.Fatalf("Failed to fetch any-sync config from config server: %v\n\n"+
				"Ensure the config server is running at %s\n", err, configServerURL)
		}
		fmt.Printf("  Config saved to %s\n", anysyncConfigPath)
	}

	// If identity is persisted with mnemonic, derive peer key for SDK initialization
	sdkOpts := &anysync.ClientOptions{
		DataDir:     dataDir,
		PeerKeyPath: dataDir + "/peer.key",
	}
	if userIdentity.IsConfigured() {
		sdkOpts.Mnemonic = userIdentity.GetMnemonic()
		fmt.Println("  Using mnemonic-derived peer key from persisted identity")
	}

	sdkClient, err := anysync.NewSDKClient(anysyncConfigPath, sdkOpts)
	if err != nil {
		log.Fatalf("Failed to create any-sync SDK client: %v", err)
	}
	var anysyncClient anysync.AnySyncClient = sdkClient
	defer sdkClient.Close()

	fmt.Printf("  any-sync client initialized\n")
	fmt.Printf("   Network ID: %s\n", anysyncClient.GetNetworkID())
	fmt.Printf("   Coordinator: %s\n", anysyncClient.GetCoordinatorURL())
	fmt.Printf("   Peer ID: %s\n", anysyncClient.GetPeerID())

	// Validate any-sync network connectivity
	fmt.Print("  Validating network connectivity...")
	if err := sdkClient.Ping(); err != nil {
		fmt.Println(" FAILED")
		configFile := "client-dev.yml"
		infraSuffix := ""
		if isTest {
			configFile = "client-test.yml"
			infraSuffix = "-test"
		} else if isProd {
			configFile = "client-production.yml"
		}
		log.Fatalf("\nCannot connect to any-sync network: %v\n\n"+
			"Troubleshooting:\n"+
			"  1. Check that any-sync infrastructure is running:\n"+
			"     cd ../matou-infrastructure/any-sync && make health%s\n"+
			"  2. Ensure config/%-22s matches the running network.\n"+
			"     To update: cp ../matou-infrastructure/any-sync/etc%s/client.yml config/%s\n",
			err, infraSuffix, configFile, infraSuffix, configFile)
	}
	fmt.Println(" OK")
	fmt.Println()

	// Initialize local storage
	fmt.Println("Initializing local storage (anystore)...")

	store, err := anystore.NewLocalStore(anystore.DefaultConfig(dataDir))
	if err != nil {
		log.Fatalf("Failed to create local store: %v", err)
	}
	defer store.Close()

	fmt.Printf("  Local storage initialized\n")
	fmt.Printf("   Data directory: %s\n", dataDir)
	fmt.Println()

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
	fmt.Println("Initializing space manager...")
	spaceManager := anysync.NewSpaceManager(anysyncClient, &anysync.SpaceManagerConfig{
		CommunitySpaceID:         communitySpaceID,
		CommunityReadOnlySpaceID: communityReadOnlySpaceID,
		AdminSpaceID:             adminSpaceID,
		OrgAID:                   orgAID,
	})
	spaceStore := anystore.NewSpaceStoreAdapter(store)

	fmt.Printf("  Space manager initialized\n")
	fmt.Printf("   Community Space ID: %s\n", communitySpaceID)
	fmt.Println()

	// Verify community space (log warning if not configured)
	if communitySpaceID == "" {
		fmt.Println("  Warning: Community space ID not configured")
		fmt.Println("     Memberships will only be stored in private spaces")
	}

	// Initialize KERI client (config-only, no KERIA connection needed)
	fmt.Println("Initializing KERI client...")
	keriClient, err := keri.NewClient(&keri.Config{
		OrgAID:   orgConfigHandler.GetOrgAID(),
		OrgAlias: orgConfigHandler.GetOrgName(), // Use name as alias
		OrgName:  orgConfigHandler.GetOrgName(),
	})
	if err != nil {
		log.Fatalf("Failed to create KERI client: %v", err)
	}

	fmt.Printf("  KERI client initialized\n")
	if !orgConfigHandler.IsConfigured() {
		fmt.Println("   Note: Organization not configured yet - credential validation disabled")
	}
	fmt.Printf("   Note: Credential issuance handled by frontend (signify-ts)\n")
	fmt.Println()

	// Initialize type registry
	fmt.Println("Initializing type registry...")
	typeRegistry := matouTypes.NewRegistry()
	typeRegistry.Bootstrap()
	fmt.Printf("  Type registry initialized with %d types\n", len(typeRegistry.All()))
	fmt.Println()

	// Create event broker for SSE
	eventBroker := api.NewEventBroker()

	// Create API handlers
	credHandler := api.NewCredentialsHandler(keriClient, store)
	syncHandler := api.NewSyncHandler(keriClient, store, spaceManager, spaceStore, userIdentity)
	trustHandler := api.NewTrustHandler(store, orgConfigHandler.GetOrgAID(), spaceManager)
	healthHandler := api.NewHealthHandler(store, spaceStore, orgConfigHandler.GetOrgAID(), orgConfigHandler.GetAdminAID())
	spacesHandler := api.NewSpacesHandler(spaceManager, store, userIdentity)
	emailSender := email.NewSender(cfg.SMTP)
	invitesHandler := api.NewInvitesHandler(emailSender)
	bookingHandler := api.NewBookingHandler(emailSender)
	notificationsHandler := api.NewNotificationsHandler(emailSender)
	identityHandler := api.NewIdentityHandler(userIdentity, sdkClient, spaceManager, spaceStore)
	eventsHandler := api.NewEventsHandler(eventBroker)
	profilesHandler := api.NewProfilesHandler(spaceManager, userIdentity, typeRegistry)
	filesHandler := api.NewFilesHandler(spaceManager.FileManager(), spaceManager)

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
	credHandler.RegisterRoutes(mux)
	syncHandler.RegisterRoutes(mux)
	trustHandler.RegisterRoutes(mux)
	spacesHandler.RegisterRoutes(mux)
	invitesHandler.RegisterRoutes(mux)
	bookingHandler.RegisterRoutes(mux)
	identityHandler.RegisterRoutes(mux)
	eventsHandler.RegisterRoutes(mux)
	profilesHandler.RegisterRoutes(mux)
	filesHandler.RegisterRoutes(mux)
	notificationsHandler.RegisterRoutes(mux)
	orgConfigHandler.RegisterRoutes(mux)

	// Start server
	addr := fmt.Sprintf("%s:%d", cfg.Server.Host, cfg.Server.Port)
	fmt.Printf("Starting HTTP server on %s\n", addr)
	fmt.Println()
	fmt.Println("Endpoints:")
	fmt.Println("  GET  /health                       - Health check")
	fmt.Println("  GET  /info                         - System information")
	fmt.Println()
	fmt.Println("  Identity (per-user mode):")
	fmt.Println("  POST /api/v1/identity/set          - Set user identity (triggers SDK restart)")
	fmt.Println("  GET  /api/v1/identity              - Get current identity status")
	fmt.Println("  DELETE /api/v1/identity             - Clear identity (logout/reset)")
	fmt.Println()
	fmt.Println("  Credentials:")
	fmt.Println("  GET  /api/v1/org                   - Organization info for frontend")
	fmt.Println("  GET  /api/v1/credentials           - List stored credentials")
	fmt.Println("  POST /api/v1/credentials           - Store credential from frontend")
	fmt.Println("  GET  /api/v1/credentials/{said}    - Get credential by SAID")
	fmt.Println("  POST /api/v1/credentials/validate  - Validate credential structure")
	fmt.Println("  GET  /api/v1/credentials/roles     - List available roles")
	fmt.Println()
	fmt.Println("  Sync:")
	fmt.Println("  POST /api/v1/sync/credentials      - Sync credentials from KERIA")
	fmt.Println("  POST /api/v1/sync/kel              - Sync KEL from KERIA")
	fmt.Println("  GET  /api/v1/community/members     - List community members")
	fmt.Println("  GET  /api/v1/community/credentials - List community-visible credentials")
	fmt.Println()
	fmt.Println("  Trust Graph:")
	fmt.Println("  GET  /api/v1/trust/graph           - Get trust graph (full or filtered)")
	fmt.Println("  GET  /api/v1/trust/score/{aid}     - Get trust score for an AID")
	fmt.Println("  GET  /api/v1/trust/scores          - Get top trust scores")
	fmt.Println("  GET  /api/v1/trust/summary         - Get trust graph summary")
	fmt.Println()
	fmt.Println("  Spaces (any-sync):")
	fmt.Println("  POST /api/v1/spaces/community                - Create community space")
	fmt.Println("  GET  /api/v1/spaces/community                - Get community space info")
	fmt.Println("  POST /api/v1/spaces/private                  - Create private space")
	fmt.Println("  POST /api/v1/spaces/community/invite         - Generate invite for user")
	fmt.Println("  POST /api/v1/spaces/community/join           - Join community with invite key")
	fmt.Println("  GET  /api/v1/spaces/community/verify-access  - Verify community access")
	fmt.Println("  GET  /api/v1/spaces/sync-status              - Check space sync readiness")
	fmt.Println()
	fmt.Println("  Invites:")
	fmt.Println("  POST /api/v1/invites/send-email       - Email invite code to user")
	fmt.Println()
	fmt.Println("  Notifications:")
	fmt.Println("  POST /api/v1/notifications/registration-submitted - Notify onboarding of new registration")
	fmt.Println("  POST /api/v1/notifications/registration-approved  - Notify applicant of approval")
	fmt.Println()
	fmt.Println("  Profiles & Types:")
	fmt.Println("  GET  /api/v1/types                    - List all type definitions")
	fmt.Println("  GET  /api/v1/types/{name}             - Get specific type definition")
	fmt.Println("  POST /api/v1/profiles                 - Create/update a profile object")
	fmt.Println("  GET  /api/v1/profiles/{type}          - List profiles of a type")
	fmt.Println("  GET  /api/v1/profiles/{type}/{id}     - Get specific profile")
	fmt.Println("  GET  /api/v1/profiles/me              - Get current user's profiles")
	fmt.Println("  POST /api/v1/profiles/init-member     - Initialize member profiles (admin)")
	fmt.Println()
	fmt.Println("  Files:")
	fmt.Println("  POST /api/v1/files/upload             - Upload file (avatar)")
	fmt.Println("  GET  /api/v1/files/{ref}              - Download file by ref")
	fmt.Println()
	fmt.Println("  Events:")
	fmt.Println("  GET  /api/v1/events                   - SSE event stream")
	fmt.Println()
	fmt.Println("  Org Config:")
	fmt.Println("  GET  /api/v1/org/config               - Get org configuration")
	fmt.Println("  POST /api/v1/org/config               - Save org configuration")
	fmt.Println("  GET  /api/v1/org/health               - Config service health")
	fmt.Println()

	// Start background sync worker
	syncWorkerConfig := bgSync.DefaultConfig()
	syncWorkerConfig.CommunitySpaceID = communitySpaceID
	syncWorker := bgSync.NewWorker(syncWorkerConfig, spaceManager, store, eventBroker)
	syncWorker.Start()
	defer syncWorker.Stop()

	// Wrap with CORS middleware
	handler := api.CORSMiddleware(mux)
	if err := http.ListenAndServe(addr, handler); err != nil {
		log.Fatalf("Server failed: %v", err)
	}
}
