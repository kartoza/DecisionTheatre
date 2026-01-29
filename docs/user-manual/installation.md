# Installation

Decision Theatre is distributed as a single binary for each platform.

## Download

Download the latest release from [GitHub Releases](https://github.com/kartoza/DecisionTheatre/releases).

| Platform | Archive |
|----------|---------|
| Linux (x86_64) | `decision-theatre-linux-amd64.tar.gz` |
| Linux (ARM64) | `decision-theatre-linux-arm64.tar.gz` |
| macOS (Intel) | `decision-theatre-darwin-amd64.tar.gz` |
| macOS (Apple Silicon) | `decision-theatre-darwin-arm64.tar.gz` |
| Windows (x86_64) | `decision-theatre-windows-amd64.zip` |

## Platform Requirements

=== "Linux"

    WebKit2GTK 4.1 is required for the desktop window:

    ```bash
    # Debian/Ubuntu
    sudo apt install libwebkit2gtk-4.1-0

    # Fedora
    sudo dnf install webkit2gtk4.1
    ```

=== "macOS"

    No additional dependencies. WKWebView is included with macOS.

=== "Windows"

    Edge WebView2 runtime is required. It is included with Windows 10 and later.

## Running

### Desktop mode (default)

```bash
# Linux/macOS
tar xzf decision-theatre-*.tar.gz
./decision-theatre --data-dir ./data --resources-dir ./resources
```

```powershell
# Windows
decision-theatre.exe --data-dir ./data --resources-dir ./resources
```

A native window opens with the application.

### Headless mode

Run without a GUI window and access the application in your browser:

```bash
./decision-theatre --headless
# Open http://localhost:8080
```

### Using Nix

If you have Nix installed with flakes enabled:

```bash
nix run github:kartoza/DecisionTheatre
```

## Command-Line Options

| Flag | Default | Description |
|------|---------|-------------|
| `--port` | `8080` | HTTP server port |
| `--data-dir` | `./data` | Directory containing GeoParquet scenario files |
| `--resources-dir` | `./resources` | Directory containing MBTiles and style files |
| `--model` | *(none)* | Path to a GGUF model file for the embedded LLM |
| `--headless` | `false` | Run without a desktop window |
| `--version` | | Print version and exit |
