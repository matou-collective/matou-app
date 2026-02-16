# Matou Backend Makefile

.DEFAULT_GOAL := help

# =============================================================================
# Build
# =============================================================================

build:
	go build -o bin/server ./cmd/server

# Cross-platform builds for Electron packaging
# CGO_ENABLED=0 ensures static binaries that work on any Linux (no glibc dependency)
build-darwin-arm64:
	CGO_ENABLED=0 GOOS=darwin GOARCH=arm64 go build -o bin/darwin-arm64/matou-backend ./cmd/server

build-darwin-amd64:
	CGO_ENABLED=0 GOOS=darwin GOARCH=amd64 go build -o bin/darwin-amd64/matou-backend ./cmd/server

build-linux-amd64:
	CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -o bin/linux-amd64/matou-backend ./cmd/server

build-windows-amd64:
	CGO_ENABLED=0 GOOS=windows GOARCH=amd64 go build -o bin/windows-amd64/matou-backend.exe ./cmd/server

build-all: build-darwin-arm64 build-darwin-amd64 build-linux-amd64 build-windows-amd64

run: build
	./bin/server

# Run server in test mode (isolated data, test any-sync network)
# SMTP port 3525 matches the test postfix container
run-test:
	MATOU_ENV=test MATOU_SMTP_PORT=3525 go run ./cmd/server

# =============================================================================
# Testing
# =============================================================================

# Run unit tests (no external dependencies)
test:
	go test ./... -v -count=1

# Run unit tests with coverage
test-coverage:
	go test ./... -coverprofile=coverage.out
	go tool cover -html=coverage.out -o coverage.html
	@echo "Coverage report: coverage.html"

# Run integration tests (requires any-sync test network)
# The network starts automatically and stops after tests
test-integration:
	@echo "Running integration tests..."
	@echo "Note: Test network will start automatically"
	MATOU_ANYSYNC_INFRA_DIR=$(ANYSYNC_INFRA_DIR) go test -tags=integration -v ./internal/anysync/...

# Run integration tests, keep network running after
test-integration-keep:
	MATOU_ANYSYNC_INFRA_DIR=$(ANYSYNC_INFRA_DIR) KEEP_TEST_NETWORK=1 go test -tags=integration -v ./internal/anysync/...

# Run all tests (unit + integration)
test-all: test test-integration

# =============================================================================
# Test Network Management
# =============================================================================

ANYSYNC_INFRA_DIR ?= $(abspath ../../matou-infrastructure/any-sync)

# Start the test network manually
testnet-up:
	cd $(ANYSYNC_INFRA_DIR) && make up-test

# Stop the test network
testnet-down:
	cd $(ANYSYNC_INFRA_DIR) && make down-test

# Clean test network (remove all data)
testnet-clean:
	cd $(ANYSYNC_INFRA_DIR) && make clean-test

# Check test network status
testnet-status:
	cd $(ANYSYNC_INFRA_DIR) && make status-test

# Check test network health
testnet-health:
	cd $(ANYSYNC_INFRA_DIR) && make health-test

# =============================================================================
# Code Quality
# =============================================================================

lint:
	golangci-lint run ./...

fmt:
	go fmt ./...

vet:
	go vet ./...

# =============================================================================
# Cleanup
# =============================================================================

clean:
	rm -rf bin/ coverage.out coverage.html
	go clean -testcache

# Remove all dev session data (identity, org config, space keys, any-sync trees, SQLite)
clean-data:
	rm -rf data/ data[0-9]*/

# Remove test mode data
clean-data-test:
	rm -rf data-test/

# Full reset: build artifacts + all data (dev + test)
clean-all: clean clean-data clean-data-test

# =============================================================================
# Help
# =============================================================================

help:
	@echo "Matou Backend"
	@echo ""
	@echo "Build:"
	@echo "  make build              - Build the server binary"
	@echo "  make build-all          - Cross-compile for all platforms (Electron packaging)"
	@echo "  make run                - Build and run the server"
	@echo "  make run-test           - Run server in test mode (isolated data)"
	@echo ""
	@echo "Testing:"
	@echo "  make test               - Run unit tests"
	@echo "  make test-coverage      - Run tests with coverage report"
	@echo "  make test-integration   - Run integration tests (auto-starts network)"
	@echo "  make test-integration-keep - Run integration tests, keep network running"
	@echo "  make test-all           - Run all tests"
	@echo ""
	@echo "Test Network:"
	@echo "  make testnet-up         - Start test network manually"
	@echo "  make testnet-down       - Stop test network"
	@echo "  make testnet-clean      - Clean test network data"
	@echo "  make testnet-status     - Show test network status"
	@echo "  make testnet-health     - Check test network health"
	@echo ""
	@echo "Code Quality:"
	@echo "  make lint               - Run linter"
	@echo "  make fmt                - Format code"
	@echo "  make vet                - Run go vet"
	@echo ""
	@echo "Cleanup:"
	@echo "  make clean              - Remove build artifacts"
	@echo "  make clean-data         - Remove all dev session data (identity, keys, db, spaces)"
	@echo "  make clean-data-test    - Remove test mode data"
	@echo "  make clean-all          - Remove build artifacts + all data (dev + test)"

.PHONY: build build-darwin-arm64 build-darwin-amd64 build-linux-amd64 build-windows-amd64 build-all \
        run run-test test test-coverage test-integration test-integration-keep test-all \
        testnet-up testnet-down testnet-clean testnet-status testnet-health \
        lint fmt vet clean clean-data clean-data-test clean-all help
