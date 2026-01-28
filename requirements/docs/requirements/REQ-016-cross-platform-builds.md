# REQ-016: Cross-Platform Builds

| Field | Value |
|-------|-------|
| **Component** | Infrastructure |
| **Author** | Tim Sketcher (Product Owner) |
| **User Story** | As a developer, when I push a version tag, CI should produce release binaries for Windows, macOS, and Linux, each built natively on the target platform with all dependencies from the nix store. |
| **Importance** | High |

## Wireframe

```
CI Build Matrix (native builds, no cross-compilation):
┌──────────────────────────────────────────────────────────┐
│ Runner              │ Platform │ Arch  │ Build Method     │
├─────────────────────┼──────────┼───────┼──────────────────┤
│ ubuntu-latest       │ Linux    │ amd64 │ nix build        │
│ ubuntu-24.04-arm    │ Linux    │ arm64 │ nix build        │
│ macos-13            │ Darwin   │ amd64 │ nix build        │
│ macos-14            │ Darwin   │ arm64 │ nix build        │
│ windows-latest      │ Windows  │ amd64 │ go build (direct)│
└──────────────────────────────────────────────────────────┘

Local development:
  nix build           → binary for current platform
  nix build .#frontend → frontend only
  nix flake check      → run all tests
```

## Implementation Details

- **No cross-compilation**: CGO (llama.cpp) requires a native C toolchain; each platform binary is built by a CI runner on that platform
- **Nix on unix**: Linux and macOS CI runners use `nix build` for fully reproducible, hermetic builds with all deps from the nix store
- **Windows**: Uses `setup-go` + `setup-node` + `npm ci` since nix support on Windows is limited; `npm ci` uses the lockfile for deterministic installs
- **Frontend built once per runner**: `buildNpmPackage` (nix) or `npm ci` (Windows) fetches deps into a sandbox, then `vite build` bundles everything; no CDN or external fetches
- **Triggered on version tags**: `git tag v0.1.0 && git push --tags` triggers the release workflow
- **Release artifacts**: Tarball per platform + merged SHA256 checksums, published as a GitHub Release via `softprops/action-gh-release`
- **SBOM**: The nix `flake.lock` + `npmDepsHash` + `vendorHash` constitute a complete, auditable software bill of materials
- **Desktop entry**: Linux builds include a `.desktop` file for application launchers

### Key Files

- `flake.nix` - Nix build configuration (native platform only)
- `.github/workflows/release.yml` - CI platform matrix builds
- `.github/workflows/ci.yml` - Tests + lint on every push
