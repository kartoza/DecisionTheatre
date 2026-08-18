#!/usr/bin/env python3
"""Render a syft SBOM as a markdown table for a pull request or release note.

The SBOM itself is the machine-readable artefact; this is the human-readable
view that goes in the comment, so it is deliberately a summary rather than a
dump. A nix-built image's closure runs to hundreds of packages, and a table that
long buries the thing a reader is looking for.

Usage: sbom_table.py <syft-json> [--limit N]
"""
import json
import sys
from collections import Counter


def licenses_of(artifact):
    """syft reports licences as a list of objects, or occasionally as strings."""
    out = []
    for lic in artifact.get("licenses", []) or []:
        if isinstance(lic, dict):
            value = lic.get("value") or lic.get("spdxExpression")
        else:
            value = lic
        if value:
            out.append(str(value))
    return sorted(set(out))


def main():
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    limit = 40
    for i, a in enumerate(sys.argv):
        if a == "--limit" and i + 1 < len(sys.argv):
            limit = int(sys.argv[i + 1])

    if not args:
        print("Usage: sbom_table.py <syft-json> [--limit N]", file=sys.stderr)
        return 2

    with open(args[0]) as handle:
        data = json.load(handle)

    artifacts = data.get("artifacts", []) or []

    # One row per name+version. syft reports a package once per location it was
    # found, and in a nix image that is common — the same store path referenced
    # from several closures.
    seen = {}
    for art in artifacts:
        key = (art.get("name", "unknown"), art.get("version", "unknown"))
        if key not in seen:
            seen[key] = art

    rows = sorted(seen.items(), key=lambda kv: kv[0][0].lower())
    types = Counter(a.get("type", "unknown") for a in seen.values())

    print(f"**{len(rows)} distinct packages** in the image closure.")
    print()
    print("| type | count |")
    print("|---|---:|")
    for kind, count in types.most_common():
        print(f"| {kind} | {count} |")
    print()

    shown = rows[:limit]
    print(f"<details><summary>Packages ({len(shown)} of {len(rows)} shown)</summary>")
    print()
    print("| package | version | type | licence |")
    print("|---|---|---|---|")
    for (name, version), art in shown:
        lic = ", ".join(licenses_of(art)) or "—"
        print(f"| {name} | {version} | {art.get('type', 'unknown')} | {lic} |")
    if len(rows) > len(shown):
        print()
        print(f"_{len(rows) - len(shown)} further packages omitted; the full SBOM is attached as an artefact._")
    print()
    print("</details>")
    return 0


if __name__ == "__main__":
    sys.exit(main())
