# Production Server Deployment

This guide covers deploying Decision Theatre on a production server using the Docker Compose stack in the `deployments/` directory. The stack runs two containers: the application itself (Go binary serving the React frontend) and an Nginx reverse proxy that terminates TLS and forwards requests to the app.

---

## Architecture Overview

```
Browser  ──HTTPS──▶  Nginx :443  ──HTTP──▶  app :8080
                     Nginx :80   ──301──▶  HTTPS
```

- **app** — the Decision Theatre binary, built from source inside the container. Runs in `--headless` mode (no GUI window). Serves the web UI, REST API, and tile endpoints on port 8080. Ports 8081–8083 are internal tile-server ports also exposed inside the Docker network.
- **nginx** — Nginx 1.27 acting as a TLS-terminating reverse proxy. Rewrites internal `http://localhost:808x/` URLs in tile/style JSON responses to the public HTTPS host so that map tiles resolve correctly in the browser. Redirects plain HTTP to HTTPS.

---

## Prerequisites

- Docker Engine ≥ 24 and Docker Compose v2 (`docker compose` not `docker-compose`)
- A TLS certificate and private key for the server's hostname
- The `data/` and `resources/` directories populated with the application's data files (see [Data Setup](#data-setup))

---

## Directory Layout

```
deployments/
├── .env                   # Your local configuration (not committed)
├── .env.example           # Template — copy this to .env
├── Dockerfile             # Multi-stage build (Node → Go → Debian slim)
├── Dockerfile.dockerignore
├── docker-compose.yaml
├── nginx.conf             # Nginx virtual-host config
└── certs/
    ├── tls.crt            # TLS certificate (or chain)
    └── tls.key            # TLS private key
```

---

## Quick Start

```bash
cd deployments

# 1. Copy the example env file and fill in your values
cp .env.example .env
$EDITOR .env

# 2. Place your TLS certificate and key
cp /path/to/your/certificate.crt certs/tls.crt
cp /path/to/your/private.key     certs/tls.key

# 3. Build and start
docker compose up -d --build

# 4. Check logs
docker compose logs -f
```

The application is now accessible at `https://<your-server>/`.

---

## Environment Variables (`.env`)

All variables are consumed by `docker-compose.yaml`. Copy `.env.example` to `.env` and edit it before starting the stack.

### `HTTP_PORT` *(default: `80`)*

The host port that Nginx binds for plain HTTP traffic. All HTTP requests are immediately redirected to HTTPS (HTTP 301); this port exists solely to perform that redirect.

Change this if port 80 is already in use on the host or if your firewall/load balancer forwards a non-standard port.

```env
HTTP_PORT=80
```

---

### `HTTPS_PORT` *(default: `443`)*

The host port that Nginx binds for HTTPS traffic. This is the port users connect to.

```env
HTTPS_PORT=443
```

---

### `DT_DATA_DIR`

**Required.** Absolute (or relative-to-`deployments/`) path on the **host** to the directory mounted into the container at `/app/data`.

This directory must contain the application's runtime data:

| File | Description |
|------|-------------|
| `datapack.gpkg` | Main scenario GeoPackage — catchment geometries, scenario tables, precomputed GeoJSON, domain min/max for colour scaling |
| `mbtiles/africa.mbtiles` | Vector tile archive for the base map |
| `mbtiles/style.json` | MapLibre style for the base map tiles |
| `sites/` | Saved site JSON files (written at runtime) |
| `projects/` | Saved project JSON files (written at runtime) |
| `current.csv`, `reference.csv`, `metadata.csv` | Source CSV files (used during data preparation; not required at runtime unless `make geopackage` is re-run inside the container) |

The app writes `sites/` and `projects/` subdirectories at runtime, so the host path must be **writable** by the container user (UID 0 in the slim image).

```env
# Use an absolute path in production
DT_DATA_DIR=/srv/decision-theatre/data

# Or a path relative to the deployments/ directory (useful for testing)
DT_DATA_DIR=../data
```

---

### `DT_RESOURCES_DIR`

**Required.** Absolute (or relative) path on the host to the directory mounted into the container at `/app/resources` as **read-only**.

This directory contains shared geospatial resources that are not modified at runtime:

| File | Description |
|------|-------------|
| `mbtiles/style.json` | MapLibre style for resource-layer tiles |
| `mbtiles/uow_tiles.json` | Tile JSON descriptor for UoW catchment tiles |
| `mbtiles/*.gpkg` | Source GeoPackages used during tile generation (not needed at runtime) |

```env
DT_RESOURCES_DIR=/srv/decision-theatre/resources

# Or relative:
DT_RESOURCES_DIR=../resources
```

---

### `TLS_CERT_FILE` *(default: `./certs/tls.crt`)*

Path on the **host** to the TLS certificate file. This is mounted into Nginx at `/etc/nginx/certs/tls.crt`.

If your CA provides a certificate bundle (intermediate chain + leaf), use the full chain file here. Sectigo/Wits certificates typically require this.

```env
# Default (relative to deployments/)
TLS_CERT_FILE=./certs/tls.crt

# Absolute path to an externally managed certificate
TLS_CERT_FILE=/etc/ssl/certs/decision-theatre-fullchain.pem
```

---

### `TLS_KEY_FILE` *(default: `./certs/tls.key`)*

Path on the **host** to the TLS private key file. This is mounted into Nginx at `/etc/nginx/certs/tls.key`.

Keep this file owner-readable only (`chmod 600`). It is mounted read-only into the Nginx container.

```env
TLS_KEY_FILE=./certs/tls.key

# Absolute path
TLS_KEY_FILE=/etc/ssl/private/decision-theatre.key
```

---

## Example `.env` for Production

```env
# Ports
HTTP_PORT=80
HTTPS_PORT=443

# Data directories on the host (use absolute paths in production)
DT_DATA_DIR=/srv/decision-theatre/data
DT_RESOURCES_DIR=/srv/decision-theatre/resources

# TLS — full chain required for Wits/Sectigo certificates
TLS_CERT_FILE=/etc/ssl/certs/decision-theatre-fullchain.pem
TLS_KEY_FILE=/etc/ssl/private/decision-theatre.key
```

---

## Data Setup

The application will start without data but the UI will show a setup guide prompting users to load a data pack. For a fully operational deployment, populate the data directory before starting:

### 1. Map Tiles

The base map requires an MBTiles file. Convert the source GeoPackage using the helper script:

```bash
cd resources/mbtiles
./gpkg_to_mbtiles.sh UoW_layers.gpkg
# Output: data/mbtiles/africa.mbtiles
```

### 2. Scenario Datapack

Build the scenario GeoPackage from catchment geometries and CSV data:

```bash
# Place these files in data/
#   catchments.gpkg   — catchment geometries
#   current.csv       — current scenario metrics
#   reference.csv     — reference scenario metrics
#   metadata.csv      — optional column descriptions

make geopackage
# Output: data/datapack.gpkg
```

See the [Data Preparation](data-preparation.md) guide for full details on input formats and the GeoPackage schema.

---

## TLS Certificates

### Using a CA-Issued Certificate (Wits/Sectigo)

If your institution uses Sectigo (as Wits does), you will receive a certificate bundle. Use the **full chain** file, not just the leaf certificate, to avoid browser trust errors:

```bash
# Combine leaf + intermediates into a chain file (if not already combined)
cat your_cert.crt intermediate.crt > certs/tls.crt
cp your_private.key certs/tls.key
chmod 600 certs/tls.key
```

Then set in `.env`:

```env
TLS_CERT_FILE=./certs/tls.crt
TLS_KEY_FILE=./certs/tls.key
```

### Using a Self-Signed Certificate (Testing Only)

For internal testing on a non-public server:

```bash
openssl req -x509 -newkey rsa:4096 -keyout certs/tls.key \
  -out certs/tls.crt -days 365 -nodes \
  -subj "/CN=decision-theatre.local"
chmod 600 certs/tls.key
```

!!! warning
    Self-signed certificates will trigger browser security warnings and should never be used in production.

---

## Building the Image

The `Dockerfile` uses a three-stage build:

1. **`frontend`** (Node 22) — installs npm dependencies and runs `npm run build` to produce the React/TypeScript bundle.
2. **`builder`** (Go 1.24) — downloads Go modules, copies the compiled frontend bundle, builds the MkDocs documentation site, then compiles the Go binary with `CGO_ENABLED=1` (required for SQLite/GeoPackage support via `go-sqlite3`).
3. **`runtime`** (Debian Bookworm slim) — copies only the compiled binary into a minimal image with the required GTK/WebKit2GTK shared libraries.

To build the image manually and pass a version label:

```bash
docker build \
  --build-arg VERSION=1.2.3 \
  -f deployments/Dockerfile \
  -t decision-theatre:1.2.3 \
  .
```

The `VERSION` build argument is baked into the binary and displayed in the UI and `--version` output.

---

## Application CLI Flags (Container `command`)

The `docker-compose.yaml` passes the following flags to the binary. These are fixed in the compose file and should not need to change:

| Flag | Value | Description |
|------|-------|-------------|
| `--headless` | *(present)* | Disables the GUI window. Required for server operation. |
| `--port` | `8080` | HTTP port the app listens on inside the container. |
| `--data-dir` | `/app/data` | Path to the data directory (bound from `DT_DATA_DIR`). |
| `--resources-dir` | `/app/resources` | Path to the resources directory (bound from `DT_RESOURCES_DIR`). |

---

## Nginx Configuration Notes

The `nginx.conf` in `deployments/` is mounted read-only into the Nginx container. Key behaviours:

- **HTTP → HTTPS redirect** — All HTTP requests on port 80 receive a `301` redirect.
- **TLS** — TLSv1.2 and TLSv1.3 only. Session cache of 10 MB, 1-day timeout.
- **Upload limit** — `client_max_body_size 2g` to accommodate large GeoPackage or shapefile uploads.
- **WebSocket support** — `Upgrade`/`Connection` headers are forwarded for any WebSocket connections.
- **Tile/style URL rewriting** — The Go backend generates tile and style JSON with `http://localhost:808x/` URLs (because it sees no TLS at the Go level). Nginx rewrites these back to `https://<host>/` using `sub_filter` so that the browser can fetch tiles over HTTPS. This rewriting applies only to `/data/style.json` and `/data/tiles.json`.
- **Proxy timeouts** — Read and send timeouts are 300 seconds to accommodate large data file uploads.

If you need to change the Nginx behaviour (e.g., add a `server_name`, customise headers, or enable rate limiting), edit `deployments/nginx.conf` directly and restart the nginx container:

```bash
docker compose restart nginx
```

---

## Common Operations

### Start / Stop

```bash
# Start (detached)
docker compose up -d

# Stop (containers remain, volumes intact)
docker compose down

# Stop and remove volumes (destructive — removes data if using named volumes)
docker compose down -v
```

### View Logs

```bash
# All services
docker compose logs -f

# App only
docker compose logs -f app

# Nginx only
docker compose logs -f nginx
```

### Rebuild After a Code Change

```bash
docker compose up -d --build
```

### Update the Image Without Downtime

```bash
docker compose pull            # if using a registry image
docker compose up -d --build   # or rebuild from source
```

### Inspect Running Containers

```bash
docker compose ps
docker compose exec app decision-theatre --version
```

---

## Persistent Data

The `app` container mounts two host paths as Docker bind mounts (not named volumes):

| Container path | Host path (from `.env`) | Mode |
|----------------|------------------------|------|
| `/app/data` | `DT_DATA_DIR` | Read-write |
| `/app/resources` | `DT_RESOURCES_DIR` | Read-only |

Because these are bind mounts, data persists on the host even if the container is removed. Back up `DT_DATA_DIR` (especially `sites/` and `projects/` subdirectories) as part of your regular server backup routine.

---

## Firewall

Open only the ports Nginx exposes on the host:

```bash
# Ubuntu / ufw
ufw allow 80/tcp
ufw allow 443/tcp

# Or with iptables
iptables -A INPUT -p tcp --dport 80 -j ACCEPT
iptables -A INPUT -p tcp --dport 443 -j ACCEPT
```

The app container ports (8080–8083) are not published to the host (`expose` ≠ `ports` in compose); they are only reachable within the Docker network by Nginx.

---

## Troubleshooting

### Nginx returns 502 Bad Gateway

The app container may not have finished starting. Check:

```bash
docker compose logs app
```

The app performs a port scan at startup (it may try ports 8080–8089 if some are taken) and logs the port it ultimately binds to. Nginx is hardcoded to `app:8080`; if the app binds a different port, update `nginx.conf` and the compose `command`.

### Tile URLs are `http://` in the browser

If `X-Forwarded-Proto` is not being set correctly, the Go backend falls back to HTTP in its URL generation. Verify the `proxy_set_header X-Forwarded-Proto https;` line is present in `nginx.conf` and that you restarted Nginx after any config change.

### TLS certificate errors (`ERR_CERT_INCOMPLETE` or chain issues)

Use a full chain certificate file. Combine the leaf certificate with any intermediate CA certificates in the correct order (leaf first):

```bash
cat leaf.crt intermediate.crt root.crt > certs/tls.crt
```

### Container fails to write to `/app/data`

The runtime container runs as root. If the host directory is owned by a different user with restrictive permissions, either adjust permissions or change the ownership:

```bash
sudo chown -R root:root /srv/decision-theatre/data
# or make it world-writable (less secure)
chmod -R 777 /srv/decision-theatre/data
```
