#!/usr/bin/env python3
"""Snap every lev12 catchment onto a shared hexagonal grid.

--legacy mode renders real lev12 boundaries at every zoom (see "The
--legacy flag" in docs/developer-guide/data-preparation.md); below about
z9 that is 147,837 slivers packed into one viewport, which reads as a
dense white mesh rather than a map (reported: a screen recording showed
the mesh at z5.7-6.12).

This is a real hex grid, not a hexagon independently drawn around each
catchment's own centroid (that was tried first and looked exactly as bad
as the mesh it replaced — hexagons of wildly different sizes overlapping
each other with no shared structure, reported back as "not what H3 means").
Flat-top axial hex-grid math (the same construction H3 and every other
hex-grid system use, hand-rolled here rather than taking on the H3
library and its icosahedral-projection machinery for what this needs):
one fixed cell size for the whole grid, so neighbouring cells tile edge
to edge with no overlap and no gap. Every catchment's centroid snaps to
whichever cell it falls in; a cell keeps only its largest catchment by
SUB_AREA when more than one lands in it (dense catchment clusters mean a
one-catchment-per-cell grid can't show literally every catchment at this
resolution — picking the biggest keeps the result a real, unblended
catchment value rather than an average across the ones that collided).
The catchments a cell does not keep are simply not drawn here; they still
render at full detail from z9, this band exists only below that.

Reads directly from catchments_lev12 (lat/long/SUB_AREA/HYBAS_ID only --
no geometry read, this never touches the real boundaries) and writes a
GeoJSON file of hexagon cell polygons; the caller imports it into the
GeoPackage as catchments_lev12_hex with ogr2ogr, the same tool every
other step of this pipeline already uses for GeoPackage I/O rather than
hand-encoding GPKG's binary geometry format here.

Standard-library only, per this project's dependency policy (CLAUDE.md):
nixpkgs before a new nix derivation before fetching upstream before pip.
"""
import argparse
import math
import json
import sqlite3
import sys

# Centre-to-vertex size of one grid cell, in degrees. ~0.09deg is close to
# the average lev12 catchment's own footprint (SUB_AREA averages ~131 km2,
# a ~6.5km characteristic radius) converted via KM_PER_DEGREE below, so a
# sparse area's catchments mostly get a cell to themselves while a dense
# cluster collides down to its largest member (see module docstring).
HEX_SIZE_DEG = 0.09
KM_PER_DEGREE = 111.0
SQRT3 = math.sqrt(3)


def point_to_axial(x: float, y: float, size: float) -> tuple[float, float]:
    """Fractional axial (q, r) coordinates for a flat-top hex grid."""
    q = (2.0 / 3.0 * x) / size
    r = (-1.0 / 3.0 * x + SQRT3 / 3.0 * y) / size
    return q, r


def round_axial(q: float, r: float) -> tuple[int, int]:
    """Snap fractional axial coordinates to the nearest actual hex cell.

    Rounding q and r independently picks the wrong cell near a third of
    the time, right along cell boundaries - axial coordinates have an
    implicit third (s = -q-r) that has to be rounded and reconciled
    alongside the other two for the snap to land in the cell the point is
    actually inside.
    """
    s = -q - r
    rq, rr, rs = round(q), round(r), round(s)
    dq, dr, ds = abs(rq - q), abs(rr - r), abs(rs - s)
    if dq > dr and dq > ds:
        rq = -rr - rs
    elif dr > ds:
        rr = -rq - rs
    return int(rq), int(rr)


def axial_to_point(q: int, r: int, size: float) -> tuple[float, float]:
    """The centre of hex cell (q, r) on a flat-top grid of this size."""
    x = size * (3.0 / 2.0 * q)
    y = size * (SQRT3 / 2.0 * q + SQRT3 * r)
    return x, y


def hexagon(cx: float, cy: float, size: float) -> list[list[float]]:
    """Flat-top hexagon vertices (closed ring) around (cx, cy)."""
    ring = []
    for i in range(6):
        angle = math.radians(60 * i)
        ring.append([cx + size * math.cos(angle), cy + size * math.sin(angle)])
    ring.append(ring[0])
    return ring


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("gpkg", help="Path to the GeoPackage containing catchments_lev12")
    parser.add_argument("out", help="Output GeoJSON path")
    parser.add_argument("--hex-size-deg", type=float, default=HEX_SIZE_DEG,
                         help=f"Grid cell centre-to-vertex size in degrees (default {HEX_SIZE_DEG})")
    args = parser.parse_args()

    con = sqlite3.connect(f"file:{args.gpkg}?mode=ro", uri=True)
    rows = con.execute(
        'SELECT fid, HYBAS_ID, lat, long, SUB_AREA FROM catchments_lev12 '
        'WHERE lat IS NOT NULL AND long IS NOT NULL AND HYBAS_ID IS NOT NULL'
    ).fetchall()
    con.close()

    if not rows:
        print("no catchments_lev12 rows with lat/long/HYBAS_ID found", file=sys.stderr)
        return 1

    # One winner per occupied cell: the catchment with the largest SUB_AREA.
    cells: dict[tuple[int, int], tuple] = {}
    for fid, hybas_id, lat, lon, sub_area in rows:
        q_frac, r_frac = point_to_axial(lon, lat, args.hex_size_deg)
        cell = round_axial(q_frac, r_frac)
        area = sub_area or 0.0
        current = cells.get(cell)
        if current is None or area > current[4]:
            cells[cell] = (fid, hybas_id, lat, lon, area)

    features = []
    for (q, r), (fid, hybas_id, _lat, _lon, _area) in cells.items():
        cx, cy = axial_to_point(q, r, args.hex_size_deg)
        features.append({
            "type": "Feature",
            "properties": {"fid": fid, "HYBAS_ID": hybas_id},
            "geometry": {"type": "Polygon", "coordinates": [hexagon(cx, cy, args.hex_size_deg)]},
        })

    with open(args.out, "w") as f:
        json.dump({"type": "FeatureCollection", "features": features}, f)

    print(f"wrote {len(features)} grid cells from {len(rows)} catchments "
          f"({len(rows) - len(features)} collided into a neighbour's cell) to {args.out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
