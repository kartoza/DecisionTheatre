# Development Environment Setup

## Prerequisites

The only required tool is [Nix](https://nixos.org/download/) with flakes enabled. Nix provides all other dependencies (Go, Node.js, GCC, GDAL, tippecanoe, etc.) in a reproducible, isolated environment.

### Install Nix

```bash
# Official installer
sh <(curl -L https://nixos.org/nix/install) --daemon

# Enable flakes (add to ~/.config/nix/nix.conf)
experimental-features = nix-command flakes
```

## Entering the Dev Shell

```bash
cd DecisionTheatre
nix develop
```

This drops you into a shell with all tools available:

- **Go 1.24** + gopls, golangci-lint, delve, gotests
- **Node.js 22** + npm
- **GCC, Clang, CMake** (for CGO / llama.cpp)
- **OpenBLAS** (linear algebra)
- **GDAL, tippecanoe, sqlite3** (data conversion)
- **MkDocs** with Material theme (documentation)
- **ripgrep, fd, bat, fzf, jq, yq** (CLI utilities)
- **git, gh** (version control)
- **trivy** (security scanning)
- **WebKit2GTK, GTK3** (Linux only, for the desktop window)

## Building

### Full application (Nix, reproducible)

```bash
nix build                 # Binary at ./result/bin/decision-theatre
nix build .#frontend      # Frontend only
nix run                   # Build and run
```

### Dev iteration (Make, inside nix develop)

```bash
make build                # Frontend + backend
make build-backend        # Backend only (assumes static/ exists)
make build-frontend       # Frontend only (npm ci + vite build)
make dev                  # Build backend and run on port 8080
make dev-frontend         # Run Vite dev server (HMR)
```

## Shell Aliases

The dev shell provides these aliases:

| Alias | Command |
|-------|---------|
| `gor` | `go run .` |
| `got` | `go test -v ./...` |
| `gob` | `make build-backend` |
| `gom` | `go mod tidy` |
| `gol` | `golangci-lint run` |
| `gs` | `git status` |
| `ga` | `git add` |
| `gc` | `git commit` |
| `gl` | `git log --oneline -10` |
| `gd` | `git diff` |

## Environment Variables

The dev shell sets:

| Variable | Value | Purpose |
|----------|-------|---------|
| `CGO_ENABLED` | `1` | Required for go-sqlite3, go-llama.cpp |
| `CGO_CFLAGS` | `-I<openblas>/include` | OpenBLAS headers |
| `CGO_LDFLAGS` | `-L<openblas>/lib -lopenblas` | OpenBLAS linking |
| `GOPATH` | `$PWD/.go` | Keep Go cache in-project |
| `GOCACHE` | `$PWD/.go/cache` | Go build cache |

## Without Nix

If you cannot use Nix, install manually:

- Go 1.24+
- Node.js 22+
- GCC with CGO support
- OpenBLAS development headers
- WebKit2GTK 4.1 development headers (Linux)
- pkg-config

Then:

```bash
cd frontend && npm ci && npm run build
cd ..
mkdir -p internal/server/static
cp -r frontend/dist/* internal/server/static/
CGO_ENABLED=1 go build -o bin/decision-theatre .
```
