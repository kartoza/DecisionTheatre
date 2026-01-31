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
DOCS_SITE_DIR := internal/server/docs_site
GO := go
GOFMT := gofmt
GOLINT := golangci-lint

.PHONY: all build build-backend build-frontend clean
.PHONY: dev dev-backend dev-frontend dev-all
.PHONY: test test-frontend test-all
.PHONY: fmt lint check deps
.PHONY: docs docs-serve
.PHONY: packages packages-linux packages-windows packages-darwin
.PHONY: csv2parquet datapack list-datapack
.PHONY: help info

all: test build

# ============================
# Build (dev iteration)
# ============================

# Full build: frontend, docs, then backend
build: build-frontend build-docs build-backend

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

# Build MkDocs site into embed dir
build-docs:
	mkdocs build -d $(DOCS_SITE_DIR)

# ============================
# Development
# ============================

dev: build-backend
	$(BIN_DIR)/$(BINARY_NAME) --port 8080 --data-dir ./data

# Go backend with air hot-reload (watches .go files, auto-rebuilds)
dev-backend:
	air

# Vite dev server with HMR (proxies /api, /tiles, /data, /docs to :8080)
dev-frontend:
	cd $(FRONTEND_DIR) && npx vite

# Full dev stack: air (Go hot-reload on :8080) + Vite HMR (on :5173)
# Open http://localhost:5173 in your browser
dev-all:
	@echo "Starting Go backend (air) on :8080 and Vite on :5173"
	@echo "Open http://localhost:5173 for live development"
	@echo ""
	@trap 'kill 0' EXIT; \
	air & \
	sleep 2 && cd $(FRONTEND_DIR) && npx vite

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
	rm -rf $(DOCS_SITE_DIR)
	rm -f $(COVERAGE_FILE)
	$(GO) clean

# ============================
# Documentation
# ============================

docs:
	mkdocs build

docs-serve:
	mkdocs serve

# ============================
# Packaging
# ============================

# Build release packages for all platforms (linux + windows cross-compile)
packages: build-frontend build-docs
	./scripts/build-packages.sh --platform all --version $(VERSION)

# Platform-specific package targets
packages-linux: build-frontend build-docs
	./scripts/build-packages.sh --platform linux --version $(VERSION)

packages-windows: build-frontend build-docs
	./scripts/build-packages.sh --platform windows --version $(VERSION)

packages-darwin: build-frontend build-docs
	./scripts/build-packages.sh --platform darwin --version $(VERSION)

# ============================
# Data conversion & packing
# ============================

# Convert CSV data files to Parquet (requires pyarrow from nix develop)
csv2parquet:
	python3 scripts/csv2parquet.py --data-dir ./data

# Build data pack: converts CSVs to Parquet, bundles with mbtiles into a zip
datapack:
	./scripts/build-datapack.sh $(VERSION)

# List contents of the most recently built data pack
list-datapack:
	@PACK=$$(ls -t dist/decision-theatre-data-v*.zip 2>/dev/null | head -1); \
	if [ -z "$$PACK" ]; then \
		echo "No data pack found in dist/. Run 'make datapack' first."; \
		exit 1; \
	fi; \
	echo "Data pack: $$PACK"; \
	echo "Size: $$(du -h "$$PACK" | cut -f1)"; \
	echo "SHA256: $$(cat "$${PACK}.sha256" 2>/dev/null || sha256sum "$$PACK" | cut -d' ' -f1)"; \
	echo ""; \
	echo "Manifest:"; \
	unzip -p "$$PACK" "*/manifest.json" | jq .; \
	echo ""; \
	echo "Contents:"; \
	unzip -l "$$PACK"

docs-requirements:
	cd requirements && mkdocs build

docs-requirements-serve:
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
	@echo "  clean           Remove artifacts"
	@echo ""
	@echo "Dev:"
	@echo "  dev-all         Go hot-reload + Vite HMR (recommended)"
	@echo "  dev-backend     Go backend with air (hot-reload)"
	@echo "  dev-frontend    Vite dev server (HMR)"
	@echo "  dev             Run backend once (no hot-reload)"
	@echo ""
	@echo "Test:"
	@echo "  test            Go tests + coverage"
	@echo "  test-frontend   Frontend tests"
	@echo "  test-all        Both"
	@echo ""
	@echo "Quality:"
	@echo "  fmt / lint / check"
	@echo ""
	@echo "Packaging:"
	@echo "  packages          All platforms (linux + windows cross-compile)"
	@echo "  packages-linux    Linux .tar.gz, .deb, .rpm"
	@echo "  packages-windows  Windows .zip (needs mingw-w64)"
	@echo "  packages-darwin   macOS .tar.gz / .dmg (macOS only)"
	@echo "  csv2parquet        Convert CSV data files to Parquet"
	@echo "  datapack          Data pack .zip (parquet + mbtiles)"
	@echo "  list-datapack     List contents of last built data pack"
	@echo ""
	@echo "Docs:"
	@echo "  docs / docs-serve"
	@echo ""
	@echo "Reproducible builds (use nix, not make):"
	@echo "  nix build             Full application"
	@echo "  nix build .#frontend  Frontend only"
	@echo "  nix flake check       Run all tests"
	@echo "  nix run               Build and run"
