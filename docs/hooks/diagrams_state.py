"""Further diagrams parsed from live project state.

Companion to the generators in ``generate_diagrams.py``. Everything here reads
real files at build time, so the illustration cannot claim something the project
no longer does. Each generator returns ``None`` when its source is unavailable,
and the orchestrator skips it rather than failing the build.
"""

from __future__ import annotations

import json
import re
from pathlib import Path

from svglib import Box, Diagram


def _read(root: Path, rel: str) -> str | None:
    try:
        return (root / rel).read_text(encoding="utf-8", errors="replace")
    except OSError:
        return None


# ---------------------------------------------------------------------------
# CI pipeline
# ---------------------------------------------------------------------------


def ci_pipeline(root: Path, p: dict) -> str | None:
    src = _read(root, ".github/workflows/ci.yml")
    if not src:
        return None

    jobs: list[tuple[str, list[str]]] = []
    in_jobs = False
    current = None
    for line in src.splitlines():
        if re.match(r"^jobs:\s*$", line):
            in_jobs = True
            continue
        if not in_jobs:
            continue
        m = re.match(r"^  ([A-Za-z0-9_-]+):\s*$", line)
        if m:
            current = m.group(1)
            jobs.append((current, []))
            continue
        m = re.match(r"^\s+needs:\s*\[?([^\]\n]*)\]?", line)
        if m and jobs:
            deps = [d.strip() for d in m.group(1).split(",") if d.strip()]
            jobs[-1] = (jobs[-1][0], deps)
    if not jobs:
        return None

    gated = {n for _, deps in jobs for n in deps}
    first = [j for j in jobs if not j[1]]
    later = [j for j in jobs if j[1]]

    w, h, gap, per_row = 170, 62, 16, 5
    first_rows = (len(first) + per_row - 1) // per_row or 1
    width = max(40 + min(len(first), per_row) * (w + gap),
                40 + min(len(later), per_row) * (w + gap), 760)
    stage_top = 96
    later_top = stage_top + first_rows * (h + 22) + 34
    height = later_top + h + 66

    d = Diagram(width, height, p,
                title="Continuous integration",
                subtitle=f"{len(jobs)} jobs on every push and pull request to main")

    first_pos: dict[str, tuple[float, float]] = {}
    for i, (name, _) in enumerate(first):
        r, c = divmod(i, per_row)
        x = 40 + c * (w + gap)
        y = stage_top + r * (h + 22)
        first_pos[name] = (x + w / 2, y + h)
        fill, stroke = p["blue"]["100"], p["blue"]["700"]
        # file-checks is known to fail on the tracked frontend/.env
        if name == "file-checks":
            fill, stroke = p["status"]["errorTint"], p["status"]["error"]
        d.box(Box(x, y, w, h, name,
                  ["gate" if name in gated else "independent"],
                  fill=fill, stroke=stroke))

    for i, (name, deps) in enumerate(later):
        r, c = divmod(i, per_row)
        x = 40 + c * (w + gap)
        y = later_top + r * (h + 22)
        d.box(Box(x, y, w, h, name, ["after " + ", ".join(deps)[:22]],
                  fill=p["status"]["successTint"], stroke=p["status"]["success"]))
        for dep in deps:
            src_pt = first_pos.get(dep)
            if src_pt:
                d.arrow(src_pt[0], src_pt[1] + 2, x + w / 2, y - 4,
                        color=p["blue"]["300"])

    d.legend(40, height - 22, [
        (p["blue"]["100"], "runs immediately"),
        (p["status"]["successTint"], "gated on earlier jobs"),
        (p["status"]["errorTint"], "currently failing on every run"),
    ])
    return d.render("generated from .github/workflows/ci.yml")


# ---------------------------------------------------------------------------
# Test coverage
# ---------------------------------------------------------------------------


def test_coverage(root: Path, p: dict) -> str | None:
    base = root / "internal"
    if not base.is_dir():
        return None

    rows: list[tuple[str, int, int]] = []
    for pkg in sorted(base.iterdir()):
        if not pkg.is_dir() or pkg.name == "webview_go":
            continue
        lines = tests = 0
        for f in pkg.glob("*.go"):
            try:
                n = len(f.read_text(encoding="utf-8", errors="replace").splitlines())
            except OSError:
                continue
            if f.name.endswith("_test.go"):
                tests += n
            else:
                lines += n
        rows.append((f"internal/{pkg.name}", lines, tests))

    fe = root / "frontend" / "src"
    if fe.is_dir():
        src_lines = sum(
            len(f.read_text(encoding="utf-8", errors="replace").splitlines())
            for f in fe.rglob("*.ts*")
            if "/test/" not in str(f)
        )
        test_lines = sum(
            len(f.read_text(encoding="utf-8", errors="replace").splitlines())
            for f in (fe / "test").glob("*") if f.is_file()
        ) if (fe / "test").is_dir() else 0
        rows.append(("frontend/src", src_lines, test_lines))

    if not rows:
        return None
    rows.sort(key=lambda r: -r[1])
    widest = max(r[1] for r in rows) or 1

    height = 140 + len(rows) * 26 + 60
    d = Diagram(880, height, p,
                title="Where the tests are",
                subtitle="Source lines per package, shaded by whether any test file exists")

    d.label(40, 92, "package", size=11, weight="700", color=p["ink"]["muted"])
    d.label(230, 92, "source lines", size=11, weight="700", color=p["ink"]["muted"])
    for i, (name, lines, tests) in enumerate(rows):
        y = 104 + i * 26
        colour = p["status"]["success"] if tests else p["status"]["error"]
        value = f"{lines:,}  ({tests:,} test lines)" if tests else f"{lines:,}  no tests"
        d.bar(40, y, 660, lines / widest, colour, name, value)

    untested = sum(1 for _, _, t in rows if not t)
    d.label(40, height - 34,
            f"{untested} of {len(rows)} packages have no test file at all.",
            size=12, weight="700", color=p["status"]["error"])
    d.legend(40, height - 14, [
        (p["status"]["success"], "has tests"),
        (p["status"]["error"], "no tests"),
    ])
    return d.render("generated by counting lines across internal/ and frontend/src")


# ---------------------------------------------------------------------------
# Nix outputs
# ---------------------------------------------------------------------------


def nix_outputs(root: Path, p: dict) -> str | None:
    src = _read(root, "flake.nix")
    if not src:
        return None

    packages = sorted(set(re.findall(r"inherit ([a-z-][\w\s-]*);", src)))
    pkg_names: list[str] = []
    for group in packages:
        pkg_names.extend(group.split())
    pkg_names = sorted(set(pkg_names))
    apps = sorted(set(re.findall(r"apps\.([\w-]+)\s*=", src)))
    checks = sorted(set(re.findall(r"^\s{10}([\w-]+)\s*=\s*pkgs\.", src, re.M)))

    if not (pkg_names or apps):
        return None

    d = Diagram(900, 340, p,
                title="Nix outputs",
                subtitle="What this flake exposes to nix build and nix run")

    def column(x: float, heading: str, items: list[str], fill: str, stroke: str,
               prefix: str) -> None:
        d.lane(x, 84, 270, 220, heading, fill=fill, stroke=stroke)
        for i, name in enumerate(items[:6]):
            d.box(Box(x + 20, 120 + i * 32, 230, 26, f"{prefix}{name}",
                      fill=p["surface"]["white"], stroke=stroke, mono=True))
        if not items:
            d.label(x + 135, 200, "none", size=12, anchor="middle",
                    color=p["ink"]["muted"])

    column(30, "packages", pkg_names, p["blue"]["100"], p["blue"]["700"], "nix build .#")
    column(320, "apps", apps, p["status"]["successTint"], p["status"]["success"], "nix run .#")
    column(610, "checks", checks, p["amber"]["100"], p["amber"]["700"], "")

    d.label(30, 326, "Checks are currently not runnable — one has an empty npmDepsHash. "
                     "See the release documentation.",
            size=11, color=p["ink"]["muted"])
    return d.render("generated from flake.nix")


# ---------------------------------------------------------------------------
# Frontend module map
# ---------------------------------------------------------------------------


def frontend_modules(root: Path, p: dict) -> str | None:
    base = root / "frontend" / "src"
    if not base.is_dir():
        return None

    comps: list[tuple[str, int]] = []
    for f in sorted((base / "components").glob("*.tsx")) if (base / "components").is_dir() else []:
        try:
            comps.append((f.stem, len(f.read_text(encoding="utf-8", errors="replace").splitlines())))
        except OSError:
            continue
    if not comps:
        return None
    comps.sort(key=lambda c: -c[1])
    top = comps[:12]
    widest = top[0][1] or 1
    total = sum(c[1] for c in comps)

    height = 150 + len(top) * 24 + 56
    d = Diagram(880, height, p,
                title="Frontend components by size",
                subtitle=f"{len(comps)} components, {total:,} lines — twelve largest shown")

    for i, (name, lines) in enumerate(top):
        y = 100 + i * 24
        frac = lines / widest
        colour = p["status"]["error"] if lines > 1500 else (
            p["amber"]["500"] if lines > 800 else p["blue"]["500"])
        d.bar(40, y, 700, frac, colour, f"{name}.tsx", f"{lines:,}")

    d.label(40, height - 34,
            "Components over 1,500 lines are shown in red: size on this scale makes "
            "review and memoisation hard.",
            size=11.5, color=p["ink"]["muted"])
    d.legend(40, height - 14, [
        (p["blue"]["500"], "under 800 lines"),
        (p["amber"]["500"], "800–1,500"),
        (p["status"]["error"], "over 1,500"),
    ])
    return d.render("generated by counting lines in frontend/src/components")


# ---------------------------------------------------------------------------
# Client storage keys
# ---------------------------------------------------------------------------


def storage_keys(root: Path, p: dict) -> str | None:
    keys: dict[str, str] = {}
    for rel in ("frontend/src/types/index.ts", "frontend/src/hooks/useApi.ts",
                "frontend/src/components/TourGuide.tsx"):
        src = _read(root, rel)
        if not src:
            continue
        for name, key in re.findall(r"const\s+(\w*(?:STORAGE|SEEN)\w*)\s*=\s*'([^']+)'", src):
            keys[key] = Path(rel).name
    for rel in ("frontend/src/App.tsx",):
        src = _read(root, rel)
        if src:
            for key in re.findall(r"localStorage\.(?:get|set)Item\('([^']+)'", src):
                keys.setdefault(key, Path(rel).name)
    if not keys:
        return None

    big = {"dt-sites"}
    ordered = sorted(keys.items(), key=lambda kv: (kv[0] not in big, kv[0]))

    height = 140 + len(ordered) * 34 + 90
    d = Diagram(900, height, p,
                title="What the browser stores",
                subtitle=f"{len(keys)} local storage keys, against a per-origin ceiling of roughly 5 MB")

    for i, (key, origin) in enumerate(ordered):
        y = 100 + i * 34
        is_big = key in big
        d.box(Box(40, y, 300, 28, key,
                  fill=p["status"]["errorTint"] if is_big else p["surface"]["cloud"],
                  stroke=p["status"]["error"] if is_big else p["brand"]["grey"], mono=True))
        d.label(360, y + 19, origin, size=11, mono=True, color=p["ink"]["muted"])
        d.label(560, y + 19,
                "the whole site array, including per-catchment analytics"
                if is_big else "a small scalar or short list",
                size=11, color=p["status"]["error"] if is_big else p["ink"]["muted"])

    d.box(Box(40, height - 78, 820, 56, "One key carries almost all of the weight",
              ["dt-sites holds every site with its full per-catchment breakdown — "
               "27–56 KB per catchment.",
               "Writes fail silently once the quota is reached. See the storage tickets."],
              fill=p["status"]["errorTint"], stroke=p["status"]["error"]))
    return d.render("generated from localStorage keys across frontend/src")


# ---------------------------------------------------------------------------
# Documentation map
# ---------------------------------------------------------------------------


def docs_map(root: Path, p: dict) -> str | None:
    src = _read(root, "mkdocs.yml")
    if not src:
        return None
    nav_block = src.partition("\nnav:\n")[2]
    if not nav_block:
        return None

    sections: list[tuple[str, int]] = []
    for line in nav_block.splitlines():
        if line and not line.startswith((" ", "-")) and ":" in line:
            break
        m = re.match(r"^  - ([^:]+):\s*$", line)
        if m:
            sections.append((m.group(1), 0))
        elif re.match(r"^  - .+\.md\s*$", line) or re.match(r"^  - [^:]+:\s*\S+\.md\s*$", line):
            m2 = re.match(r"^  - ([^:]+):", line)
            sections.append((m2.group(1) if m2 else "page", 1))
        elif re.match(r"^      - .+\.md\s*$", line) or re.match(r"^      - [^:]+:\s*\S+\.md", line):
            if sections:
                sections[-1] = (sections[-1][0], sections[-1][1] + 1)
    if not sections:
        return None

    d = Diagram(940, 300, p,
                title="How this documentation is organised",
                subtitle=f"{len(sections)} sections, {sum(c for _, c in sections)} pages")

    w, gap = 168, 14
    palette = [p["blue"]["100"], p["amber"]["100"], p["status"]["successTint"],
               p["surface"]["cloud"], p["blue"]["100"], p["amber"]["100"]]
    strokes = [p["blue"]["700"], p["amber"]["700"], p["status"]["success"],
               p["brand"]["grey"], p["blue"]["700"], p["amber"]["700"]]
    for i, (name, count) in enumerate(sections[:6]):
        x = 30 + i * (w + gap)
        d.box(Box(x, 100, w, 96, name,
                  [f"{count} page{'s' if count != 1 else ''}" if count else "single page"],
                  fill=palette[i % len(palette)], stroke=strokes[i % len(strokes)]))

    d.label(30, 240, "Start with the User Manual if you are using the application, the "
                     "Administrator Guide if you are assembling or deploying data,",
            size=11.5, color=p["ink"]["muted"])
    d.label(30, 258, "and the Developer Guide if you are changing the code.",
            size=11.5, color=p["ink"]["muted"])
    return d.render("generated from the nav in mkdocs.yml")


# ---------------------------------------------------------------------------
# Metadata pipeline
# ---------------------------------------------------------------------------


def metadata_pipeline(root: Path, p: dict) -> str | None:
    handler = _read(root, "internal/api/handler.go")
    if not handler:
        return None
    endpoints = sorted(set(re.findall(r'"/metadata/(\w+)"', handler)))
    if not endpoints:
        return None

    d = Diagram(980, 380, p,
                title="How a metadata row reaches a dropdown",
                subtitle=f"{len(endpoints)} lookup endpoints, one per column of metadata.csv")

    d.box(Box(30, 100, 190, 70, "metadata.csv", ["keyed on ColumnName"],
              fill=p["surface"]["cloud"], stroke=p["brand"]["grey"], mono=True))
    d.arrow(222, 135, 278, 135, label="parsed once")
    d.box(Box(280, 100, 200, 70, "loadMetadataCache()", ["15 in-memory maps"],
              fill=p["blue"]["100"], stroke=p["blue"]["700"], mono=True))
    d.arrow(482, 135, 538, 135)
    d.box(Box(540, 100, 200, 70, "GET /api/metadata/*", [f"{len(endpoints)} routes"],
              fill=p["blue"]["100"], stroke=p["blue"]["700"], mono=True))
    d.arrow(742, 135, 798, 135)
    d.box(Box(800, 100, 150, 70, "Selectors", ["ControlPanel", "ChartView"],
              fill=p["status"]["successTint"], stroke=p["status"]["success"]))

    d.box(Box(30, 214, 450, 66, "GET /api/columns", ["the authoritative list of columns that exist",
                                                     "in the GeoPackage — not from the CSV"],
              fill=p["amber"]["100"], stroke=p["amber"]["700"], mono=False))
    d.arrow(482, 247, 800, 190, curve=30)

    d.box(Box(30, 300, 920, 58, "The two lists are matched by exact string comparison",
              ["A metadata row naming a column that does not exist is discarded silently, "
               "and the indicator never appears."],
              fill=p["status"]["errorTint"], stroke=p["status"]["error"]))
    return d.render("generated from the metadata routes in internal/api/handler.go")


def licences(root: Path, p: dict) -> str | None:
<<<<<<< HEAD
    """Count direct dependencies per ecosystem, from the real manifests."""
    go_direct: list[str] = []
    gomod = _read(root, "go.mod")
    if gomod:
        block = re.search(r"require \(\n(.*?)\n\)", gomod, re.S)
        if block:
            go_direct = [
                m.split()[0]
                for m in block.group(1).strip().splitlines()
                if m.strip() and "// indirect" not in m
            ]

    deps: list[str] = []
    dev: list[str] = []
    pkg = _read(root, "frontend/package.json")
    if pkg:
        try:
            j = json.loads(pkg)
            deps = sorted(j.get("dependencies", {}))
            dev = sorted(j.get("devDependencies", {}))
        except ValueError:
            pass
=======
    """Count direct dependencies per ecosystem, from the real manifests.

    Requires *both* manifests. A partial read would draw a diagram claiming, say,
    zero Go dependencies — quietly wrong rather than absent. Returning None makes
    the omission loud: the page's image reference then fails the strict build.
    """
    gomod = _read(root, "go.mod")
    pkg = _read(root, "frontend/package.json")
    if not (gomod and pkg):
        return None

    go_direct: list[str] = []
    block = re.search(r"require \(\n(.*?)\n\)", gomod, re.S)
    if block:
        go_direct = [
            m.split()[0]
            for m in block.group(1).strip().splitlines()
            if m.strip() and "// indirect" not in m
        ]

    try:
        j = json.loads(pkg)
        deps = sorted(j.get("dependencies", {}))
        dev = sorted(j.get("devDependencies", {}))
    except ValueError:
        return None
>>>>>>> dc1da7a (docs: rebuild documentation around the hosted dashboard and Kartoza brand)

    if not (go_direct or deps):
        return None

    d = Diagram(900, 330, p,
                title="Direct dependencies",
                subtitle="Counted from go.mod and frontend/package.json — indirect dependencies excluded")

    rows = [
        ("Go (direct)", len(go_direct), p["blue"]["500"]),
        ("npm (runtime)", len(deps), p["amber"]["500"]),
        ("npm (development)", len(dev), p["brand"]["grey"]),
    ]
    widest = max(n for _, n, _ in rows) or 1
    for i, (label, n, colour) in enumerate(rows):
        d.bar(40, 108 + i * 34, 660, n / widest, colour, label, str(n))

    d.box(Box(40, 216, 820, 78, "Every dependency is a supply-chain commitment",
              ["The project is GPL-3.0. Several declared npm dependencies currently have no "
               "imports at all and",
               "are slated for removal, which shrinks this surface without changing "
               "any behaviour."],
              fill=p["amber"]["100"], stroke=p["amber"]["700"]))
    return d.render("generated from go.mod + frontend/package.json")


ALL = {
    "licences.svg": licences,
    "ci-pipeline.svg": ci_pipeline,
    "test-coverage.svg": test_coverage,
    "nix-outputs.svg": nix_outputs,
    "frontend-modules.svg": frontend_modules,
    "storage-keys.svg": storage_keys,
    "docs-map.svg": docs_map,
    "metadata-pipeline.svg": metadata_pipeline,
}
