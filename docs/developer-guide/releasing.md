# Preparing a Release

## Version Tagging

Releases are triggered by pushing a Git tag matching `v*`:

```bash
git tag v0.2.0
git push origin v0.2.0
```

This triggers the GitHub Actions release workflow.

## What the Release Workflow Does

The `.github/workflows/release.yml` workflow has two phases:

### Phase 1: Build Binaries

Builds platform-specific binaries using a matrix strategy:

| Runner | Target | Archive |
|--------|--------|---------|
| `ubuntu-latest` | `linux/amd64` | `.tar.gz` |
| `ubuntu-24.04-arm` | `linux/arm64` | `.tar.gz` |
| `macos-13` | `darwin/amd64` | `.tar.gz` |
| `macos-14` | `darwin/arm64` | `.tar.gz` |
| `windows-latest` | `windows/amd64` | `.zip` |

For each platform:

1. Sets up Go 1.24, Node.js 22, and Python 3.12
2. Builds the frontend (`npm ci && npm run build`)
3. Builds documentation (`mkdocs build`)
4. Copies built assets into `internal/server/static/` and `internal/server/docs_site/`
5. Installs platform-specific CGO dependencies
6. Builds the Go binary with `-ldflags "-s -w -X main.version=<tag>"`
7. Packages into `.tar.gz` (Unix) or `.zip` (Windows)
8. Generates SHA256 checksums

### Phase 2: Package Installers

After binaries are built, parallel packaging jobs create platform-native installers:

| Job | Output | Tool |
|-----|--------|------|
| `package-linux-nfpm` | `.deb`, `.rpm` (amd64 + arm64) | [nfpm](https://nfpm.goreleaser.com/) |
| `package-appimage` | `.AppImage` (amd64 + arm64) | [appimagetool](https://github.com/AppImage/appimagetool) |
| `package-flatpak` | `.flatpak` (amd64) | `flatpak-builder` |
| `package-snap` | `.snap` (amd64) | `snapcraft` |
| `package-macos` | `.dmg` (amd64 + arm64) | `hdiutil` |
| `package-windows` | `.msi` (amd64) | [WiX Toolset](https://wixtoolset.org/) |

### Phase 3: Publish Release

All artifacts are collected and published as a GitHub Release with:

- Platform archives (`.tar.gz`, `.zip`)
- Installer packages (`.deb`, `.rpm`, `.AppImage`, `.flatpak`, `.snap`, `.dmg`, `.msi`)
- Merged SHA256 checksums file
- Auto-generated release notes with installation instructions

## Building Packages Locally

You can build release packages locally using `make packages`. This builds the frontend and docs, then cross-compiles for each platform:

```bash
# All platforms (linux native + windows cross-compile)
make packages

# Single platform
make packages-linux
make packages-windows
make packages-darwin   # macOS only (requires running on macOS)
```

Output in `dist/`:

| Platform | Artefacts | Requirements |
|----------|-----------|-------------|
| Linux | `.tar.gz`, `.deb`, `.rpm` | Native build; `nfpm` for deb/rpm (in nix devShell) |
| Windows | `.zip`, `.msi` | `mingw-w64` cross-compiler (in nix devShell); WiX v4+ for `.msi` |
| macOS | `.tar.gz` or `.dmg` | Must run on macOS |

The script (`scripts/build-packages.sh`) accepts `--platform`, `--arch`, and `--version` flags for fine-grained control:

```bash
./scripts/build-packages.sh --platform windows --arch amd64 --version 0.2.0
```

### Downloads Page Auto-Configuration

`scripts/package-data.sh`, `scripts/build-windows-installer.sh`, `scripts/build-debian-installer.sh`, the macOS build in `scripts/build-packages.sh`, and `scripts/build-cross-docker.sh` each call `scripts/update-download-config.sh` after producing their artefact. It writes the artefact's path into the local `settings.json` that `internal/config.SettingsDir()` reads (e.g. `~/.config/decision-theatre/settings.json` on Linux), which is what the in-app downloads page serves. Practically: build on the same machine you run the app on, and the download page immediately offers the new files — no manual settings edit needed. Requires `jq`; if it's missing, the update is skipped with a warning rather than failing the build.

**This is the host's settings.json, not the Docker deployment's.** If you're serving the downloads page via `deployments/docker-compose.yaml`, the `app` container has its own, separate `settings.json` under `/root/.config/decision-theatre` (a named volume, `decision-theatre-settings`, so it survives container recreation). `scripts/build-cross-docker.sh` handles this automatically: if the `deployments-app` container is running and the artefacts landed under `dist/` (the default `--dest`, bind-mounted into the container at `/app/dist`), it additionally `docker exec`s `update-download-config.sh` inside the container with the container-internal paths, mirroring what `make datapack` already does for data packs.

If you used a custom `--dest` outside `dist/`, or need to update the container's config by hand for another reason, point it at the container-internal paths by running the same script *inside* the container instead:

```bash
docker exec deployments-app-1 /app/scripts/update-download-config.sh \
  --executable-linux /app/dist/cross/decision-theatre \
  --executable-windows /app/dist/cross/decision-theatre.exe
```

The runtime image includes `jq` for exactly this purpose.

## Building Executables in Docker

If you don't want to install Nix, Go, Node, or mingw-w64 locally, `deployments/Dockerfile.cross` builds the raw Linux and Windows executables inside Docker (frontend + docs included), using BuildKit's `--output` to export the binary straight to a host directory — no container to clean up afterwards.

Requires Docker with BuildKit (Docker 23+, or `DOCKER_BUILDKIT=1` set).

Use `scripts/build-cross-docker.sh` rather than calling `docker build` directly — the export targets only place files in the output directory, they don't touch the downloads page config the way the other `build-*.sh` scripts do, so this wrapper builds and then calls `update-download-config.sh` itself (both on the host, and inside the `deployments-app` container if it's running — see above):

```bash
# Both platforms -> dist/cross/decision-theatre, dist/cross/decision-theatre.exe
./scripts/build-cross-docker.sh

# Single platform
./scripts/build-cross-docker.sh --platform linux
./scripts/build-cross-docker.sh --platform windows

# Custom version / output directory
./scripts/build-cross-docker.sh --platform windows --version 0.2.0 --dest dist/cross
```

This produces the bare executables only — not installers (`.deb`, `.msi`, etc.). Feed the exported binary into `packaging/` tooling (e.g. `nfpm`, WiX) if you need a package.

If you need the raw `docker build --output` invocation directly (e.g. for a custom pipeline), see the `export-linux-amd64`, `export-windows-amd64`, and `export-all` targets in `deployments/Dockerfile.cross` — just remember to run `scripts/update-download-config.sh` yourself afterwards.

**macOS is not available in Docker.** The app links against Cocoa/WebKit via CGO, which requires Apple's SDK and toolchain. That SDK isn't redistributable and there's no reliable open cross-toolchain for it, so macOS binaries must be built natively on macOS via `make packages-darwin` (see the table above).

## Building a Data Pack

Data packs are built locally (not in CI) because they contain large binary data files:

```bash
make datapack
```

This creates `dist/decision-theatre-data-v{VERSION}.zip` with a SHA256 checksum. Upload the data pack to the GitHub Release manually or distribute it separately.

`make datapack` also updates the downloads page config (see above): `scripts/package-data.sh` updates the host's `settings.json`, and if the `deployments-app` container from `deployments/docker-compose.yaml` is running, the Makefile target additionally `docker exec`s `update-download-config.sh` inside it with the container-internal `/app/dist/...` path — so the containerized downloads page picks up the new data pack too, with no manual step.

## Packaging Configuration Files

| File | Purpose |
|------|---------|
| `packaging/nfpm.yaml` | DEB and RPM package definition |
| `packaging/decision-theatre.desktop` | Linux desktop entry |
| `packaging/appimage/AppRun` | AppImage entry point |
| `packaging/flatpak/org.kartoza.DecisionTheatre.yml` | Flatpak manifest |
| `packaging/snap/snapcraft.yaml` | Snap definition |
| `packaging/macos/Info.plist` | macOS app bundle metadata |
| `packaging/macos/create-dmg.sh` | macOS DMG creation script |
| `packaging/windows/product.wxs` | WiX MSI definition |

## Platform-Specific CGO Dependencies

| Platform | Dependencies |
|----------|-------------|
| Linux | `libopenblas-dev`, `libwebkit2gtk-4.1-dev`, `libgtk-3-dev` |
| macOS | `openblas` (via Homebrew) |
| Windows | None (CGO_ENABLED=1 uses MSVC) |

## Version Embedding

The version string is embedded at build time via:

```
-X main.version=${tag}
```

This makes it available via `--version` and in the UI header badge.

## Pre-Release Checklist

1. All CI checks pass on `main`
2. Update the version in `flake.nix` (`version = "x.y.z"`)
3. Run `nix build` locally to verify the build
4. Run `nix flake check` to verify tests
5. Build and test the data pack: `make datapack`
6. Create and push the tag
7. After the release is published, attach the data pack zip to the release

## Nix Build

For Nix users, `nix build` always produces a current build from source. The Nix flake version is set in `flake.nix` and should be updated to match the Git tag for releases.

Users can install directly: `nix profile install github:kartoza/DecisionTheatre`
