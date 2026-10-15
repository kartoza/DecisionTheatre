#!/usr/bin/env python3
# SPDX-FileCopyrightText: 2026 Kartoza
# SPDX-License-Identifier: AGPL-3.0-only

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
turned out to already carry the real thing). Every catchment's own
centroid snaps to whichever H3 cell contains it at a fixed resolution,
which decides which cells are occupied at all — one fixed grid for the
whole dataset, so neighbouring cells tile edge to edge with no overlap
and no gap.

A cell's REPRESENTATIVE catchment — whose HYBAS_ID the cell's feature
carries, and so whose value colours it — is not simply whichever
centroid-matched catchment happens to be largest. It is whichever
catchment's own polygon has the largest AREA OF OVERLAP with the cell's
hexagon, found via a spatial index over every catchment's real geometry
(not just the centroid that decided the cell's occupancy). Area-of-
overlap is a strictly better representative than "largest SUB_AREA among
centroid matches": a catchment whose centroid lands in a cell by chance
can still cover almost none of that cell's actual area, while a larger
neighbour that straddles the cell boundary covers most of it without its
own centroid ever landing inside. The gap this closes was visible, not
theoretical: cells whose centroid-matched "winner" had no value for the
indicator on screen rendered solid black (reported from a real
screenshot) even though a real, data-complete catchment dominated that
cell's actual area the whole time.

Reads catchments_lev12's real geometry now (not just lat/long/SUB_AREA
points, as an earlier version of this script did) specifically to
compute that overlap; writes a GeoJSON file of H3 cell boundary
polygons. The caller imports it into the GeoPackage as
catchments_lev12_hex with ogr2ogr, the same tool every other step of
this pipeline already uses for GeoPackage I/O rather than hand-encoding
GPKG's binary geometry format here.
"""
import argparse
import json
import sys
import warnings

import geopandas as gpd
import h3
from shapely.geometry import Polygon

# geopandas warns that .area is "likely incorrect" in a geographic (degree)
# CRS - true for absolute area, irrelevant here: every comparison is between
# candidates overlapping the SAME cell, a ~16km patch where the latitude
# (and so the degree-to-area distortion) is effectively constant across all
# of them, so the relative ordering idxmax() picks from is unaffected. The
# rest of this pipeline already treats lat/long degrees as equal-area for
# the same reason (see this file's own module docstring history) -
# reprojecting 147,837 geometries just to re-derive an ordering
# that degree-area already gives for free would be pure overhead.
warnings.filterwarnings("ignore", message="Geometry is in a geographic CRS.*")

# H3 resolution 5 cells average ~253 km^2 (~10km circumradius), close to
# the grid this replaces (independently tuned to collide about half of
# lev12's catchments down to their largest member - see module docstring)
# - keeps the same visual density already validated against a screenshot
# of this band, now built on the real library instead of reinventing it.
H3_RESOLUTION = 5


def hex_cell_polygon(cell: str) -> Polygon:
    return Polygon([(lng, lat) for lat, lng in h3.cell_to_boundary(cell)])


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("gpkg", help="Path to the GeoPackage containing catchments_lev12")
    parser.add_argument("out", help="Output GeoJSON path")
    parser.add_argument("--h3-resolution", type=int, default=H3_RESOLUTION,
                         help=f"H3 grid resolution, 0 (coarsest) - 15 (finest) (default {H3_RESOLUTION})")
    args = parser.parse_args()

    # fid_as_index=True makes the GeoDataFrame's own index the GeoPackage fid,
    # so a selected row's fid is just its .name - no separate SQL round trip
    # to recover it (as the lat/long/SUB_AREA-only version of this script did).
    catchments = gpd.read_file(args.gpkg, layer="catchments_lev12", fid_as_index=True)
    catchments = catchments[
        catchments["lat"].notna() & catchments["long"].notna() & catchments["HYBAS_ID"].notna()
    ]
    if catchments.empty:
        print("no catchments_lev12 rows with lat/long/HYBAS_ID found", file=sys.stderr)
        return 1

    # Which H3 cells are occupied at all: snap every catchment's own centroid,
    # same grid footprint/tuning as before - H3_RESOLUTION controls density
    # and collision rate, unchanged by the representative-selection fix below.
    cells = {
        h3.latlng_to_cell(lat, lon, args.h3_resolution)
        for lat, lon in zip(catchments["lat"], catchments["long"])
    }

    sindex = catchments.sindex
    features = []
    no_overlap = 0
    for cell in cells:
        hex_poly = hex_cell_polygon(cell)
        candidate_pos = sindex.query(hex_poly, predicate="intersects")
        if len(candidate_pos) == 0:
            # A fully-covered dataset shouldn't produce this - every point of
            # area belongs to some catchment - but an edge-of-coverage cell
            # genuinely might have nothing to represent it. Same as before:
            # simply don't draw a cell with nothing to show.
            no_overlap += 1
            continue
        candidates = catchments.iloc[candidate_pos]
        overlap_area = candidates.geometry.intersection(hex_poly).area
        winner_fid = overlap_area.idxmax()
        winner = catchments.loc[winner_fid]

        ring = list(hex_poly.exterior.coords)
        features.append({
            "type": "Feature",
            # Not "fid": ogr2ogr's GPKG driver treats a property literally
            # named fid as the table's own primary key, which collided and
            # aborted the import the moment two cells (now a real
            # possibility - a catchment big enough to dominate several
            # cells' overlap wins all of them, unlike the old one-centroid-
            # one-cell selection) shared a winner. HYBAS_ID is the only
            # property anything downstream actually joins on (promoteId in
            # choroplethTiles.ts); source_fid is debugging-only.
            "properties": {"source_fid": int(winner_fid), "HYBAS_ID": winner["HYBAS_ID"], "h3": cell},
            "geometry": {"type": "Polygon", "coordinates": [ring]},
        })

    with open(args.out, "w") as f:
        json.dump({"type": "FeatureCollection", "features": features}, f)

    print(f"wrote {len(features)} H3 res-{args.h3_resolution} cells "
          f"(representative = largest areal overlap with the cell, not largest "
          f"SUB_AREA among centroid matches) from {len(catchments)} catchments "
          f"to {args.out}; {no_overlap} occupied cell(s) had no overlapping "
          "catchment geometry and were skipped")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
