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
.PHONY: packages packages-linux packages-windows packages-darwin packages-flatpak packages-snap
.PHONY: csv2parquet geopackage datapack list-datapack
.PHONY: design-export design-import design-preview
.PHONY: release
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

packages-flatpak: build-frontend build-docs
	./scripts/build-packages.sh --platform flatpak --version $(VERSION)

packages-snap: build-frontend build-docs
	./scripts/build-packages.sh --platform snap --version $(VERSION)

# Full release: create git tag and build all packages
release: build-frontend build-docs
	@echo "Building release v$(VERSION)..."
	./scripts/build-packages.sh --platform all --version $(VERSION)
	@echo ""
	@echo "Release artifacts in dist/:"
	@ls -lh dist/ 2>/dev/null || echo "  (none)"
	@echo ""
	@echo "To create a GitHub release:"
	@echo "  git tag -a v$(VERSION) -m 'Release v$(VERSION)'"
	@echo "  git push origin v$(VERSION)"
	@echo "  gh release create v$(VERSION) dist/* --title 'v$(VERSION)' --notes 'Release v$(VERSION)'"

# ============================
# Data conversion & packing
# ============================

# Convert CSV data files to Parquet (requires pyarrow from nix develop)
csv2parquet:
	python3 scripts/csv2parquet.py --data-dir ./data

# Build datapack.gpkg from CSVs and catchment geometries
# Creates scenario tables, domain min/max tables, spatial indexes
geopackage:
	./scripts/build-geopackage.sh ./data

# Package data files into distributable .zip (parquet + mbtiles)
datapack:
	./scripts/package-data.sh $(VERSION)

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
# Design System
# ============================

# Export current theme to design tokens JSON for Figma
design-export:
	@echo "Exporting design tokens for Figma..."
	@echo "Files for your designer:"
	@echo "  - design-tokens.json  (import into Figma Tokens Studio)"
	@echo "  - design-system.html  (visual reference)"
	@echo ""
	@if [ -f design-tokens.json ]; then \
		echo "design-tokens.json exists ($(shell stat -c%s design-tokens.json 2>/dev/null || stat -f%z design-tokens.json) bytes)"; \
	else \
		echo "Run the app first to generate design-tokens.json"; \
	fi

# Import design tokens from Figma and regenerate theme
# Usage: make design-import [TOKENS=path/to/tokens.json]
TOKENS ?= design-tokens.json
design-import:
	@echo "Importing design tokens from $(TOKENS)..."
	python3 scripts/import-design-tokens.py --input $(TOKENS)
	@echo ""
	@echo "Theme updated! Run 'make build-frontend' to apply."

# Preview design tokens without modifying files
design-preview:
	@echo "Preview of design token import (dry run)..."
	python3 scripts/import-design-tokens.py --input $(TOKENS) --dry-run

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
	@echo "  packages-flatpak  Flatpak .flatpak (needs flatpak-builder)"
	@echo "  packages-snap     Snap .snap (needs snapcraft)"
	@echo "  release           Build all packages and show release instructions"
	@echo ""
	@echo "Data Preparation:"
	@echo "  geopackage        Build datapack.gpkg from CSVs + catchments"
	@echo "  csv2parquet       Convert CSV data files to Parquet"
	@echo "  datapack          Package data into distributable .zip"
	@echo "  list-datapack     List contents of last built data pack"
	@echo ""
	@echo "Design System:"
	@echo "  design-export     Show files to send to designer (Figma)"
	@echo "  design-import     Import updated tokens from Figma"
	@echo "  design-preview    Preview import without changes (dry run)"
	@echo "                    Use TOKENS=path/to/file.json to specify input"
	@echo ""
	@echo "Docs:"
	@echo "  docs / docs-serve"
	@echo ""
	@echo "Reproducible builds (use nix, not make):"
	@echo "  nix build             Full application"
	@echo "  nix build .#frontend  Frontend only"
	@echo "  nix flake check       Run all tests"
	@echo "  nix run               Build and run"
