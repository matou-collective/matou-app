# Matou Backend Makefile

.DEFAULT_GOAL := help

# =============================================================================
# Build
# =============================================================================

build:
	go build -o bin/server ./cmd/server

run: build
	./bin/server

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
	go test -tags=integration -v ./internal/anysync/...

# Run integration tests, keep network running after
test-integration-keep:
	KEEP_TEST_NETWORK=1 go test -tags=integration -v ./internal/anysync/...

# Run all tests (unit + integration)
test-all: test test-integration

# =============================================================================
# Test Network Management
# =============================================================================

# Start the test network manually
testnet-up:
	cd ../infrastructure/any-sync-test && make up

# Stop the test network
testnet-down:
	cd ../infrastructure/any-sync-test && make down

# Clean test network (remove all data)
testnet-clean:
	cd ../infrastructure/any-sync-test && make clean

# Check test network status
testnet-status:
	cd ../infrastructure/any-sync-test && make status

# Check test network health
testnet-health:
	cd ../infrastructure/any-sync-test && make health

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

# =============================================================================
# Help
# =============================================================================

help:
	@echo "Matou Backend"
	@echo ""
	@echo "Build:"
	@echo "  make build              - Build the server binary"
	@echo "  make run                - Build and run the server"
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

.PHONY: build run test test-coverage test-integration test-integration-keep test-all \
        testnet-up testnet-down testnet-clean testnet-status testnet-health \
        lint fmt vet clean help
