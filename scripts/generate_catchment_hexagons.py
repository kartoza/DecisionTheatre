#!/usr/bin/env python3
"""Snap every lev12 catchment onto a shared H3 hex grid.

--legacy mode renders real lev12 boundaries at every zoom (see "The
--legacy flag" in docs/developer-guide/data-preparation.md); below about
z9 that is 147,837 slivers packed into one viewport, which reads as a
dense white mesh rather than a map (reported: a screen recording showed
the mesh at z5.7-6.12).

This is a real hex grid, not a hexagon independently drawn around each
catchment's own centroid (that was tried first and looked exactly as bad
as the mesh it replaced — hexagons of wildly different sizes overlapping
each other with no shared structure, reported back as "not what H3
means"). It uses actual H3 (nixpkgs ships the upstream Python bindings as
python3Packages.h3, wired into dataToolsEnv in flake.nix — a hand-rolled
axial-grid reimplementation was tried first and discarded once nixpkgs
turned out to already carry the real thing). Every catchment's centroid
snaps to whichever H3 cell contains it at a fixed resolution, so
neighbouring cells tile edge to edge with no overlap and no gap. A cell
keeps only its largest catchment by SUB_AREA when more than one lands in
it (dense catchment clusters mean a one-catchment-per-cell grid can't
show literally every catchment at this resolution — picking the biggest
keeps the result a real, unblended catchment value rather than an
average across the ones that collided). The catchments a cell does not
keep are simply not drawn here; they still render at full detail from
z9, this band exists only below that.

Reads directly from catchments_lev12 (lat/long/SUB_AREA/HYBAS_ID only --
no geometry read, this never touches the real boundaries) and writes a
GeoJSON file of H3 cell boundary polygons; the caller imports it into the
GeoPackage as catchments_lev12_hex with ogr2ogr, the same tool every
other step of this pipeline already uses for GeoPackage I/O rather than
hand-encoding GPKG's binary geometry format here.
"""
import argparse
import json
import sqlite3
import sys

import h3

# H3 resolution 5 cells average ~253 km^2 (~10km circumradius), close to
# the grid this replaces (independently tuned to collide about half of
# lev12's catchments down to their largest member - see module docstring)
# - keeps the same visual density already validated against a screenshot
# of this band, now built on the real library instead of reinventing it.
H3_RESOLUTION = 5


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("gpkg", help="Path to the GeoPackage containing catchments_lev12")
    parser.add_argument("out", help="Output GeoJSON path")
    parser.add_argument("--h3-resolution", type=int, default=H3_RESOLUTION,
                         help=f"H3 grid resolution, 0 (coarsest) - 15 (finest) (default {H3_RESOLUTION})")
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
    cells: dict[str, tuple] = {}
    for fid, hybas_id, lat, lon, sub_area in rows:
        cell = h3.latlng_to_cell(lat, lon, args.h3_resolution)
        area = sub_area or 0.0
        current = cells.get(cell)
        if current is None or area > current[4]:
            cells[cell] = (fid, hybas_id, lat, lon, area)

    features = []
    for cell, (fid, hybas_id, _lat, _lon, _area) in cells.items():
        ring = [[lng, lat] for lat, lng in h3.cell_to_boundary(cell)]
        ring.append(ring[0])
        features.append({
            "type": "Feature",
            "properties": {"fid": fid, "HYBAS_ID": hybas_id, "h3": cell},
            "geometry": {"type": "Polygon", "coordinates": [ring]},
        })

    with open(args.out, "w") as f:
        json.dump({"type": "FeatureCollection", "features": features}, f)

    print(f"wrote {len(features)} H3 res-{args.h3_resolution} cells from {len(rows)} catchments "
          f"({len(rows) - len(features)} collided into a neighbour's cell) to {args.out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
