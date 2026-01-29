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

This provides all tools: Go, Node.js, GCC, GDAL, tippecanoe, MkDocs, golangci-lint, and more. Nothing else to install.

## 4. Build and Run

```bash
make build    # Build frontend, docs, and backend
make dev      # Run on http://localhost:8080
```

Or using Nix directly:

```bash
nix run       # Reproducible build + run
```

## 5. Run Tests

```bash
make test-all
```

## 6. Serve the Documentation

```bash
make docs-serve
```

Then open http://127.0.0.1:8000 in your browser.

For architecture details, coding standards, testing, data preparation, and release procedures, see the **Developer Guide** section in the documentation.
