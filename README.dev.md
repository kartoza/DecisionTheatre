# Developer Quick Start (Ubuntu)

## 1. Install Nix

```bash
sh <(curl -L https://nixos.org/nix/install) --daemon
```

After installation, open a new terminal or run:

```bash
. /nix/var/nix/profiles/default/etc/profile.d/nix-daemon.sh
```

## 2. Enable Flakes

```bash
mkdir -p ~/.config/nix
echo "experimental-features = nix-command flakes" >> ~/.config/nix/nix.conf
```

If running the Nix daemon, restart it:

```bash
sudo systemctl restart nix-daemon
```

## 3. Enter the Development Shell

```bash
cd DecisionTheatre
nix develop
```

This provides all tools: Go, Node.js, GCC, GDAL, tippecanoe, MkDocs, golangci-lint, air, and more. Nothing else to install.

## 4. Live Development (Recommended)

For the best development experience with hot-reload on both frontend and backend:

```bash
make dev-all
```

This starts two processes:

- **air** on port 8080 — watches Go files and auto-rebuilds/restarts the backend when you save
- **Vite** on port 5173 — provides instant HMR for React/TypeScript changes

Open **http://localhost:5173** in your browser. Edit `.tsx` files in neovim and see changes instantly. Edit `.go` files and the backend auto-rebuilds within ~1 second.

You can also run each process separately in different terminals:

```bash
make dev-backend     # Go backend with air hot-reload (port 8080)
make dev-frontend    # Vite dev server with HMR (port 5173)
```

## 5. One-Shot Build and Run

If you don't need live reload:

```bash
make build    # Build frontend, docs, and backend
make dev      # Run on http://localhost:8080
```

Or using Nix directly for a fully reproducible build:

```bash
nix run       # Reproducible build + run
```

## 6. Run Tests

```bash
make test-all
```

## 7. Serve the Documentation

```bash
make docs-serve
```

Then open http://127.0.0.1:8000 in your browser.

## 8. Prepare Application Data

The application requires two data files: map tiles (MBTiles) and scenario data (GeoPackage).

### Map Tiles

Convert a GeoPackage with vector layers to MBTiles:

```bash
cd data/mbtiles
./gpkg_to_mbtiles.sh UoW_layers.gpkg catchments.mbtiles
```

### Scenario Datapack

Build the scenario datapack from catchment geometries and CSV data:

```bash
# Place input files in data/
# - catchments.gpkg (catchment geometries)
# - current.csv (current scenario metrics)
# - reference.csv (reference scenario metrics)
# - metadata.csv (optional column descriptions)

make geopackage
```

This creates `datapack.gpkg` with scenario tables, domain min/max for color scaling, and precomputed GeoJSON for fast API serving.

For detailed documentation on data formats and the GeoPackage schema, see the **Data Preparation** section in the developer documentation.

## Further Reading

For architecture details, coding standards, testing, and release procedures, see the **Developer Guide** section in the documentation.
