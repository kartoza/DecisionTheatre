# Preparing a Release

## Version Tagging

Releases are triggered by pushing a Git tag matching `v*`:

```bash
git tag v0.2.0
git push origin v0.2.0
```

This triggers the GitHub Actions release workflow.

## What the Release Workflow Does

The `.github/workflows/release.yml` workflow:

1. **Builds platform-specific binaries** using a matrix strategy:

    | Runner | Target | Archive |
    |--------|--------|---------|
    | `ubuntu-latest` | `linux/amd64` | `.tar.gz` |
    | `ubuntu-24.04-arm` | `linux/arm64` | `.tar.gz` |
    | `macos-13` | `darwin/amd64` | `.tar.gz` |
    | `macos-14` | `darwin/arm64` | `.tar.gz` |
    | `windows-latest` | `windows/amd64` | `.zip` |

2. **For each platform:**
    - Sets up Go 1.24 and Node.js 22
    - Builds the frontend (`npm ci && npm run build`)
    - Copies built frontend into `internal/server/static/`
    - Installs platform-specific CGO dependencies
    - Builds the Go binary with `-ldflags "-s -w -X main.version=<tag>"`
    - Packages into `.tar.gz` (Unix) or `.zip` (Windows)
    - Generates SHA256 checksums

3. **Creates a GitHub Release** with:
    - All platform archives
    - Merged checksums file
    - Auto-generated release notes
    - Installation instructions

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
5. Create and push the tag

## Nix Build

For Nix users, `nix build` always produces a current build from source. The Nix flake version is set in `flake.nix` and should be updated to match the Git tag for releases.
