package main

import (
	"fmt"
	"log"
	"net/http"

	"github.com/matou-dao/backend/internal/anysync"
	"github.com/matou-dao/backend/internal/config"
)

func main() {
	fmt.Println("🚀 MATOU DAO Backend Server")
	fmt.Println("============================")
	fmt.Println()

	// Load configuration
	fmt.Println("Loading configuration...")
	cfg, err := config.Load("", "config/bootstrap.yaml")
	if err != nil {
		log.Fatalf("Failed to load config: %v", err)
	}

	fmt.Printf("✅ Configuration loaded\n")
	fmt.Printf("   Organization: %s\n", cfg.Bootstrap.Organization.Name)
	fmt.Printf("   Org AID: %s\n", cfg.GetOrgAID())
	fmt.Printf("   Admin AID: %s\n", cfg.GetAdminAID())
	fmt.Println()

	// Initialize any-sync client
	fmt.Println("Initializing any-sync client...")
	anysyncClient, err := anysync.NewClient("../infrastructure/any-sync/etc/client.yml")
	if err != nil {
		log.Fatalf("Failed to create any-sync client: %v", err)
	}

	fmt.Printf("✅ any-sync client initialized\n")
	fmt.Printf("   Network ID: %s\n", anysyncClient.GetNetworkID())
	fmt.Printf("   Coordinator: %s\n", anysyncClient.GetCoordinatorURL())
	fmt.Println()

	// Create HTTP server
	mux := http.NewServeMux()

	// Health check endpoint
	mux.HandleFunc("/health", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		fmt.Fprintf(w, `{"status":"healthy","organization":"%s","admin":"%s"}`,
			cfg.GetOrgAID(), cfg.GetAdminAID())
	})

	// Info endpoint
	mux.HandleFunc("/info", func(w http.ResponseWriter, r *http.Request) {
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
	})

	// Start server
	addr := fmt.Sprintf("%s:%d", cfg.Server.Host, cfg.Server.Port)
	fmt.Printf("🌐 Starting HTTP server on %s\n", addr)
	fmt.Println()
	fmt.Println("Endpoints:")
	fmt.Println("  GET  /health - Health check")
	fmt.Println("  GET  /info   - System information")
	fmt.Println()

	if err := http.ListenAndServe(addr, mux); err != nil {
		log.Fatalf("Server failed: %v", err)
	}
}
