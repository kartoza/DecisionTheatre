#!/usr/bin/env python3
"""Render a Grype scan as a markdown table for a pull request or release note.

Two things this deliberately does not do:

  - It does not fail the build. A CVE in a system library is a fact to be
    weighed, not automatically a defect in this application, and a scanner that
    blocks every merge on a Negligible finding in glibc trains people to ignore
    it. Gating belongs to an agreed severity policy, not to the first run.
  - It does not editorialise about exploitability. What this container exposes
    is described once, in the impact note below, and the reader judges.

Usage: cve_table.py <grype-json> [--limit N]
Exit status is 0 unless the file cannot be read: see above.
"""
import argparse
import json
import sys
from collections import Counter

SEVERITY_ORDER = {
    "Critical": 0,
    "High": 1,
    "Medium": 2,
    "Low": 3,
    "Negligible": 4,
    "Unknown": 5,
}

SEVERITY_MARK = {
    "Critical": "🔴",
    "High": "🟠",
    "Medium": "🟡",
    "Low": "🔵",
    "Negligible": "⚪",
    "Unknown": "⚪",
}

# What the image actually exposes, so a reader can weigh a finding rather than
# react to its severity label alone. Kept factual and short.
IMPACT = """> **What this image exposes.** It runs the Decision Theatre HTTP server. The
> API is unauthenticated, so a deployment is expected to sit behind a reverse
> proxy that controls access — see `docs/developer-guide/server-deployment.md`.
> The desktop-only routes are absent from the server build entirely. Outbound
> TLS is used for the geocoding proxy. There is no database server and no
> shell in the image."""


def main():
    # argparse rather than walking sys.argv by hand. The hand-rolled version
    # filtered out anything beginning with "--" to find the positional argument,
    # which removed the flag but not its value: `--limit 10 scan.json` left
    # "10" as the first positional, and the script tried to open a file called
    # 10. It also called int() on whatever followed --limit, so a typo produced a
    # traceback instead of a usage message.
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("grype_json", help="grype scan results in JSON form")
    parser.add_argument(
        "--limit",
        type=int,
        default=40,
        help="maximum rows to show before summarising the remainder (default: 40)",
    )
    opts = parser.parse_args()
    limit = opts.limit

    with open(opts.grype_json) as handle:
        data = json.load(handle)

    matches = data.get("matches", []) or []

    rows = []
    for m in matches:
        vuln = m.get("vulnerability", {}) or {}
        artifact = m.get("artifact", {}) or {}
        severity = (vuln.get("severity") or "Unknown").title()
        if severity not in SEVERITY_ORDER:
            severity = "Unknown"
        fix = (vuln.get("fix") or {}).get("versions") or []
        rows.append(
            {
                "id": vuln.get("id", "unknown"),
                "severity": severity,
                "package": artifact.get("name", "unknown"),
                "version": artifact.get("version", "unknown"),
                "fixed_in": ", ".join(fix) if fix else "—",
            }
        )

    counts = Counter(r["severity"] for r in rows)

    if not rows:
        print("**No known vulnerabilities reported.**")
        print()
        print(IMPACT)
        return 0

    print(f"**{len(rows)} findings.**")
    print()
    print("| severity | count |")
    print("|---|---:|")
    for sev in sorted(counts, key=lambda s: SEVERITY_ORDER[s]):
        print(f"| {SEVERITY_MARK[sev]} {sev} | {counts[sev]} |")
    print()

    rows.sort(key=lambda r: (SEVERITY_ORDER[r["severity"]], r["package"], r["id"]))
    shown = rows[:limit]

    print(f"<details><summary>Findings ({len(shown)} of {len(rows)} shown, worst first)</summary>")
    print()
    print("| severity | id | package | version | fixed in |")
    print("|---|---|---|---|---|")
    for r in shown:
        print(
            f"| {SEVERITY_MARK[r['severity']]} {r['severity']} | {r['id']} | "
            f"{r['package']} | {r['version']} | {r['fixed_in']} |"
        )
    if len(rows) > len(shown):
        print()
        print(f"_{len(rows) - len(shown)} further findings omitted; the full scan is attached as an artefact._")
    print()
    print("</details>")
    print()
    print(IMPACT)
    return 0


if __name__ == "__main__":
    sys.exit(main())
