# Frequently Asked Questions

## General


<figure markdown>
  ![Five-step journey through the application](assets/diagrams/generated/user-journey.svg)
  <figcaption class="static">
    Where each part of the workflow sits, if you are not sure what to search for.
  </figcaption>
</figure>

### What is Landscape Decision Theatre?

A cross-platform desktop application for exploring African catchment data across reference, current, and target scenarios. It runs entirely offline, rendering vector map tiles and comparing catchment attributes side-by-side. See the [Overview](about/overview.md) for background.

### Does it require an internet connection?

No. Once installed with a data pack, everything runs locally from an embedded Go server -- map tiles, scenario data, and the documentation site itself. No data leaves your machine.

### What platforms are supported?

Linux (amd64/arm64), macOS (Intel/Apple Silicon), and Windows (x86_64), each as a single binary with a native desktop window. See [Installation](advanced/install-the-application.md).

### What license is it released under?

GPL-3.0. See the [License](about/license.md) page for details and third-party licenses.

## Installation and Data

### The app says data files are missing. What do I do?

On first launch, Decision Theatre shows a Setup Guide if it can't find map tiles or scenario data. You need to install a **data pack** -- see [Data Setup](advanced/install-a-data-pack.md) for the full process.

### What is a data pack?

A `.zip` archive containing MBTiles map tiles, a MapBox style, and optionally a GeoPackage with scenario data. It's distributed separately from the application binary and installed either through the app's UI or via the `--data-dir` flag.

### Where does the application store installed data and settings?

Settings (including the remembered data pack location) live in a platform-specific config directory (e.g. `~/.config/decision-theatre/settings.json` on Linux), and extracted data packs live in a platform-specific data directory (e.g. `~/.local/share/decision-theatre/datapacks/` on Linux). Full paths for each OS are listed in [Installation](advanced/install-the-application.md) and [Data Setup](advanced/install-a-data-pack.md).

### Can I run the application without a desktop window?

Yes, with `./decision-theatre --headless`, then open `http://localhost:8080` in a browser. Useful for servers or containers -- see [Server Deployment](developer-guide/server-deployment.md).

### On Linux, the app window won't open. Why?

WebKit2GTK 4.1 is required and isn't bundled. Install it with `sudo apt install libwebkit2gtk-4.1-0` (Debian/Ubuntu) or `sudo dnf install webkit2gtk4.1` (Fedora). The `.deb`/`.rpm` packages install this automatically; portable binaries and AppImages do not.

## Using the Application

### What's the difference between reference, current, and target scenarios?

They represent the same catchment attributes measured (or projected) at different points in time, letting you compare how a factor like rainfall or land cover changes. Select them independently for the left and right side of the swipe view -- see [Scenario Comparison](guide/read-the-data-four-ways.md).

### How do I compare two scenarios side by side?

Open a site, choose a scenario and attribute for the left and right panes in the indicator panel, then drag the vertical swipe divider on the map to compare areas. Details in [Using the Map](guide/open-the-map.md) and [Scenario Comparison](guide/read-the-data-four-ways.md).

### What's the difference between single view and grid view?

Grid view shows a grid of independent panes -- six by default, in either 2 or 3 columns via the columns toggle -- each with its own factor, scenario and view mode. You can add and remove panes. Single view expands one pane to fill the screen with its indicator panel open. Both layouts, and your per-pane selections, persist between sessions.

### Are my selections saved automatically?

Yes. Scenario and attribute choices, map viewport, and grid/single layout are saved to your browser's local storage and, when working inside a site, to the site itself.

### The application has become slow, or my changes aren't being saved

This is a known issue with browser-based use. The application stores a large amount of
per-catchment data in browser local storage, which has a fixed size limit of around 5 MB.
Once that limit is reached, saves fail silently -- your edits appear to work but are lost
on reload. Running one of the guided demo tours can exhaust the limit on its own.

As a workaround, clearing site data for the application in your browser settings will free
the space, though it will also remove any locally-stored sites. The desktop application
stores sites as files and is not affected.

This is being fixed -- see the tickets *Starting a demo tour writes a multi-megabyte site
to localStorage and blows the quota*, *localStorage quota failures are silently swallowed*,
and *Full per-catchment analytics are persisted client-side*.


