# Decision Theatre Makefile
# ========================
#
# This Makefile is a convenience wrapper for use inside `nix develop`.
# All tools (go, node, gcc, etc.) come from the nix store.
#
# For reproducible builds and releases, use nix directly:
#   nix build             - Build the full application
#   nix build .#frontend  - Build only the frontend
#   nix flake check       - Run all tests
#   nix run               - Build and run
#
# Platform-specific release binaries are built in CI (see .github/workflows/release.yml).

BINARY_NAME := decision-theatre
VERSION ?= $(shell git describe --tags --always --dirty 2>/dev/null || echo "dev")
LDFLAGS := -ldflags "-s -w -X main.version=$(VERSION)"

BIN_DIR := bin
COVERAGE_FILE := coverage.out
FRONTEND_DIR := frontend
STATIC_DIR := internal/server/static
VENDOR_LLAMA := vendor/github.com/go-skynet/go-llama.cpp

GO := go
GOFMT := gofmt
GOLINT := golangci-lint

.PHONY: all build build-backend build-frontend build-llama clean
.PHONY: dev dev-frontend
.PHONY: test test-frontend test-all
.PHONY: fmt lint check deps
.PHONY: docs docs-serve
.PHONY: help info

all: test build

# ============================
# Build (dev iteration)
# ============================

# Full build: frontend then backend
build: build-frontend build-backend

# Backend only (assumes static/ already populated)
build-backend:
	@mkdir -p $(BIN_DIR)
	CGO_ENABLED=1 $(GO) build $(LDFLAGS) -o $(BIN_DIR)/$(BINARY_NAME) .

# Frontend via node (for dev iteration inside nix develop)
build-frontend:
	cd $(FRONTEND_DIR) && npm ci && npm run build
	@rm -rf $(STATIC_DIR)
	@mkdir -p $(STATIC_DIR)
	cp -r $(FRONTEND_DIR)/dist/* $(STATIC_DIR)/

# Build llama.cpp binding library (once after clone)
build-llama:
	@echo "Building llama.cpp binding library..."
	cd $(VENDOR_LLAMA) && make libbinding.a

# ============================
# Development
# ============================

dev: build-backend
	$(BIN_DIR)/$(BINARY_NAME) --port 8080 --data-dir ./data

dev-frontend:
	cd $(FRONTEND_DIR) && npx vite

# ============================
# Testing
# ============================

test:
	$(GO) test -v -race -coverprofile=$(COVERAGE_FILE) ./...

test-frontend:
	cd $(FRONTEND_DIR) && npx vitest run

test-all: test test-frontend

# ============================
# Code quality
# ============================

fmt:
	$(GOFMT) -s -w .
	$(GO) fmt ./...

lint:
	$(GOLINT) run --timeout 5m

check: fmt lint test

# ============================
# Dependencies
# ============================

deps:
	$(GO) mod download
	$(GO) mod tidy

clean:
	rm -rf $(BIN_DIR)
	rm -rf $(STATIC_DIR)
	rm -f $(COVERAGE_FILE)
	$(GO) clean

# ============================
# Documentation
# ============================

docs:
	cd requirements && mkdocs build

docs-serve:
	cd requirements && mkdocs serve

# ============================
# Info
# ============================

info:
	@echo "Binary:    $(BINARY_NAME)"
	@echo "Version:   $(VERSION)"
	@echo "Go:        $(shell $(GO) version 2>/dev/null || echo 'not in nix shell')"
	@echo "Node:      $(shell node --version 2>/dev/null || echo 'not in nix shell')"
	@echo ""
	@echo "Reproducible builds: use nix"
	@echo "  nix build             Full application"
	@echo "  nix build .#frontend  Frontend only"
	@echo "  nix flake check       Run all tests"
	@echo "  nix run               Build and run"

help:
	@echo "Decision Theatre - Makefile (dev iteration inside nix develop)"
	@echo ""
	@echo "Build:"
	@echo "  build           Frontend + backend (dev)"
	@echo "  build-backend   Backend only"
	@echo "  build-frontend  Frontend only"
	@echo "  build-llama     llama.cpp binding (once)"
	@echo "  clean           Remove artifacts"
	@echo ""
	@echo "Dev:"
	@echo "  dev             Run backend (port 8080)"
	@echo "  dev-frontend    Run Vite dev server"
	@echo ""
	@echo "Test:"
	@echo "  test            Go tests + coverage"
	@echo "  test-frontend   Frontend tests"
	@echo "  test-all        Both"
	@echo ""
	@echo "Quality:"
	@echo "  fmt / lint / check"
	@echo ""
	@echo "Docs:"
	@echo "  docs / docs-serve"
	@echo ""
	@echo "Reproducible builds (use nix, not make):"
	@echo "  nix build             Full application"
	@echo "  nix build .#frontend  Frontend only"
	@echo "  nix flake check       Run all tests"
	@echo "  nix run               Build and run"
