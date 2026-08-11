# Frequently Asked Questions

## General

### What is Landscape Decision Theatre?

A cross-platform desktop application for exploring African catchment data across reference, current, and future scenarios. It runs entirely offline, rendering vector map tiles and comparing catchment attributes side-by-side. See the [Overview](about/overview.md) for background.

### Does it require an internet connection?

No. Once installed with a data pack, everything runs locally from an embedded Go server -- map tiles, scenario data, and the documentation site itself. No data leaves your machine.

### What platforms are supported?

Linux (amd64/arm64), macOS (Intel/Apple Silicon), and Windows (x86_64), each as a single binary with a native desktop window. See [Installation](user-manual/installation.md).

### What license is it released under?

GPL-3.0. See the [License](about/license.md) page for details and third-party licenses.

## Installation and Data

### The app says data files are missing. What do I do?

On first launch, Decision Theatre shows a Setup Guide if it can't find map tiles or scenario data. You need to install a **data pack** -- see [Data Setup](user-manual/data-setup.md) for the full process.

### What is a data pack?

A `.zip` archive containing MBTiles map tiles, a MapBox style, and optionally a GeoPackage with scenario data. It's distributed separately from the application binary and installed either through the app's UI or via the `--data-dir` flag.

### Where does the application store installed data and settings?

Settings (including the remembered data pack location) live in a platform-specific config directory (e.g. `~/.config/decision-theatre/settings.json` on Linux), and extracted data packs live in a platform-specific data directory (e.g. `~/.local/share/decision-theatre/datapacks/` on Linux). Full paths for each OS are listed in [Installation](user-manual/installation.md#settings-location) and [Data Setup](user-manual/data-setup.md#installing-a-data-pack).

### Can I run the application without a desktop window?

Yes, with `./decision-theatre --headless`, then open `http://localhost:8080` in a browser. Useful for servers or containers -- see [Server Deployment](developer-guide/server-deployment.md).

### On Linux, the app window won't open. Why?

WebKit2GTK 4.1 is required and isn't bundled. Install it with `sudo apt install libwebkit2gtk-4.1-0` (Debian/Ubuntu) or `sudo dnf install webkit2gtk4.1` (Fedora). The `.deb`/`.rpm` packages install this automatically; portable binaries and AppImages do not.

## Using the Application

### What's the difference between reference, current, and future scenarios?

They represent the same catchment attributes measured (or projected) at different points in time, letting you compare how a factor like rainfall or land cover changes. Select them independently for the left and right side of the swipe view -- see [Scenario Comparison](user-manual/scenario-comparison.md).

### How do I compare two scenarios side by side?

Open a project, choose a scenario and attribute for the left and right panes in the indicator panel, then drag the vertical swipe divider on the map to compare areas. Details in [Using the Map](user-manual/using-the-map.md) and [Scenario Comparison](user-manual/scenario-comparison.md).

### What's the difference between single view and quad view?

Quad view shows four independent map panes in a 2x2 grid, each with its own scenario and attribute selection. Single view expands one pane to fill the screen with its indicator panel open. Both layouts, and your per-pane selections, persist between sessions.

### Are my project selections saved automatically?

Yes. Scenario and attribute choices, map viewport, and quad/single layout are saved to local storage and, when working inside a project, to the project file itself.


