package main

import (
	"fmt"
	"log"
	"net/http"
	"os"

	"github.com/matou-dao/backend/internal/anysync"
	"github.com/matou-dao/backend/internal/anystore"
	"github.com/matou-dao/backend/internal/api"
	"github.com/matou-dao/backend/internal/config"
	"github.com/matou-dao/backend/internal/email"
	"github.com/matou-dao/backend/internal/keri"
)

func main() {
	// Detect environment: "test" uses isolated data, configs, and ports
	env := os.Getenv("MATOU_ENV")
	isTest := env == "test"

	if isTest {
		fmt.Println("MATOU DAO Backend Server (TEST)")
	} else {
		fmt.Println("MATOU DAO Backend Server")
	}
	fmt.Println("============================")
	fmt.Println()

	// Load configuration — test uses a separate bootstrap file
	fmt.Println("Loading configuration...")
	bootstrapPath := "config/bootstrap.yaml"
	if isTest {
		bootstrapPath = "config/bootstrap-test.yaml"
	}
	cfg, err := config.Load("", bootstrapPath)
	if err != nil {
		log.Fatalf("Failed to load config: %v", err)
	}

	// Test mode uses port 9080 to avoid conflicting with dev server on 8080
	if isTest {
		cfg.Server.Port = 9080
	}

	fmt.Printf("  Configuration loaded\n")
	fmt.Printf("   Organization: %s\n", cfg.Bootstrap.Organization.Name)
	fmt.Printf("   Org AID: %s\n", cfg.GetOrgAID())
	fmt.Printf("   Admin AID: %s\n", cfg.GetAdminAID())
	fmt.Println()

	// Initialize data directory — test uses ./data-test
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

	// Initialize any-sync client
	fmt.Println("Initializing any-sync client...")

	// Select config file based on environment
	anysyncConfigPath := os.Getenv("MATOU_ANYSYNC_CONFIG")
	if anysyncConfigPath == "" {
		if isTest {
			// Test network uses ports 2001-2006
			anysyncConfigPath = "../infrastructure/any-sync/client-host-test.yml"
		} else {
			anysyncConfigPath = "config/client-host.yml"
		}
	}

	// Check if full SDK mode is enabled
	// MATOU_ANYSYNC_MODE=sdk enables full network connectivity
	// Default is "local" mode which stores data locally without network sync
	anysyncMode := os.Getenv("MATOU_ANYSYNC_MODE")

	var anysyncClient anysync.AnySyncClient
	if anysyncMode == "sdk" {
		fmt.Println("  Mode: Full SDK (network sync enabled)")
		sdkClient, err := anysync.NewSDKClient(anysyncConfigPath, &anysync.ClientOptions{
			DataDir:     dataDir,
			PeerKeyPath: dataDir + "/peer.key",
		})
		if err != nil {
			log.Fatalf("Failed to create any-sync SDK client: %v", err)
		}
		anysyncClient = sdkClient
		defer sdkClient.Close()
	} else {
		fmt.Println("  Mode: Local (network sync disabled)")
		localClient, err := anysync.NewClient(anysyncConfigPath, &anysync.ClientOptions{
			DataDir:     dataDir,
			PeerKeyPath: dataDir + "/peer.key",
		})
		if err != nil {
			log.Fatalf("Failed to create any-sync client: %v", err)
		}
		anysyncClient = localClient
		defer localClient.Close()
	}

	fmt.Printf("  any-sync client initialized\n")
	fmt.Printf("   Network ID: %s\n", anysyncClient.GetNetworkID())
	fmt.Printf("   Coordinator: %s\n", anysyncClient.GetCoordinatorURL())
	fmt.Printf("   Peer ID: %s\n", anysyncClient.GetPeerID())
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

	// Initialize space manager
	fmt.Println("Initializing space manager...")
	spaceManager := anysync.NewSpaceManager(anysyncClient, &anysync.SpaceManagerConfig{
		CommunitySpaceID: cfg.GetOrgSpaceID(),
		OrgAID:           cfg.GetOrgAID(),
	})
	spaceStore := anystore.NewSpaceStoreAdapter(store)

	fmt.Printf("  Space manager initialized\n")
	fmt.Printf("   Community Space ID: %s\n", cfg.GetOrgSpaceID())
	fmt.Println()

	// Verify community space (log warning if not configured)
	if cfg.GetOrgSpaceID() == "" {
		fmt.Println("  ⚠️  Warning: Community space ID not configured")
		fmt.Println("     Memberships will only be stored in private spaces")
	}

	// Initialize KERI client (config-only, no KERIA connection needed)
	fmt.Println("Initializing KERI client...")
	keriClient, err := keri.NewClient(&keri.Config{
		OrgAID:   cfg.GetOrgAID(),
		OrgAlias: cfg.Bootstrap.Organization.Alias,
		OrgName:  cfg.Bootstrap.Organization.Name,
	})
	if err != nil {
		log.Fatalf("Failed to create KERI client: %v", err)
	}

	fmt.Printf("  KERI client initialized\n")
	fmt.Printf("   Note: Credential issuance handled by frontend (signify-ts)\n")
	fmt.Println()

	// Create API handlers
	credHandler := api.NewCredentialsHandler(keriClient, store)
	syncHandler := api.NewSyncHandler(keriClient, store, spaceManager, spaceStore)
	trustHandler := api.NewTrustHandler(store, cfg.GetOrgAID())
	healthHandler := api.NewHealthHandler(store, spaceStore, cfg.GetOrgAID(), cfg.GetAdminAID())
	spacesHandler := api.NewSpacesHandler(spaceManager, store)
	emailSender := email.NewSender(cfg.SMTP)
	invitesHandler := api.NewInvitesHandler(emailSender)

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
				"alias": "%s"
			},
			"admin": {
				"aid": "%s",
				"alias": "%s"
			},
			"anysync": {
				"networkId": "%s",
				"coordinator": "%s"
			}
		}`,
			cfg.Bootstrap.Organization.Name,
			cfg.GetOrgAID(),
			cfg.Bootstrap.Organization.Alias,
			cfg.GetAdminAID(),
			cfg.Bootstrap.Admin.Alias,
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

	// Start server
	addr := fmt.Sprintf("%s:%d", cfg.Server.Host, cfg.Server.Port)
	fmt.Printf("Starting HTTP server on %s\n", addr)
	fmt.Println()
	fmt.Println("Endpoints:")
	fmt.Println("  GET  /health                       - Health check")
	fmt.Println("  GET  /info                         - System information")
	fmt.Println()
	fmt.Println("  Credentials:")
	fmt.Println("  GET  /api/v1/org                   - Organization info for frontend")
	fmt.Println("  GET  /api/v1/credentials           - List stored credentials")
	fmt.Println("  POST /api/v1/credentials           - Store credential from frontend")
	fmt.Println("  GET  /api/v1/credentials/{said}    - Get credential by SAID")
	fmt.Println("  POST /api/v1/credentials/validate  - Validate credential structure")
	fmt.Println("  GET  /api/v1/credentials/roles     - List available roles")
	fmt.Println()
	fmt.Println("  Sync (Week 3):")
	fmt.Println("  POST /api/v1/sync/credentials      - Sync credentials from KERIA")
	fmt.Println("  POST /api/v1/sync/kel              - Sync KEL from KERIA")
	fmt.Println("  GET  /api/v1/community/members     - List community members")
	fmt.Println("  GET  /api/v1/community/credentials - List community-visible credentials")
	fmt.Println()
	fmt.Println("  Trust Graph (Week 3):")
	fmt.Println("  GET  /api/v1/trust/graph           - Get trust graph (full or filtered)")
	fmt.Println("  GET  /api/v1/trust/score/{aid}     - Get trust score for an AID")
	fmt.Println("  GET  /api/v1/trust/scores          - Get top trust scores")
	fmt.Println("  GET  /api/v1/trust/summary         - Get trust graph summary")
	fmt.Println()
	fmt.Println("  Spaces (any-sync):")
	fmt.Println("  POST /api/v1/spaces/community         - Create community space")
	fmt.Println("  GET  /api/v1/spaces/community         - Get community space info")
	fmt.Println("  POST /api/v1/spaces/private           - Create private space")
	fmt.Println("  POST /api/v1/spaces/community/invite  - Invite user to community")
	fmt.Println()
	fmt.Println("  Invites:")
	fmt.Println("  POST /api/v1/invites/send-email       - Email invite code to user")
	fmt.Println()

	// Wrap with CORS middleware
	handler := api.CORSMiddleware(mux)
	if err := http.ListenAndServe(addr, handler); err != nil {
		log.Fatalf("Server failed: %v", err)
	}
}
