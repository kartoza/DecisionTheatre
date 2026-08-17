"""Conceptual documentation diagrams.

These illustrate workflows, layouts and mental models rather than parsed source
state, so they are written by hand — but drawn with the same brand library as
the generated ones, so the whole documentation set reads as one piece of work.

Anything that describes code or configuration belongs in ``diagrams_code.py``
instead, where it is parsed at build time and cannot drift.
"""

from __future__ import annotations

from svglib import Box, Diagram


# ---------------------------------------------------------------------------
# Product overview
# ---------------------------------------------------------------------------


def user_journey(p: dict) -> str:
    d = Diagram(1000, 250, p, title="How you move through the application",
                subtitle="From first launch to a saved study area you can compare scenarios across")
    steps = [
        ("Landing", ["Choose a starting point"]),
        ("Your Sites", ["Open, clone or", "create a study area"]),
        ("Define boundary", ["Draw, upload or", "select catchments"]),
        ("Compare", ["Map, chart, dial", "and table views"]),
        ("Set targets", ["Edit ideal values,", "watch the cascade"]),
    ]
    x, w, gap = 30, 172, 20
    for i, (title, lines) in enumerate(steps):
        d.step(x + i * (w + gap), 92, w, 92, i + 1, title, lines)
        if i < len(steps) - 1:
            sx = x + i * (w + gap) + w
            d.arrow(sx + 3, 138, sx + gap - 3, 138)
    d.label(30, 218, "Explore mode skips the boundary step entirely — browse the whole "
                     "dataset, then turn it into a site whenever you are ready.",
            size=11.5, color=p["ink"]["muted"])
    return d.render()


def runtime_modes(p: dict) -> str:
    d = Diagram(880, 400, p, title="Two runtimes, one binary",
                subtitle="The same server and interface, differing only in where sites are stored")

    d.lane(30, 76, 390, 250, "Desktop (WebView)", fill=p["blue"]["100"], stroke=p["blue"]["300"])
    d.box(Box(52, 116, 346, 52, "Native window", ["opened by main.go"],
              fill=p["surface"]["white"], stroke=p["blue"]["500"]))
    d.box(Box(52, 182, 346, 52, "Embedded Go server", ["localhost, ephemeral port"],
              fill=p["surface"]["white"], stroke=p["blue"]["500"]))
    d.box(Box(52, 248, 346, 56, "Sites → data/sites/*.json", ["files on disk, no size limit"],
              fill=p["status"]["successTint"], stroke=p["status"]["success"], mono=True))

    d.lane(460, 76, 390, 250, "Browser (server deployment)", fill=p["amber"]["100"], stroke=p["amber"]["300"])
    d.box(Box(482, 116, 346, 52, "User's own browser", ["--headless, no window"],
              fill=p["surface"]["white"], stroke=p["amber"]["700"]))
    d.box(Box(482, 182, 346, 52, "Same Go server", ["behind nginx, shared"],
              fill=p["surface"]["white"], stroke=p["amber"]["700"]))
    d.box(Box(482, 248, 346, 56, "Sites → browser local storage",
              ["~5 MB ceiling — see the storage tickets"],
              fill=p["status"]["errorTint"], stroke=p["status"]["error"], mono=True))

    d.label(30, 356, "Everything analytical — choropleth queries, indicator extraction, "
                     "aggregation — runs on the server in both modes.",
            size=11.5, color=p["ink"]["muted"])
    d.label(30, 374, "Neither mode is an offline mode: the backend is always required.",
            size=11.5, color=p["ink"]["muted"])
    return d.render()


def view_modes(p: dict) -> str:
    d = Diagram(900, 330, p, title="Four ways to read the same data",
                subtitle="Every pane can independently show any of these for its chosen factor and scenario")
    modes = [
        ("Map", ["Choropleth over", "catchment polygons", "Swipe to compare"], p["blue"]["100"], p["blue"]["700"]),
        ("Chart", ["Line or boxplot", "across a group", "of related factors"], p["amber"]["100"], p["amber"]["700"]),
        ("Dial", ["Single value against", "its target range", "Green = in range"], p["status"]["successTint"], p["status"]["success"]),
        ("Table", ["Per-catchment rows", "with area weighting", "and contributions"], p["surface"]["cloud"], p["brand"]["grey"]),
    ]
    x, w, gap = 30, 200, 22
    for i, (title, lines, fill, stroke) in enumerate(modes):
        d.box(Box(x + i * (w + gap), 90, w, 130, title, lines, fill=fill, stroke=stroke))
    d.label(30, 258, "The factor selector changes with the mode: chart view offers factors flagged "
                     "graphable, while map, dial and table offer those flagged mappable.",
            size=11.5, color=p["ink"]["muted"])
    d.label(30, 278, "Dial mode additionally requires the factor to declare a dial chart type.",
            size=11.5, color=p["ink"]["muted"])
    return d.render()


# ---------------------------------------------------------------------------
# User manual
# ---------------------------------------------------------------------------


def install_platforms(p: dict) -> str:
    d = Diagram(880, 330, p, title="Supported platforms",
                subtitle="A single self-contained binary per platform, plus native installers")
    cols = ["Portable binary", "Native package", "WebView engine"]
    rows = ["Linux", "macOS", "Windows"]
    cells = {
        (0, 0): ("tar.gz / AppImage", p["blue"]["100"]),
        (0, 1): (".deb / .rpm / snap", p["blue"]["100"]),
        (0, 2): ("WebKit2GTK 4.1", p["amber"]["100"]),
        (1, 0): ("universal binary", p["blue"]["100"]),
        (1, 1): (".dmg", p["blue"]["100"]),
        (1, 2): ("WKWebView (system)", p["status"]["successTint"]),
        (2, 0): (".exe", p["blue"]["100"]),
        (2, 1): (".msi", p["blue"]["100"]),
        (2, 2): ("Edge WebView2", p["status"]["successTint"]),
    }
    d.matrix(30, 108, cols, rows, cells, cw=200, ch=46, label_w=120)
    d.label(30, 268, "Amber: WebKit2GTK is not bundled on Linux and must be installed separately.",
            size=11.5, color=p["ink"]["muted"])
    d.label(30, 288, "The .deb and .rpm packages declare it as a dependency; portable binaries and "
                     "AppImages do not.", size=11.5, color=p["ink"]["muted"])
    return d.render()


def datapack_install(p: dict) -> str:
    d = Diagram(1000, 300, p, title="Installing a data pack",
                subtitle="What happens between choosing an archive and seeing a map")
    steps = [
        ("Choose archive", [".zip or .7z"]),
        ("Validate", ["manifest and", "archive entries"]),
        ("Back up sites", ["existing sites and", "images preserved"]),
        ("Extract", ["progress reported", "to the setup guide"]),
        ("Reload stores", ["tiles, GeoPackage", "and site store"]),
    ]
    x, w, gap = 26, 178, 16
    for i, (title, lines) in enumerate(steps):
        d.step(x + i * (w + gap), 96, w, 88, i + 1, title, lines)
        if i < len(steps) - 1:
            sx = x + i * (w + gap) + w
            d.arrow(sx + 2, 140, sx + gap - 2, 140)
    d.box(Box(26, 210, 948, 52, "Extraction is guarded against archive path traversal",
              ["both the .zip and .7z extractors reject entries that escape the destination"],
              fill=p["status"]["successTint"], stroke=p["status"]["success"]))
    return d.render()


def site_creation_methods(p: dict) -> str:
    d = Diagram(940, 380, p, title="Four ways to define a study area",
                subtitle="All four converge on the same server-side spatial query")
    methods = [
        ("Draw", ["Click points on", "the map by hand"], p["blue"]["100"], p["blue"]["700"]),
        ("Catchments", ["Click or box-select", "whole catchments"], p["blue"]["100"], p["blue"]["700"]),
        ("Shapefile", ["Upload a .zip with", ".shp, .shx and .dbf"], p["amber"]["100"], p["amber"]["700"]),
        ("GeoJSON", ["Drop a .geojson", "or .json file"], p["amber"]["100"], p["amber"]["700"]),
    ]
    x, w, gap = 30, 208, 20
    for i, (title, lines, fill, stroke) in enumerate(methods):
        d.box(Box(x + i * (w + gap), 88, w, 96, title, lines, fill=fill, stroke=stroke))
        d.arrow(x + i * (w + gap) + w / 2, 190, 470, 232, curve=10)

    d.box(Box(250, 236, 440, 62, "Server-side spatial query",
              ["dissolve · area · bounding box · catchment membership · AOI fractions"],
              fill=p["status"]["successTint"], stroke=p["status"]["success"]))
    d.box(Box(250, 316, 440, 44, "A site: boundary + indicators + view layout",
              fill=p["surface"]["white"], stroke=p["blue"]["500"]))
    d.arrow(470, 300, 470, 312)
    return d.render()


def site_lifecycle(p: dict) -> str:
    d = Diagram(880, 300, p, title="The life of a site",
                subtitle="What you can do with a study area once it exists")
    d.box(Box(340, 88, 200, 56, "Site", ["boundary + indicators"],
              fill=p["blue"]["100"], stroke=p["blue"]["700"]))
    actions = [
        (40, 190, "Open", "load into the map view"),
        (250, 190, "Edit", "title, description, boundary"),
        (460, 190, "Clone", "copy under a new name"),
        (670, 190, "Delete", "permanent"),
    ]
    for x, y, title, sub in actions:
        colour = p["status"]["error"] if title == "Delete" else p["blue"]["500"]
        fill = p["status"]["errorTint"] if title == "Delete" else p["surface"]["white"]
        d.box(Box(x, y, 170, 56, title, [sub], fill=fill, stroke=colour))
        d.arrow(440, 148, x + 85, y - 4, curve=18)
    d.label(30, 278, "Demo sites are read-only: they never offer edit, clone or delete.",
            size=11.5, color=p["ink"]["muted"])
    return d.render()


def grid_view(p: dict) -> str:
    d = Diagram(900, 340, p, title="Single and grid view",
                subtitle="Panes are independent — each has its own factor, scenario and view mode")
    d.label(60, 92, "Single view", size=13, weight="700")
    d.panes(40, 104, 320, 190, 1, 1, ["one pane, indicator panel open"])
    d.label(520, 92, "Grid view — 2 or 3 columns", size=13, weight="700")
    d.panes(500, 104, 360, 190, 3, 2,
            ["Map", "Chart", "Dial", "Table", "Map", "Chart"])
    d.arrow(372, 200, 492, 200, label="maximise / restore", curve=0)
    d.label(40, 318, "Panes can be added and removed; the column toggle and your per-pane "
                     "selections persist between sessions.",
            size=11.5, color=p["ink"]["muted"])
    return d.render()


def swipe_comparison(p: dict) -> str:
    d = Diagram(880, 330, p, title="Comparing two scenarios",
                subtitle="One map, split by a draggable divider")
    d.swipe(60, 96, 760, 150, "Left scenario", "Right scenario")
    d.label(60, 282, "Both halves share one viewport, so panning and zooming keep them aligned. "
                     "Choose the scenario and factor for each side independently in the indicator panel.",
            size=11.5, color=p["ink"]["muted"])
    d.legend(60, 306, [
        (p["blue"]["300"], "reference — historical baseline"),
        (p["amber"]["300"], "current — observed today"),
        (p["status"]["successTint"], "future — your edited targets"),
    ])
    return d.render()


def indicator_cascade(p: dict) -> str:
    d = Diagram(940, 360, p, title="Editing a target",
                subtitle="Changing one ideal value recalculates everything downstream of it")
    d.box(Box(30, 96, 200, 60, "You edit an ideal value", ["e.g. tree cover"],
              fill=p["amber"]["100"], stroke=p["amber"]["700"]))
    d.arrow(232, 126, 292, 126)
    d.box(Box(294, 96, 210, 60, "Server recalculates", ["ecological workflows"],
              fill=p["blue"]["100"], stroke=p["blue"]["700"]))
    d.arrow(506, 126, 566, 126)
    d.box(Box(568, 78, 342, 46, "Dependent factors update", fill=p["surface"]["white"], stroke=p["blue"]["500"]))
    d.box(Box(568, 132, 342, 46, "Warnings re-evaluated", fill=p["surface"]["white"], stroke=p["blue"]["500"]))

    d.box(Box(30, 200, 880, 56, "The future scenario is the reference values overlaid with your edits",
              ["everything you have not changed keeps its computed value"],
              fill=p["status"]["successTint"], stroke=p["status"]["success"]))
    d.label(30, 300, "Warnings appear when a target becomes ecologically implausible — for example "
                     "herbivore consumption exceeding available biomass.",
            size=11.5, color=p["ink"]["muted"])
    d.label(30, 320, "Reset returns ideal values to current at any time.",
            size=11.5, color=p["ink"]["muted"])
    return d.render()


def first_run(p: dict) -> str:
    d = Diagram(980, 300, p, title="First run",
                subtitle="What the application does the very first time you start it")
    d.box(Box(30, 92, 200, 56, "Launch", ["binary or nix run"],
              fill=p["surface"]["white"], stroke=p["blue"]["500"]))
    d.arrow(232, 120, 288, 120)
    d.box(Box(290, 92, 220, 56, "Look for data", ["tiles and GeoPackage"],
              fill=p["surface"]["white"], stroke=p["blue"]["500"]))
    d.arrow(512, 120, 568, 120)
    d.box(Box(570, 62, 200, 56, "Found", ["straight to the map"],
              fill=p["status"]["successTint"], stroke=p["status"]["success"]))
    d.box(Box(570, 130, 200, 56, "Not found", ["Setup Guide appears"],
              fill=p["amber"]["100"], stroke=p["amber"]["700"]))
    d.arrow(772, 158, 828, 158)
    d.box(Box(830, 130, 130, 56, "Install a", ["data pack"],
              fill=p["surface"]["white"], stroke=p["amber"]["700"]))
    d.label(30, 230, "Four guided tours are available from the demo sites — Africa, Munywana, "
                     "Shai Hills and Viphya — each walking through a different part of the workflow.",
            size=11.5, color=p["ink"]["muted"])
    d.label(30, 250, "Demo sites are read-only, so a tour can never damage your own work.",
            size=11.5, color=p["ink"]["muted"])
    return d.render()


# ---------------------------------------------------------------------------
# Administrator and developer
# ---------------------------------------------------------------------------


def validation_flow(p: dict) -> str:
    d = Diagram(960, 340, p, title="What check-data checks",
                subtitle="Each group corresponds to something the Go runtime actually opens")
    groups = [
        ("GeoPackage", ["tables · join keys", "spatial index"], p["status"]["errorTint"], p["status"]["error"]),
        ("Map tiles", ["archive readable", "tileset named africa"], p["status"]["errorTint"], p["status"]["error"]),
        ("Metadata", ["ColumnName matched", "against the data"], p["status"]["errorTint"], p["status"]["error"]),
        ("Lookups", ["three CSVs with", "their key columns"], p["amber"]["100"], p["amber"]["700"]),
        ("Directories", ["sites, images,", "walkthroughs, demo"], p["blue"]["100"], p["blue"]["700"]),
        ("Content that", ["does not belong", "here"], p["surface"]["cloud"], p["brand"]["grey"]),
    ]
    x, w, gap = 30, 145, 12
    for i, (title, lines, fill, stroke) in enumerate(groups):
        d.box(Box(x + i * (w + gap), 92, w, 92, title, lines, fill=fill, stroke=stroke))

    d.box(Box(30, 214, 290, 56, "exit 0 — no errors",
              fill=p["status"]["successTint"], stroke=p["status"]["success"]))
    d.box(Box(336, 214, 290, 56, "exit 1 — will not work correctly",
              fill=p["status"]["errorTint"], stroke=p["status"]["error"]))
    d.box(Box(642, 214, 288, 56, "exit 2 — directory or tool missing",
              fill=p["surface"]["cloud"], stroke=p["brand"]["grey"]))
    d.label(30, 300, "Exit status makes the tool usable as a deployment gate: "
                     "nix run .#check-data -- /srv/data || exit 1",
            size=11.5, color=p["ink"]["muted"], mono=False)
    return d.render()


def deployment_topology(p: dict) -> str:
    d = Diagram(920, 400, p, title="Server deployment",
                subtitle="How a hosted instance is put together")
    d.box(Box(30, 96, 180, 56, "Browser", ["any user"], fill=p["surface"]["white"], stroke=p["blue"]["500"]))
    d.arrow(212, 124, 268, 124, label="443")
    d.box(Box(270, 96, 200, 56, "nginx", ["TLS termination"],
              fill=p["blue"]["100"], stroke=p["blue"]["700"]))
    d.arrow(472, 124, 528, 124, label="proxy")
    d.box(Box(530, 96, 220, 56, "decision-theatre", ["--headless"],
              fill=p["blue"]["100"], stroke=p["blue"]["700"]))
    d.arrow(640, 154, 640, 194)
    d.box(Box(500, 198, 280, 56, "Data directory", ["tiles · GeoPackage · lookups"],
              fill=p["surface"]["cloud"], stroke=p["brand"]["grey"], mono=False))

    d.box(Box(30, 280, 860, 82, "nginx proxies every path with no denylist",
              ["Destructive, unauthenticated endpoints are reachable: /api/datapack/install "
               "removes the data",
               "directory; /api/dialog/open-file opens a window on the host. Deny these "
               "until the hardening tickets land."],
              fill=p["status"]["errorTint"], stroke=p["status"]["error"]))
    return d.render()


def client_server_boundary(p: dict) -> str:
    d = Diagram(940, 420, p, title="What belongs where",
                subtitle="The rule that keeps the study area out of the browser")

    d.lane(30, 84, 420, 250, "Client", fill=p["blue"]["100"], stroke=p["blue"]["300"])
    for i, (t, s) in enumerate([
        ("Digitising a polygon", "vertices, preview, handles"),
        ("The site definition", "geometry, catchment ids"),
        ("User-set values", "sparse overrides only"),
        ("Rendering", "tiles and paint expressions"),
    ]):
        d.box(Box(52, 120 + i * 52, 376, 44, t, [s],
                  fill=p["surface"]["white"], stroke=p["blue"]["500"]))

    d.lane(490, 84, 420, 250, "Server", fill=p["status"]["successTint"], stroke=p["status"]["success"])
    for i, (t, s) in enumerate([
        ("Dissolve and area", "polyclip, indexed queries"),
        ("Catchment membership", "which catchments, what fraction"),
        ("Aggregation", "area-weighted means"),
        ("Recalculation", "ecological cascade"),
    ]):
        d.box(Box(512, 120 + i * 52, 376, 44, t, [s],
                  fill=p["surface"]["white"], stroke=p["status"]["success"]))

    d.arrow(430, 210, 488, 210, label="polygon or ids")
    d.arrow(488, 258, 430, 258, label="geometry, area, fractions")

    d.box(Box(30, 350, 880, 52, "Anything that scales with the size of the study area does not belong in the browser",
              ["one polygon is a few kilobytes; the catchment matrix is tens of megabytes"],
              fill=p["amber"]["100"], stroke=p["amber"]["700"]))
    return d.render()


def dev_workflow(p: dict) -> str:
    d = Diagram(980, 300, p, title="Development loop",
                subtitle="From a clean checkout to a running application")
    steps = [
        ("nix develop", ["enter the shell"]),
        ("make dev-all", ["backend + frontend", "with live reload"]),
        ("Edit", ["Go or TypeScript"]),
        ("make test-all", ["Go and frontend tests"]),
        ("make build", ["frontend, docs,", "then the binary"]),
    ]
    x, w, gap = 26, 178, 16
    for i, (title, lines) in enumerate(steps):
        d.step(x + i * (w + gap), 96, w, 88, i + 1, title, lines)
        if i < len(steps) - 1:
            sx = x + i * (w + gap) + w
            d.arrow(sx + 2, 140, sx + gap - 2, 140)
    d.box(Box(26, 212, 948, 52, "The frontend must be built before the backend",
              ["internal/server/static/ is an embed target and is not committed — "
               "go build fails without it"],
              fill=p["amber"]["100"], stroke=p["amber"]["700"]))
    return d.render()


def data_prep_pipeline(p: dict) -> str:
    d = Diagram(1000, 330, p, title="Preparing data",
                subtitle="From source files to something the application can serve")
    d.box(Box(30, 96, 200, 76, "Source data", ["catchments.gpkg", "current/reference CSVs"],
              fill=p["surface"]["cloud"], stroke=p["brand"]["grey"], mono=True))
    d.arrow(232, 134, 292, 134, label="make geopackage")
    d.box(Box(294, 96, 200, 76, "datapack.gpkg", ["scenario tables", "domain ranges, r-tree"],
              fill=p["blue"]["100"], stroke=p["blue"]["700"], mono=True))
    d.box(Box(294, 196, 200, 62, "africa.mbtiles", ["tippecanoe via", "gpkg_to_mbtiles.sh"],
              fill=p["blue"]["100"], stroke=p["blue"]["700"], mono=True))
    d.arrow(496, 134, 556, 150)
    d.arrow(496, 226, 556, 172)
    d.box(Box(558, 122, 200, 76, "data/ directory", ["plus metadata.csv", "and the lookups"],
              fill=p["status"]["successTint"], stroke=p["status"]["success"], mono=True))
    d.arrow(760, 160, 820, 160, label="make datapack")
    d.box(Box(822, 122, 158, 76, "Data pack", [".zip for", "distribution"],
              fill=p["amber"]["100"], stroke=p["amber"]["700"]))
    d.label(30, 300, "Validate before shipping: nix run .#check-data — it reports missing "
                     "requirements and content that should not be in a distributed pack.",
            size=11.5, color=p["ink"]["muted"])
    return d.render()


def quality_gates(p: dict) -> str:
    d = Diagram(980, 340, p, title="Quality gates",
                subtitle="What a change passes through between a working tree and main")
    gates = [
        ("Format", ["gofmt", "tsc --noEmit"], p["blue"]["100"], p["blue"]["700"], True),
        ("Lint", ["golangci-lint", "eslint"], p["amber"]["100"], p["amber"]["700"], False),
        ("Test", ["go test -race", "vitest"], p["blue"]["100"], p["blue"]["700"], True),
        ("Scan", ["gitleaks, trufflehog", "trivy"], p["blue"]["100"], p["blue"]["700"], True),
        ("Build", ["nix build", "--version check"], p["status"]["successTint"], p["status"]["success"], True),
    ]
    x, w, gap = 26, 178, 16
    for i, (title, lines, fill, stroke, ok) in enumerate(gates):
        d.box(Box(x + i * (w + gap), 96, w, 84, title, lines, fill=fill, stroke=stroke))
        if i < len(gates) - 1:
            sx = x + i * (w + gap) + w
            d.arrow(sx + 2, 138, sx + gap - 2, 138)

    d.box(Box(26, 206, 948, 56, "Two gates are not fully closed today",
              ["Lint runs Go only — no eslint configuration exists. Nothing verifies gofmt in CI, "
               "and one scan job fails on every run."],
              fill=p["amber"]["100"], stroke=p["amber"]["700"]))
    d.label(26, 296, "There are no pre-commit hooks, so every gate above is server-side: a problem is "
                     "found after the push, not before it.",
            size=11.5, color=p["ink"]["muted"])
    return d.render()


def support_channels(p: dict) -> str:
    d = Diagram(880, 300, p, title="Where to go for what",
                subtitle="Choosing the right channel gets you an answer faster")
    routes = [
        ("Using the app", ["User Manual", "and User Guide"], p["blue"]["100"], p["blue"]["700"]),
        ("Data problems", ["Administrator Guide", "run check-data first"], p["amber"]["100"], p["amber"]["700"]),
        ("A defect", ["GitHub issues", "include check-data output"], p["status"]["errorTint"], p["status"]["error"]),
        ("Contributing", ["Developer Guide", "then open a pull request"], p["status"]["successTint"], p["status"]["success"]),
    ]
    x, w, gap = 30, 200, 20
    for i, (title, lines, fill, stroke) in enumerate(routes):
        d.box(Box(x + i * (w + gap), 96, w, 96, title, lines, fill=fill, stroke=stroke))
    d.label(30, 232, "For anything involving a blank map or missing indicators, the output of "
                     "check-data will usually identify the cause on its own.",
            size=11.5, color=p["ink"]["muted"])
    d.label(30, 252, "Attach it to the report — it names the file and the code path involved.",
            size=11.5, color=p["ink"]["muted"])
    return d.render()


def partners(p: dict) -> str:
    d = Diagram(900, 300, p, title="Who builds this",
                subtitle="Research direction, engineering and funding")
    d.box(Box(30, 100, 250, 96, "Research and data",
              ["Catchment science, scenario", "modelling, indicator definitions"],
              fill=p["blue"]["100"], stroke=p["blue"]["700"]))
    d.box(Box(325, 100, 250, 96, "Engineering",
              ["Kartoza — application,", "tooling and documentation"],
              fill=p["amber"]["100"], stroke=p["amber"]["700"]))
    d.box(Box(620, 100, 250, 96, "Funding and partnership",
              ["Institutional support", "and sustained development"],
              fill=p["status"]["successTint"], stroke=p["status"]["success"]))
    d.arrow(282, 148, 323, 148)
    d.arrow(577, 148, 618, 148)
    d.label(30, 240, "The software is open source under GPL-3.0. Sponsorship supports continued "
                     "maintenance rather than buying a licence.",
            size=11.5, color=p["ink"]["muted"])
    return d.render()


# ---------------------------------------------------------------------------
# Learning path — one "you are here" diagram per tutorial step
# ---------------------------------------------------------------------------

# (phase, [step titles]) — order defines the learning path. The step pages are
# generated from the same list in the documentation, so the diagram and the
# navigation cannot disagree about the order or the count.
JOURNEY = [
    ("Get started", ["Open the dashboard", "Find your way around",
                     "Take a guided tour"]),
    ("Explore the data", ["Open the map", "Choose what to show",
                          "Compare two scenarios", "Identify a catchment",
                          "Read the data four ways", "Work with several panes"]),
    ("Build your own", ["Define a site boundary", "Name and save your site",
                        "Review your indicators", "Set target values",
                        "Refine a boundary"]),
]


def journey(p: dict, current: int) -> str:
    """Draw the whole path with step `current` (1-based) highlighted."""
    flat = [(ph, s) for ph, steps in JOURNEY for s in steps]
    total = len(flat)

    lane_gap, pad = 14, 26
    pill_h, pill_gap = 34, 6
    top = 84
    # Lay each phase out as its own row so long phases wrap naturally.
    width = 1000
    inner = width - pad * 2

    rows = []
    for phase, steps in JOURNEY:
        rows.append((phase, steps))
    height = top + sum(pill_h + 30 for _ in rows) + lane_gap * len(rows) + 40

    d = Diagram(width, height, p,
                title=f"Step {current} of {total}",
                subtitle="Where this page sits in the guide")

    n = 0
    y = top
    for phase, steps in rows:
        d.label(pad, y + 12, phase.upper(), size=10.5, weight="700",
                color=p["ink"]["muted"])
        pw = (inner - pill_gap * (len(steps) - 1)) / len(steps)
        for col, s in enumerate(steps):
            n += 1
            x = pad + col * (pw + pill_gap)
            done = n < current
            here = n == current
            if here:
                fill, stroke, text = p["blue"]["500"], p["blue"]["900"], "#ffffff"
            elif done:
                fill, stroke, text = p["status"]["successTint"], p["status"]["success"], p["ink"]["default"]
            else:
                fill, stroke, text = p["surface"]["cloud"], p["ink"]["rule"], p["ink"]["muted"]
            d.parts.append(
                f'<rect x="{x:.1f}" y="{y + 20:.1f}" width="{pw:.1f}" height="{pill_h:.1f}" '
                f'rx="{pill_h/2:.1f}" fill="{fill}" stroke="{stroke}" stroke-width="1.4"/>'
            )
            # Number badge, then the title beside it.
            d.parts.append(
                f'<circle cx="{x + 17:.1f}" cy="{y + 20 + pill_h/2:.1f}" r="10" '
                f'fill="{stroke}"/>'
                f'<text x="{x + 17:.1f}" y="{y + 20 + pill_h/2 + 3.5:.1f}" text-anchor="middle" '
                f'font-family="{p["font"]["sans"]}" font-size="10.5" font-weight="800" '
                f'fill="#ffffff">{n}</text>'
            )
            label = s if len(s) <= 24 else s[:22] + "…"
            d.label(x + 32, y + 20 + pill_h / 2 + 4, label, size=10.5,
                    color=text, weight="700" if here else "400")
        y += pill_h + 30 + lane_gap

    d.legend(pad, height - 20, [
        (p["status"]["successTint"], "completed"),
        (p["blue"]["500"], "you are here"),
        (p["surface"]["cloud"], "still to come"),
    ])
    return d.render()


ALL = {
    "quality-gates.svg": quality_gates,
    "support-channels.svg": support_channels,
    "partners.svg": partners,
    "user-journey.svg": user_journey,
    "runtime-modes.svg": runtime_modes,
    "view-modes.svg": view_modes,
    "install-platforms.svg": install_platforms,
    "datapack-install.svg": datapack_install,
    "site-creation-methods.svg": site_creation_methods,
    "site-lifecycle.svg": site_lifecycle,
    "grid-view.svg": grid_view,
    "swipe-comparison.svg": swipe_comparison,
    "indicator-cascade.svg": indicator_cascade,
    "first-run.svg": first_run,
    "validation-flow.svg": validation_flow,
    "deployment-topology.svg": deployment_topology,
    "client-server-boundary.svg": client_server_boundary,
    "dev-workflow.svg": dev_workflow,
    "data-prep-pipeline.svg": data_prep_pipeline,
}
