# Decision Theatre Makefile
# ========================
#
# This Makefile is a convenience wrapper for use inside `nix develop`.
# All tools (go, node, gcc, etc.) come from the nix store.
#
# Launching the app goes through scripts/run-app.sh, the single source of
# truth shared by `make run`, `nix run` and the neovim <leader>pr mapping.
#
# `make help` renders scripts/shell-help.sh — the same command table shown on
# entry to `nix develop` and re-rendered by `dt`.
#
# For reproducible builds and releases, use nix directly:
#   nix build             - Build the full application
#   nix build .#frontend  - Build only the frontend
#   nix flake check       - Run all tests
#   nix run               - Build and run
#
# Platform-specific release binaries are built in CI (see .github/workflows/release.yml).

BINARY_NAME := decision-theatre
VERSION ?= $(shell ./scripts/version.sh)
LDFLAGS := -ldflags "-s -w -X main.version=$(VERSION)"

BIN_DIR := bin
COVERAGE_FILE := coverage.out
FRONTEND_DIR := frontend
STATIC_DIR := internal/server/static
DOCS_SITE_DIR := internal/server/docs_site
GO := go
GOFMT := gofmt
GOLINT := golangci-lint

.PHONY: all app build build-backend build-frontend clean
.PHONY: run serve dev dev-backend dev-frontend dev-all
.PHONY: test test-frontend test-all test-scripts
.PHONY: fmt lint check deps
.PHONY: doctor doctor-deep sync-flake check-flake verify-flake hooks vendor-fonts
.PHONY: protect-branch
.PHONY: docs docs-serve
.PHONY: packages packages-linux packages-windows packages-darwin packages-flatpak packages-snap
.PHONY: check-data validate-data pack-data datapack walkthrough-manifest
.PHONY: geopackage list-datapack fetch-data
.PHONY: design-export design-import design-preview
.PHONY: release
.PHONY: help info

all: test build

# ============================
# Build (dev iteration)
# ============================

# Full app build: frontend, docs, and Go binary (everything needed to run)
# Works with system webkit2gtk-4.0 or webkit2gtk-4.1 (auto-creates compat shim)
app: build-frontend build-docs
	./scripts/build-app.sh
	@echo ""
	@echo "Build complete! Binary at: bin/decision-theatre"

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
# Run
# ============================

# Launch the standalone desktop app.
#
# scripts/run-app.sh is the single source of truth for how the app is
# launched: `nix run` and the neovim <leader>pr mapping call the very same
# script, so the three cannot drift apart. It rebuilds only what is stale.
#
# Pass flags through with ARGS, e.g.  make run ARGS="--port 9090"
run:
	./scripts/run-app.sh --desktop $(ARGS)

# Launch the same application as a web server, with no desktop window, for a
# browser to connect to. Same script, same build, only the mode differs.
serve:
	./scripts/run-app.sh --server $(ARGS)

# ============================
# Development
# ============================

# `dev` is an alias for `run` — there is deliberately no second launch path.
dev: run

# Go backend with air hot-reload on :8080 (port configured in .air.toml)
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

## test-scripts: Tests for the shell scripts. Currently version.sh, which had
## every build path reporting a release number that came from the newest tag
## rather than the declared one.
test-scripts:
	@./scripts/tests/version-test.sh

test-all: test test-frontend test-scripts

# ============================
# Code quality
# ============================

fmt:
	$(GOFMT) -s -w .
	$(GO) fmt ./...

lint:
	$(GOLINT) run --timeout 5m

## check-data: Check the data directory and print a summary of its contents
##
## The checks live in Go (internal/datacheck) and run through
## `decision-theatre check-data`, so they use the same loaders the application
## does. Exit 0 = no errors, 1 = errors, 2 = the directory is unreadable.
check-data:
	./scripts/check-data.sh $(if $(DATA_DIR),$(DATA_DIR),./data)

## walkthrough-manifest: rebuild data/walkthroughs/manifest.json from the
## walkthrough documents. The sites list reads the manifest rather than five
## megabytes of demo content; a test fails if the two fall out of step.
walkthrough-manifest:
	node ./scripts/build-walkthrough-manifest.mjs

## validate-data: deprecated name for check-data, kept so existing scripts,
## deployment gates and documentation keep working.
validate-data: check-data

check: fmt lint test

# ============================
# Health and flake lock step
# ============================

## doctor: Is this checkout healthy? Reports; never changes anything.
doctor:
	@./scripts/doctor.sh

## doctor-deep: The same, plus recomputing the real nix hashes (needs network).
doctor-deep:
	@./scripts/doctor.sh --deep

## check-flake: Fast, offline check that flake.nix is in step with go.mod,
## go.sum and frontend/package-lock.json. This is what the pre-commit hook and
## CI run — a stale hash here means anyone importing this flake fails to build.
check-flake:
	@./scripts/sync-flake.sh --check

## verify-flake: Authoritative check — recomputes the real hashes. Slow.
verify-flake:
	@./scripts/sync-flake.sh --verify

## sync-flake: Recompute both fixed-output hashes and write them into
## flake.nix, recording which manifests they belong to. Run this whenever
## go.mod, go.sum or frontend/package-lock.json changes, and commit flake.nix
## and nix/manifest-lock.json together.
sync-flake:
	@./scripts/sync-flake.sh

## hooks: Install the git hooks so the checks run before each commit.
hooks:
	@./scripts/install-hooks.sh

## protect-branch: Require the CI checks to pass before anything reaches main.
## The required list is derived from the workflows, so it cannot drift from what
## CI actually runs. ARGS="--show" to inspect, ARGS="--dry-run" to preview.
protect-branch:
	@./scripts/protect-branch.sh $(ARGS)

## vendor-fonts: Refresh the committed typefaces from nixpkgs. They are
## committed rather than fetched because the desktop app is offline by design.
## ARGS="--check" verifies the committed files are current.
vendor-fonts:
	@./scripts/vendor-fonts.sh $(ARGS)

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

# Download CSV source files from a Google Drive folder into data/
# Usage: make fetch-data FOLDER=<folder-id-or-url>
fetch-data:
	@if [ -z "$(FOLDER)" ]; then \
		echo "Usage: make fetch-data FOLDER=<google-drive-folder-id-or-url>"; \
		exit 1; \
	fi
	./scripts/fetch-data.sh "$(FOLDER)"

# Build datapack.gpkg from CSVs and catchment geometries
# Creates scenario tables, domain min/max tables, spatial indexes
geopackage:
	./scripts/build-geopackage.sh ./data

# Check the data directory, then package it into a distributable .zip.
# Refuses to build the pack if the check reports errors; pass ARGS="--force"
# to override.
pack-data:
	./scripts/pack-data.sh $(VERSION) $(ARGS)
	@APP_CID=$$(cd deployments && docker compose ps -q app 2>/dev/null); \
	if [ -n "$$APP_CID" ] && [ "$$(docker inspect -f '{{.State.Running}}' "$$APP_CID" 2>/dev/null)" = "true" ]; then \
		echo "==> Updating downloads config inside the running deployments-app container..."; \
		docker exec "$$APP_CID" /app/scripts/update-download-config.sh \
			--datapack "/app/dist/decision-theatre-data-v$(VERSION).zip"; \
	fi

# datapack: deprecated name for pack-data, kept so existing release scripts
# and documentation keep working.
datapack: pack-data

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
	@echo "  nix run               Build and run (via scripts/run-app.sh)"

## help: Show the command table.
##
## Rendered by scripts/shell-help.sh, the same script `nix develop` runs on
## entry and that `dt` re-renders — so the three can never
## list different commands. Filter by group: make help GROUP=data
help:
	@./scripts/shell-help.sh $(GROUP) || true
