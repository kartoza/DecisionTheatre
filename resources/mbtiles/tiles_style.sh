#!/usr/bin/env bash
set -euo pipefail

# ============================================================
# tiles_styles
#
# PURPOSE
# -------
# Launch tileserver-gl in Docker to serve a local MBTiles file
# and allow live styling via Maputnik.
#
# FEATURES
# --------
# • Auto-detects a free localhost port
# • Serves vector tiles from a user-specified .mbtiles file
# • Loads a default style if none exists
# • Hot-reloads styles when edited (no restart needed)
# • Works with Maputnik out of the box
#
# USAGE
# -----
#   chmod +x tiles_styles
#   ./tiles_styles /absolute/path/to/data.mbtiles
#
# Then open:
#   https://maputnik.github.io
#
# TileJSON URL:
#   http://localhost:<PORT>/data/tiles.json
#
# ============================================================


# -----------------------------
# INPUT VALIDATION
# -----------------------------
MBTILES_PATH="${1:-}"

if [[ -z "$MBTILES_PATH" ]]; then
  echo "Usage: $0 /path/to/file.mbtiles"
  exit 1
fi

if [[ ! -f "$MBTILES_PATH" ]]; then
  echo "❌ MBTiles file not found: $MBTILES_PATH"
  exit 1
fi

MBTILES_PATH="$(realpath "$MBTILES_PATH")"


# -----------------------------
# FIND A FREE LOCAL PORT
# -----------------------------
find_free_port() {
  for port in $(seq 8080 8999); do
    if ! ss -ltn | awk '{print $4}' | grep -q ":$port$"; then
      echo "$port"
      return
    fi
  done
  echo "❌ No free ports available"
  exit 1
}

PORT="$(find_free_port)"


# -----------------------------
# DIRECTORY SETUP
# -----------------------------
BASE_DIR="$(pwd)/tileserver_runtime"
DATA_DIR="$BASE_DIR/data"
STYLE_DIR="$BASE_DIR/styles"

mkdir -p "$DATA_DIR" "$STYLE_DIR"

# Copy MBTiles into tileserver data directory
cp "$MBTILES_PATH" "$DATA_DIR/tiles.mbtiles"


# -----------------------------
# DEFAULT STYLE (IF NONE EXISTS)
# -----------------------------
DEFAULT_STYLE="$STYLE_DIR/style.json"

if [[ ! -f "$DEFAULT_STYLE" ]]; then
  cat > "$DEFAULT_STYLE" <<'EOF'
{
  "version": 8,
  "name": "Default Vector Style",
  "sources": {
    "tiles": {
      "type": "vector",
      "url": "http://localhost:PORT/data/tiles.json"
    }
  },
  "layers": [
    {
      "id": "background",
      "type": "background",
      "paint": { "background-color": "#f8f8f8" }
    }
  ]
}
EOF

  # Inject actual port
  sed -i "s/PORT/$PORT/g" "$DEFAULT_STYLE"
fi


# -----------------------------
# CLEAN UP ANY OLD CONTAINER
# -----------------------------
docker rm -f tileserver-gl >/dev/null 2>&1 || true


# -----------------------------
# START TILESERVER-GL
# -----------------------------
echo "🚀 Starting tileserver-gl"
echo "📦 MBTiles: $MBTILES_PATH"
echo "🌐 Port:    http://localhost:$PORT"
echo
echo "👉 Open Maputnik:"
echo "   https://maputnik.github.io"
echo
echo "👉 TileJSON URL:"
echo "   http://localhost:$PORT/data/tiles.json"
echo
echo "🖌️  Styles directory:"
echo "   $STYLE_DIR"
echo
echo "🛑 Press Ctrl+C to stop"
echo

docker run --rm \
  --name tileserver-gl \
  -p "$PORT:8080" \
  -v "$DATA_DIR:/data" \
  -v "$STYLE_DIR:/styles" \
  maptiler/tileserver-gl \
  --port 8080 \
  --verbose
