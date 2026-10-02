#!/usr/bin/env bash
set -euo pipefail

# ============================================================
# mbtiles testbed — browse context.mbtiles rendered with the real style
# ============================================================
#
# Runs mbtileserver against data/mbtiles/context.mbtiles (the merged,
# finished tileset) and serves a MapLibre GL preview page styled with
# datasources/mbtiles-config/style.json, all behind one HTTP origin (see
# scripts/mbtiles_proxy.py for why).
#
# Pass --layer NAME to instead browse a single layer's MBTiles from
# .cache/mbtiles-layers/ -- these are written one at a time by
# scripts/gpkg_to_mbtiles.sh as each layer finishes tiling, so
# you can inspect a layer while the rest of the build is still running.
#
# USAGE
# -----
# ./scripts/mbtiles-server.sh [--port N] [--yes]
# ./scripts/mbtiles-server.sh --layer catchments_lev12 [--port N]
#
# --port N     Public port to serve the preview on (default: 7900)
# --yes        Don't prompt — build the tiles automatically if missing
#              (ignored with --layer; see below)
# --layer NAME Browse .cache/mbtiles-layers/NAME.mbtiles instead of
#              the merged context.mbtiles
# --style PATH Style to render with (default: datasources/mbtiles-config/style.json)
#
# Without --layer, if data/mbtiles/context.mbtiles doesn't exist yet,
# this prompts to run the full mbtiles build (`make mbtiles`) before
# starting the server. With --layer, a missing file just lists what's
# currently available in .cache/mbtiles-layers/ -- run `dt mbtiles` in
# another terminal to populate it (see the "preview with" hint it prints
# after each layer).
#
# ============================================================

info()  { echo "ℹ️  $1"; }
warn()  { echo "⚠️  $1"; }
error() { echo "❌ $1" >&2; exit 1; }

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$PROJECT_ROOT"

STYLE_SRC="datasources/mbtiles-config/style.json"

PUBLIC_PORT="${MBTILES_TESTBED_PORT:-7900}"
UPSTREAM_PORT="${MBTILES_UPSTREAM_PORT:-7901}"
AUTO_YES=false
LAYER=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --port) PUBLIC_PORT="$2"; shift 2 ;;
    --yes|-y) AUTO_YES=true; shift ;;
    --layer) LAYER="$2"; shift 2 ;;
    --style) STYLE_SRC="$2"; shift 2 ;;
    *) error "Unknown argument: $1" ;;
  esac
done

if [[ -n "$LAYER" ]]; then
  MBTILES_DIR=".cache/mbtiles-layers"
  TILES_FILE="$MBTILES_DIR/$LAYER.mbtiles"
  SERVICE_ID="$LAYER"
else
  MBTILES_DIR="data/mbtiles"
  TILES_FILE="$MBTILES_DIR/context.mbtiles"
  SERVICE_ID="context"
fi

for cmd in mbtileserver python3 jq curl; do
  command -v "$cmd" >/dev/null 2>&1 || error "$cmd not found — run this inside 'nix develop' (or 'nix run .#mbtiles-server')"
done

[[ -f "$STYLE_SRC" ]] || error "Style not found: $STYLE_SRC"


# -----------------------------
# BUILD TILES IF MISSING
# -----------------------------
if [[ ! -f "$TILES_FILE" ]]; then
  if [[ -n "$LAYER" ]]; then
    warn "$TILES_FILE does not exist yet."
    AVAILABLE=$(ls "$MBTILES_DIR"/*.mbtiles 2>/dev/null | xargs -n1 basename 2>/dev/null || true)
    if [[ -n "$AVAILABLE" ]]; then
      info "Currently available layers:"
      echo "$AVAILABLE" | sed 's/^/  - /'
    fi
    error "Run 'dt mbtiles' in another terminal to build it (this layer shows up as soon as its own stage finishes)."
  fi

  warn "$TILES_FILE does not exist yet."
  RUN_BUILD=false

  if [[ "$AUTO_YES" == true ]]; then
    RUN_BUILD=true
  elif [[ -t 0 ]]; then
    read -r -p "Run 'make mbtiles' now to build it? [y/N] " REPLY
    [[ "$REPLY" =~ ^[Yy]$ ]] && RUN_BUILD=true
  fi

  if [[ "$RUN_BUILD" == true ]]; then
    info "Building tiles (make mbtiles)..."
    # --no-edit: --yes (or a non-interactive shell) means "just build it",
    # so skip gpkg_to_mbtiles.sh's own layer-treatment.csv edit prompt too.
    make -C "$PROJECT_ROOT" mbtiles ARGS="--no-edit"
  else
    error "No tiles to serve. Run 'dt mbtiles' (or re-run with --yes) first."
  fi
fi


# -----------------------------
# WORKDIR: rewritten style + preview page
# -----------------------------
WORKDIR="$(mktemp -d)"
MBTILESERVER_PID=""
PROXY_PID=""

cleanup() {
  [[ -n "$PROXY_PID" ]] && kill "$PROXY_PID" 2>/dev/null || true
  [[ -n "$MBTILESERVER_PID" ]] && kill "$MBTILESERVER_PID" 2>/dev/null || true
  rm -rf "$WORKDIR"
}
trap cleanup EXIT INT TERM

# mbtileserver builds its TileJSON "tiles" URLs from the request's Host
# header, so pointing each style source at a same-origin, relative
# service path is what lets it pick up whatever host:port the browser
# actually used. Every source gets rewritten: in the default (non
# --layer) run, mbtileserver --dir data/mbtiles already loads whatever
# standalone tilesets are sitting next to context.mbtiles (e.g.
# catchments.mbtiles -> /services/catchments), matching production's
# "Catchments" source one-for-one; the combined source falls back to
# $SERVICE_ID (context, or the single layer being previewed).
#
# In --layer mode the style still references every source-layer (all of
# ecoregions/rivers/catchments/etc.), but the single-layer MBTiles file
# only contains one of them -- MapLibre silently skips style layers
# whose source-layer isn't present in the tile, so only that one layer
# draws. Harmless, and exactly what you want when checking one layer.
jq --arg url "/services/$SERVICE_ID" \
  '.sources |= with_entries(
    .value.url = (if .key == "Catchments" then "/services/catchments" else $url end)
  )' \
  "$STYLE_SRC" > "$WORKDIR/style.json"

cat > "$WORKDIR/index.html" <<'HTML'
<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <title>mbtiles testbed</title>
  <script src="https://unpkg.com/maplibre-gl@4.7.1/dist/maplibre-gl.js"></script>
  <link href="https://unpkg.com/maplibre-gl@4.7.1/dist/maplibre-gl.css" rel="stylesheet">
  <style>
    body { margin: 0; }
    #map { position: absolute; inset: 0; }
    #layers {
      position: absolute; top: 8px; right: 8px; z-index: 1;
      background: rgba(255,255,255,0.92); padding: 8px 10px; border-radius: 6px;
      font: 12px/1.4 sans-serif; max-height: 90vh; overflow: auto;
    }
  </style>
</head>
<body>
  <div id="map"></div>
  <div id="layers"><strong>Layers</strong><div id="layer-list"></div></div>
  <script>
    const map = new maplibregl.Map({
      container: "map",
      style: "/style.json",
      hash: true,
    });
    map.addControl(new maplibregl.NavigationControl());
    map.on("load", () => {
      const list = document.getElementById("layer-list");
      map.getStyle().layers.forEach((layer) => {
        const row = document.createElement("label");
        row.style.display = "block";
        const box = document.createElement("input");
        box.type = "checkbox";
        box.checked = map.getLayoutProperty(layer.id, "visibility") !== "none";
        box.onchange = () => map.setLayoutProperty(layer.id, "visibility", box.checked ? "visible" : "none");
        row.appendChild(box);
        row.appendChild(document.createTextNode(" " + layer.id));
        list.appendChild(row);
      });
    });
    map.on("error", (e) => console.error("map error:", e.error));
  </script>
</body>
</html>
HTML


# -----------------------------
# START MBTILESERVER + PROXY
# -----------------------------
info "Starting mbtileserver on 127.0.0.1:$UPSTREAM_PORT..."
mbtileserver --dir "$MBTILES_DIR" --port "$UPSTREAM_PORT" >"$WORKDIR/mbtileserver.log" 2>&1 &
MBTILESERVER_PID=$!

for _ in $(seq 1 50); do
  curl -sf "http://127.0.0.1:$UPSTREAM_PORT/services" >/dev/null 2>&1 && break
  sleep 0.2
done
curl -sf "http://127.0.0.1:$UPSTREAM_PORT/services" >/dev/null 2>&1 || {
  cat "$WORKDIR/mbtileserver.log" >&2
  error "mbtileserver did not start"
}

MBTILES_TESTBED_PORT="$PUBLIC_PORT" \
MBTILES_UPSTREAM_PORT="$UPSTREAM_PORT" \
MBTILES_TESTBED_STATIC_DIR="$WORKDIR" \
  python3 "$SCRIPT_DIR/mbtiles_proxy.py" &
PROXY_PID=$!

info "✅ Serving '$SERVICE_ID' — open http://localhost:$PUBLIC_PORT (Ctrl+C to stop)"
wait "$PROXY_PID"
