# Development Environment Setup

## Prerequisites

The only required tool is [Nix](https://nixos.org/download/) with flakes enabled. Nix provides all other dependencies (Go, Node.js, GCC, GDAL, tippecanoe, air, etc.) in a reproducible, isolated environment.

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
- **air** (Go hot-reload)
- **GCC** (for CGO)
- **GDAL, tippecanoe, sqlite3** (data conversion)
- **MkDocs** with Material theme (documentation)
- **ripgrep, fd, bat, fzf, jq, yq** (CLI utilities)
- **git, gh** (version control)
- **trivy** (security scanning)
- **WebKit2GTK, GTK3** (Linux only, for the desktop window)

## Live Development Workflow

The recommended workflow provides hot-reload for both the Go backend and the React frontend. Edit files in neovim (or any editor), save, and see changes reflected immediately in the browser.

### Quick start

```bash
nix develop
make dev-all
```

Then open **http://localhost:5173** in your browser.

### How it works

`make dev-all` starts two processes in parallel:

| Process | Port | Tool | Watches | Reload speed |
|---------|------|------|---------|-------------|
| Go backend | 8080 | [air](https://github.com/air-verse/air) | `*.go`, `*.json` in `internal/`, `main.go` | ~1-2 seconds |
| Vite dev server | 5173 | [Vite](https://vite.dev/) | `*.tsx`, `*.ts`, `*.css` in `frontend/src/` | Instant (HMR) |

The Vite dev server proxies API requests to the Go backend:

```
Browser (localhost:5173)
  ├── /api/*     → proxy → Go backend (localhost:8080)
  ├── /tiles/*   → proxy → Go backend (localhost:8080)
  ├── /data/*    → proxy → Go backend (localhost:8080)
  ├── /docs/*    → proxy → Go backend (localhost:8080)
  └── /*         → Vite HMR (instant React updates)
```

### Running processes separately

You can run the backend and frontend in separate terminals for better log visibility:

```bash
# Terminal 1: Go backend with hot-reload
make dev-backend

# Terminal 2: Vite frontend with HMR
make dev-frontend
```

### air configuration

The Go hot-reloader is configured in `.air.toml` at the project root. Key settings:

- Watches: `*.go`, `*.html`, `*.json` files
- Excludes: `frontend/`, `node_modules/`, `.go/`, `data/`, `resources/`, `vendor/`
- Runs the backend in headless mode (`--headless`) so it doesn't open a desktop window
- Kill delay: 1 second (waits for graceful shutdown before restarting)

### Vite proxy configuration

The proxy rules are defined in `frontend/vite.config.ts`:

```typescript
server: {
  proxy: {
    '/api': 'http://localhost:8080',
    '/tiles': 'http://localhost:8080',
    '/data': 'http://localhost:8080',
    '/docs': 'http://localhost:8080',
  },
},
```

## Building

### Full application (Nix, reproducible)

```bash
nix build                 # Binary at ./result/bin/decision-theatre
nix build .#frontend      # Frontend only
nix run                   # Build and run
```

### Dev iteration (Make, inside nix develop)

```bash
make build                # Frontend + docs + backend
make build-backend        # Backend only (assumes static/ exists)
make build-frontend       # Frontend only (npm ci + vite build)
make build-docs           # MkDocs into embed dir
```

### One-shot run (no hot-reload)

```bash
make dev                  # Build backend and run on port 8080
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
| `CGO_ENABLED` | `1` | Required for go-sqlite3 |
| `GOPATH` | `$PWD/.go` | Keep Go cache in-project |
| `GOCACHE` | `$PWD/.go/cache` | Go build cache |
| `EDITOR` | `nvim` | Default editor |

### Frontend (`frontend/.env`)

The frontend reads its own environment variables via Vite, separate from the dev shell. Copy the template and fill in values as needed:

```bash
cd frontend
cp .env.example .env
```

| Variable | Purpose |
|----------|---------|
| `VITE_FEEDBACK_FORM_URL` | URL of the Google Form used to collect user feedback, linked from the footer. Leave blank (or omit) to hide the feedback link. |

Restart `npx vite` (or `air`/the dev shell's frontend process) after changing `frontend/.env` — Vite only reads it at startup.

## Without Nix

If you cannot use Nix, install manually:

- Go 1.24+
- Node.js 22+
- GCC with CGO support
- WebKit2GTK 4.1 development headers (Linux)
- pkg-config
- [air](https://github.com/air-verse/air) (`go install github.com/air-verse/air@latest`)

Then:

```bash
cd frontend && npm ci && npm run build
cd ..
mkdir -p internal/server/static
cp -r frontend/dist/* internal/server/static/
CGO_ENABLED=1 go build -o bin/decision-theatre .
```

For live development without Nix:

```bash
# Terminal 1
air

# Terminal 2
cd frontend && npx vite
```

## Design System Workflow

The project includes tools for collaborating with designers using Figma. Design tokens (colors, typography, spacing) can be exported and imported to keep the codebase synchronized with design specifications.

### Files for Designers

| File | Purpose |
|------|---------|
| `design-tokens.json` | Design tokens in standard JSON format for Figma Tokens Studio plugin |
| `design-system.html` | Visual reference document showing all colors, typography, and components |

### Sending Design Specifications to a Designer

```bash
make design-export
```

This shows the files to share with your designer:

1. **design-tokens.json** - Import into Figma using [Tokens Studio](https://tokens.studio/) plugin
2. **design-system.html** - Open in browser for visual reference

### Importing Updated Tokens from Figma

When the designer exports updated tokens from Figma:

```bash
# Preview changes without modifying files (dry run)
make design-preview TOKENS=~/Downloads/updated-tokens.json

# Apply the changes to theme.ts
make design-import TOKENS=~/Downloads/updated-tokens.json

# Rebuild frontend with new theme
make build-frontend
```

### Design Token Structure

The design tokens include:

| Category | Description |
|----------|-------------|
| **Brand colors** | Primary cyan-blue palette (50-900 shades) |
| **Accent colors** | Secondary orange palette (50-900 shades) |
| **Scenario colors** | Reference (orange), Current (blue), Future (green) |
| **Site creation colors** | Neon palette for boundary drawing UI |
| **PRISM color scale** | 8-color choropleth spectrum for data visualization |
| **Typography** | Inter font family with size/weight scales |
| **Spacing** | 4px base unit spacing scale |
| **Shadows** | Standard shadows and glow effects |
| **Border radius** | Rounded corner scale |

### Theme File Location

The Chakra UI theme is defined in:

```
frontend/src/styles/theme.ts
```

The import script also generates CSS custom properties in:

```
frontend/src/styles/design-tokens.css
```

### Make Commands

| Command | Description |
|---------|-------------|
| `make design-export` | Show files to send to designer |
| `make design-import` | Import tokens and regenerate theme.ts |
| `make design-preview` | Dry run - preview changes without writing |
| `make design-import TOKENS=path/to/file.json` | Import from specific file |
