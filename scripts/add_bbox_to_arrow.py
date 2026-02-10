#!/usr/bin/env python3
"""
Add bounding box columns (minx, miny, maxx, maxy) to GeoArrow files
for efficient spatial filtering.
"""

import sys
import pyarrow as pa
import pyarrow.ipc as ipc
import pyarrow.compute as pc
import numpy as np


def compute_bbox_from_geoarrow_polygon(geometry_col):
    """
    Compute bounding boxes for each polygon in a GeoArrow geometry column.
    Simple row-by-row approach for reliability.

    GeoArrow polygon structure:
    list<polygons: list<rings: list<vertices: struct<x, y>>>>
    """
    n_rows = len(geometry_col)
    print(f"  Computing bboxes for {n_rows} geometries...")

    minx = np.full(n_rows, np.inf)
    miny = np.full(n_rows, np.inf)
    maxx = np.full(n_rows, -np.inf)
    maxy = np.full(n_rows, -np.inf)

    for row_idx in range(n_rows):
        if row_idx % 20000 == 0:
            print(f"    Row {row_idx}/{n_rows}...")

        polygon = geometry_col[row_idx].as_py()
        if polygon is None:
            minx[row_idx] = miny[row_idx] = maxx[row_idx] = maxy[row_idx] = np.nan
            continue

        # Collect all x,y coords from all rings of all polygons
        all_x = []
        all_y = []

        for poly in polygon:  # each polygon in multipolygon
            if poly is None:
                continue
            for ring in poly:  # each ring in polygon
                if ring is None:
                    continue
                for vertex in ring:  # each vertex in ring
                    if vertex is None:
                        continue
                    all_x.append(vertex['x'])
                    all_y.append(vertex['y'])

        if all_x:
            minx[row_idx] = min(all_x)
            maxx[row_idx] = max(all_x)
            miny[row_idx] = min(all_y)
            maxy[row_idx] = max(all_y)
        else:
            minx[row_idx] = miny[row_idx] = maxx[row_idx] = maxy[row_idx] = np.nan

    return minx, miny, maxx, maxy


def add_bbox_columns(input_path, output_path):
    """Add bbox columns to an arrow file."""
    print(f"Reading {input_path}...")

    with pa.memory_map(input_path, 'r') as source:
        reader = ipc.open_file(source)
        table = reader.read_all()

    print(f"  {table.num_rows} rows, {table.num_columns} columns")

    # Check if bbox columns already exist
    existing_cols = set(table.column_names)
    if 'bbox_minx' in existing_cols:
        print("  Bbox columns already exist, skipping...")
        return

    # Get geometry column
    geom_col = table.column('geometry')

    print("Computing bounding boxes...")
    minx, miny, maxx, maxy = compute_bbox_from_geoarrow_polygon(geom_col)

    # Add bbox columns
    table = table.append_column('bbox_minx', pa.array(minx))
    table = table.append_column('bbox_miny', pa.array(miny))
    table = table.append_column('bbox_maxx', pa.array(maxx))
    table = table.append_column('bbox_maxy', pa.array(maxy))

    print(f"Writing {output_path}...")
    with pa.OSFile(output_path, 'wb') as sink:
        writer = ipc.new_file(sink, table.schema)
        writer.write_table(table)
        writer.close()

    print("Done!")


if __name__ == '__main__':
    if len(sys.argv) < 2:
        print("Usage: add_bbox_to_arrow.py <input.arrow> [output.arrow]")
        sys.exit(1)

    input_path = sys.argv[1]
    output_path = sys.argv[2] if len(sys.argv) > 2 else input_path

    add_bbox_columns(input_path, output_path)
