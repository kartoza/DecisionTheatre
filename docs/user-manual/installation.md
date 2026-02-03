# Installation

Landscape Decision Theatre is available as platform-native installers and portable binaries.

## Platform Installers

Download the latest release from [GitHub Releases](https://github.com/kartoza/DecisionTheatre/releases).

### Linux

| Format | File | Install Command |
|--------|------|-----------------|
| **Debian/Ubuntu** | `.deb` | `sudo dpkg -i decision-theatre-*.deb` |
| **Fedora/RHEL** | `.rpm` | `sudo rpm -i decision-theatre-*.rpm` |
| **AppImage** | `.AppImage` | `chmod +x *.AppImage && ./*.AppImage` |
| **Flatpak** | `.flatpak` | `flatpak install decision-theatre.flatpak` |
| **Snap** | `.snap` | `sudo snap install --dangerous *.snap` |
| **NixOS** | Flake | `nix profile install github:kartoza/DecisionTheatre` |

Linux installers are available for both `amd64` and `arm64` architectures (deb, rpm, AppImage). Flatpak and Snap are `amd64` only.

### macOS

Download the `.dmg` file for your architecture (Intel or Apple Silicon), open it, and drag Decision Theatre to your Applications folder.

### Windows

Download and run the `.msi` installer. This installs to `C:\Program Files\Decision Theatre\`.

## Portable Binaries

If you prefer not to use an installer, download the portable archive:

| Platform | Archive |
|----------|---------|
| Linux (x86_64) | `decision-theatre-linux-amd64.tar.gz` |
| Linux (ARM64) | `decision-theatre-linux-arm64.tar.gz` |
| macOS (Intel) | `decision-theatre-darwin-amd64.tar.gz` |
| macOS (Apple Silicon) | `decision-theatre-darwin-arm64.tar.gz` |
| Windows (x86_64) | `decision-theatre-windows-amd64.zip` |

```bash
# Linux/macOS
tar xzf decision-theatre-*.tar.gz
./decision-theatre
```

## Platform Requirements

=== "Linux"

    WebKit2GTK 4.1 is required for the desktop window:

    ```bash
    # Debian/Ubuntu
    sudo apt install libwebkit2gtk-4.1-0

    # Fedora
    sudo dnf install webkit2gtk4.1
    ```

    Note: The `.deb` and `.rpm` packages declare this dependency and will install it automatically.

=== "macOS"

    No additional dependencies. WKWebView is included with macOS.

=== "Windows"

    Edge WebView2 runtime is required. It is included with Windows 10 and later.

## First Launch

On first launch, Decision Theatre will prompt you to install a **data pack**. See [Data Setup](data-setup.md) for details.

If you have previously installed a data pack, the application remembers the location and loads it automatically.

## Running Modes

### Desktop mode (default)

```bash
./decision-theatre
```

A native window opens with the application.

### Headless mode

Run without a GUI window and access the application in your browser:

```bash
./decision-theatre --headless
# Open http://localhost:8080
```

### Using Nix

```bash
nix run github:kartoza/DecisionTheatre
```

## Command-Line Options

| Flag | Default | Description |
|------|---------|-------------|
| `--port` | `8080` | HTTP server port |
| `--data-dir` | *(auto)* | Directory containing GeoParquet scenario files |
| `--resources-dir` | *(auto)* | Directory containing MBTiles and style files |
| `--headless` | `false` | Run without a desktop window |
| `--version` | | Print version and exit |

When `--data-dir` and `--resources-dir` are not specified, the application checks for a previously installed data pack in its settings file. If none is found, it falls back to `./data` and `./resources`.

## Settings Location

Application settings (including the remembered data pack path) are stored at:

| Platform | Path |
|----------|------|
| Linux | `~/.config/decision-theatre/settings.json` |
| macOS | `~/Library/Application Support/decision-theatre/settings.json` |
| Windows | `%APPDATA%\decision-theatre\settings.json` |
