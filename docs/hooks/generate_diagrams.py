"""MkDocs build hook: generate SVG diagrams from live project state.

Diagrams that describe code or configuration are generated here rather than
drawn by hand, so they cannot fall out of step with the thing they describe. Add
a route to ``handler.go`` and the API map redraws on the next build; fix the
version drift and that diagram turns green by itself.

Each generator reads the real source, so a diagram is only ever as current as
the last build. Every generated SVG carries a provenance line naming the file it
was derived from.

Registered in ``mkdocs.yml`` as::

    hooks:
      - docs/hooks/generate_diagrams.py

Failures never break the build: a generator that cannot find its source logs a
warning and is skipped, and the page that embeds it degrades to a missing image
rather than a build error. That matters because the Nix docs derivation may be
given a narrower source tree than a working checkout.
"""

from __future__ import annotations

import json
import logging
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

import diagrams_concept  # noqa: E402
import diagrams_state  # noqa: E402
from svglib import Box, Diagram, load_palette, text_width  # noqa: E402

log = logging.getLogger("mkdocs.hooks.generate_diagrams")

OUT_SUBDIR = Path("assets") / "diagrams" / "generated"


# ---------------------------------------------------------------------------
# Source readers
# ---------------------------------------------------------------------------


def _read(root: Path, rel: str) -> str | None:
    try:
        return (root / rel).read_text(encoding="utf-8", errors="replace")
    except OSError:
        return None


def parse_api_routes(root: Path) -> dict[str, list[tuple[str, str]]]:
    """Group registered routes by their first path segment.

    Reads ``RegisterRoutes`` in the API package (paths are relative to the
    ``/api`` subrouter) and the directly-registered routes in the server.
    """
    groups: dict[str, list[tuple[str, str]]] = {}

    handler = _read(root, "internal/api/handler.go")
    if handler:
        pattern = re.compile(
            r'r\.HandleFunc\(\s*"([^"]+)"\s*,[^)]*\)\s*\.Methods\(([^)]*)\)'
        )
        for path, methods in pattern.findall(handler):
            verbs = " ".join(sorted(set(re.findall(r'"(\w+)"', methods))))
            seg = path.strip("/").split("/")[0] or "root"
            groups.setdefault(f"/api/{seg}", []).append((f"/api{path}", verbs))

    server = _read(root, "internal/server/server.go")
    if server:
        pattern = re.compile(
            r's\.router\.HandleFunc\(\s*"([^"]+)"[^)]*\)\s*\.Methods\(([^)]*)\)'
        )
        for path, methods in pattern.findall(server):
            verbs = " ".join(sorted(set(re.findall(r'"(\w+)"', methods))))
            parts = path.strip("/").split("/")
            seg = "/".join(parts[:2]) if parts[0] == "api" else parts[0]
            groups.setdefault(f"/{seg}", []).append((path, verbs))
        for prefix in re.findall(r's\.router\.PathPrefix\(\s*"([^"]+)"', server):
            groups.setdefault(prefix, []).append((prefix + "*", "GET"))

    return groups


def parse_data_requirements(root: Path) -> list[tuple[str, str, str]]:
    """Return (path, kind, source-file) for everything read from the data dir."""
    found: list[tuple[str, str, str]] = []

    checks = [
        ("internal/geodata/gpkg_store.go", r'filepath\.Join\(dataDir,\s*"([^"]+)"\)', "required"),
        ("internal/api/metadata_cache.go", r'filepath\.Join\(dataDir,\s*"([^"]+)"\)', "required"),
        ("internal/api/lookups.go", r'filepath\.Join\(dataDir,\s*"([^"]+)"\)', "required"),
        ("internal/sites/sites.go", r'filepath\.Join\(dataDir,\s*"([^"]+)"\)', "runtime"),
    ]
    for rel, pattern, kind in checks:
        src = _read(root, rel)
        if not src:
            continue
        for m in re.findall(pattern, src):
            found.append((m, kind, rel))

    server = _read(root, "internal/server/server.go")
    if server:
        for m in re.findall(r'filepath\.Join\(s?\.?cfg\.DataDir,\s*"([^"]+)"', server):
            found.append((m, "optional", "internal/server/server.go"))
        for m in re.findall(r'filepath\.Join\(cfg\.DataDir,\s*"([^"]+)"', server):
            found.append((m, "required", "internal/server/server.go"))

    seen, out = set(), []
    for path, kind, src in found:
        if path not in seen:
            seen.add(path)
            out.append((path, kind, src))
    return out


def parse_go_package_deps(root: Path) -> dict[str, set[str]]:
    """Internal package -> set of internal packages it imports."""
    deps: dict[str, set[str]] = {}
    base = root / "internal"
    if not base.is_dir():
        return deps
    for pkg_dir in sorted(base.iterdir()):
        if not pkg_dir.is_dir() or pkg_dir.name == "webview_go":
            continue
        edges: set[str] = set()
        for gofile in pkg_dir.glob("*.go"):
            if gofile.name.endswith("_test.go"):
                continue
            try:
                src = gofile.read_text(encoding="utf-8", errors="replace")
            except OSError:
                continue
            for imp in re.findall(r'"[^"]*/internal/(\w+)"', src):
                if imp != pkg_dir.name:
                    edges.add(imp)
        deps[pkg_dir.name] = edges
    return deps


def parse_versions(root: Path) -> list[tuple[str, str, str]]:
    """Return (label, value, source) for each place a version is declared."""
    out: list[tuple[str, str, str]] = []

    flake = _read(root, "flake.nix")
    if flake:
        m = re.search(r'version\s*=\s*"([^"]+)"', flake)
        if m:
            out.append(("flake.nix", m.group(1), "version ="))

    pkg = _read(root, "frontend/package.json")
    if pkg:
        try:
            out.append(("frontend/package.json", json.loads(pkg).get("version", "?"), '"version"'))
        except ValueError:
            pass

    mg = _read(root, "main.go")
    if mg:
        m = re.search(r'var\s+version\s*=\s*"([^"]+)"', mg)
        if m:
            out.append(("main.go (build default)", m.group(1), "var version"))

    return out


# ---------------------------------------------------------------------------
# Generators
# ---------------------------------------------------------------------------


def draw_api_routes(groups: dict[str, list[tuple[str, str]]], p: dict) -> str | None:
    if not groups:
        return None
    # Groups holding a single route make for a very tall, sparse diagram. Fold
    # them into one lane so the substantial groups stay legible.
    multi = {k: v for k, v in groups.items() if len(v) > 1}
    singles = [r for k, v in groups.items() if len(v) == 1 for r in v]
    if singles:
        multi["other endpoints"] = singles

    order = sorted(multi.items(), key=lambda kv: (-len(kv[1]), kv[0]))
    cols = 3
    col_w, pad, top = 300, 22, 74
    rows = (len(order) + cols - 1) // cols

    heights = []
    for i in range(rows):
        chunk = order[i * cols:(i + 1) * cols]
        heights.append(max(len(v) for _, v in chunk) * 15 + 42 if chunk else 0)

    width = pad + cols * (col_w + pad)
    height = top + sum(h + pad for h in heights) + 54
    total = sum(len(v) for _, v in groups.items())

    d = Diagram(width, height, p,
                title="HTTP route map",
                subtitle=f"{total} registered routes across {len(groups)} path groups — parsed from the router at build time")

    y = top
    for r in range(rows):
        chunk = order[r * cols:(r + 1) * cols]
        for c, (group, routes) in enumerate(chunk):
            x = pad + c * (col_w + pad)
            h = heights[r]
            is_api = group.startswith("/api")
            d.lane(x, y, col_w, h, group,
                   fill=p["blue"]["100"] if is_api else p["surface"]["cloud"],
                   stroke=p["blue"]["300"] if is_api else p["ink"]["rule"])
            for i, (path, verbs) in enumerate(sorted(routes)):
                ry = y + 36 + i * 15
                d.label(x + 14, ry, path[:38], size=10.5, mono=True,
                        color=p["ink"]["default"])
                d.label(x + col_w - 12, ry, verbs, size=9.5, anchor="end",
                        color=p["blue"]["700"], weight="700")
        y += heights[r] + pad

    d.legend(pad, height - 26, [
        (p["blue"]["100"], "application API"),
        (p["surface"]["cloud"], "tiles, static content and docs"),
    ])
    return d.render("generated from internal/api/handler.go + internal/server/server.go")


def draw_data_requirements(items: list[tuple[str, str, str]], p: dict) -> str | None:
    if not items:
        return None
    hard = [("datapack.gpkg", "required"), ("mbtiles/africa.mbtiles", "required")]
    known = {i[0] for i in items}
    for name, kind in hard:
        if name.split("/")[0] not in known and name not in known:
            items.append((name, kind, "hardcoded"))

    order = {"required": 0, "runtime": 1, "optional": 2}
    items = sorted(items, key=lambda i: (order.get(i[1], 3), i[0]))

    bw, bh, gap = 250, 46, 12
    cols = 3
    rows = (len(items) + cols - 1) // cols
    width = 30 + cols * (bw + gap)
    height = 92 + rows * (bh + gap) + 46

    d = Diagram(width, height, p,
                title="What the application reads from the data directory",
                subtitle="Every path below is dereferenced by name in the Go source")

    colours = {
        "required": (p["status"]["errorTint"], p["status"]["error"]),
        "runtime": (p["blue"]["100"], p["blue"]["700"]),
        "optional": (p["surface"]["cloud"], p["brand"]["grey"]),
    }
    for i, (path, kind, src) in enumerate(items):
        r, c = divmod(i, cols)
        x = 30 + c * (bw + gap)
        y = 92 + r * (bh + gap)
        fill, stroke = colours.get(kind, colours["optional"])
        d.box(Box(x, y, bw, bh, path, [Path(src).name if src != "hardcoded" else "hardcoded name"],
                  fill=fill, stroke=stroke, mono=True))

    d.legend(30, height - 22, [
        (p["status"]["errorTint"], "required — app will not work without it"),
        (p["blue"]["100"], "written at runtime"),
        (p["surface"]["cloud"], "optional"),
    ])
    return d.render("generated from filepath.Join(dataDir, ...) across internal/")


def draw_package_deps(deps: dict[str, set[str]], p: dict) -> str | None:
    if not deps:
        return None
    layers = [
        ["server"],
        ["api"],
        ["geodata", "sites", "tiles"],
        ["config", "httputil"],
    ]
    present = {k for k in deps}
    layers = [[n for n in layer if n in present] for layer in layers]
    layers = [layer for layer in layers if layer]
    stray = sorted(present - {n for layer in layers for n in layer})
    if stray:
        layers.append(stray)

    bw, bh, gapx, gapy = 150, 52, 34, 66
    widest = max(len(layer) for layer in layers)
    width = 60 + widest * (bw + gapx)
    height = 96 + len(layers) * (bh + gapy) + 34

    d = Diagram(width, height, p,
                title="Backend package dependencies",
                subtitle="Internal imports between Go packages, read from the source tree")

    pos: dict[str, Box] = {}
    for li, layer in enumerate(layers):
        row_w = len(layer) * bw + (len(layer) - 1) * gapx
        x0 = (width - row_w) / 2
        y = 96 + li * (bh + gapy)
        for ni, name in enumerate(layer):
            x = x0 + ni * (bw + gapx)
            n_deps = len(deps.get(name, ()))
            pos[name] = d.box(Box(
                x, y, bw, bh, f"internal/{name}",
                [f"{n_deps} internal import{'s' if n_deps != 1 else ''}"],
                fill=p["blue"]["100"] if n_deps else p["surface"]["cloud"],
                stroke=p["blue"]["500"] if n_deps else p["brand"]["grey"],
            ))

    for name, edges in sorted(deps.items()):
        if name not in pos:
            continue
        a = pos[name]
        for target in sorted(edges):
            b = pos.get(target)
            if not b:
                continue
            if b.y > a.y:
                d.arrow(a.cx, a.bottom, b.cx, b.y - 4, color=p["blue"]["300"])
            elif b.y < a.y:
                d.arrow(a.cx, a.y, b.cx, b.bottom + 4, color=p["amber"]["500"])
            else:
                d.arrow(a.right, a.cy, b.x - 4, b.cy, color=p["blue"]["300"])

    d.legend(30, height - 18, [
        (p["blue"]["300"], "imports a lower layer"),
        (p["amber"]["500"], "imports an upper layer (inversion)"),
    ])
    return d.render("generated from imports across internal/*/*.go")


def draw_version_state(versions: list[tuple[str, str, str]], p: dict) -> str | None:
    if not versions:
        return None
    real = [v for _, v, _ in versions if v not in ("dev", "?")]
    agree = len(set(real)) <= 1

    bw, bh, gap = 268, 76, 22
    width = 40 + len(versions) * (bw + gap)
    height = 232

    status = "all declarations agree" if agree else "they disagree"
    d = Diagram(max(width, 640), height, p,
                title="Where the version number is declared",
                subtitle=f"{len(versions)} independent declarations — {status}")

    for i, (label, value, key) in enumerate(versions):
        x = 40 + i * (bw + gap)
        placeholder = value in ("dev", "?")
        if placeholder:
            fill, stroke = p["amber"]["100"], p["amber"]["700"]
        elif agree:
            fill, stroke = p["status"]["successTint"], p["status"]["success"]
        else:
            fill, stroke = p["status"]["errorTint"], p["status"]["error"]
        d.box(Box(x, 92, bw, bh, label, [f"{key} → {value}"],
                  fill=fill, stroke=stroke, mono=False))

    msg = (
        "All declarations agree."
        if agree else
        "These disagree. Nothing reconciles them, so a build's reported version "
        "depends on how it was produced."
    )
    d.label(40, 200, msg, size=12,
            color=p["status"]["success"] if agree else p["status"]["error"],
            weight="700")
    d.label(40, 218, "Placeholder values (amber) are replaced at build time by the release tooling.",
            size=11, color=p["ink"]["muted"])
    return d.render("generated from flake.nix + frontend/package.json + main.go")


# ---------------------------------------------------------------------------
# MkDocs hook entry points
# ---------------------------------------------------------------------------


def on_pre_build(config, **_kwargs) -> None:
    docs_dir = Path(config["docs_dir"])
    root = docs_dir.parent
    palette = load_palette(docs_dir)
    out_dir = docs_dir / OUT_SUBDIR
    out_dir.mkdir(parents=True, exist_ok=True)

    jobs = [
        ("api-routes.svg", lambda: draw_api_routes(parse_api_routes(root), palette)),
        ("data-requirements.svg", lambda: draw_data_requirements(parse_data_requirements(root), palette)),
        ("package-deps.svg", lambda: draw_package_deps(parse_go_package_deps(root), palette)),
        ("version-state.svg", lambda: draw_version_state(parse_versions(root), palette)),
    ]

    # Further state-derived diagrams: each parses its own source.
    jobs += [
        (name, (lambda fn=fn: fn(root, palette)))
        for name, fn in diagrams_state.ALL.items()
    ]

    # Conceptual diagrams: no source to parse, but drawn with the same brand
    # library so the documentation reads as one piece of work.
    jobs += [
        (name, (lambda fn=fn: fn(palette)))
        for name, fn in diagrams_concept.ALL.items()
    ]

    # One "you are here" diagram per tutorial step, from the same ordered list
    # the step pages are generated from.
    total_steps = sum(len(s) for _, s in diagrams_concept.JOURNEY)
    jobs += [
        (f"journey-{i:02d}.svg", (lambda i=i: diagrams_concept.journey(palette, i)))
        for i in range(1, total_steps + 1)
    ]

    written, unchanged, skipped = 0, 0, []
    for name, build in jobs:
        try:
            svg = build()
        except Exception as exc:  # a diagram must never break the docs build
            log.warning("generate_diagrams: %s failed (%s)", name, exc)
            skipped.append(name)
            continue
        if not svg:
            skipped.append(name)
            continue

        # Only touch the file when the content actually differs.
        #
        # These are written inside docs_dir, which is precisely what `mkdocs
        # serve` watches for changes. An unconditional write would retrigger the
        # build, which would write again — an endless reload loop. Diagram output
        # is deterministic (no timestamps or randomness anywhere in the
        # generators), so comparing content is enough to break it: the first
        # build writes, the second finds everything identical, and the watcher
        # goes quiet.
        target = out_dir / name
        try:
            if target.read_text(encoding="utf-8") == svg:
                unchanged += 1
                continue
        except OSError:
            pass  # missing or unreadable — fall through and write it
        target.write_text(svg, encoding="utf-8")
        written += 1

    log.info(
        "generate_diagrams: %d diagram(s) written, %d unchanged, in %s",
        written, unchanged, OUT_SUBDIR,
    )
    if skipped:
        log.warning(
            "generate_diagrams: skipped %s — source files not present in this build tree",
            ", ".join(skipped),
        )
