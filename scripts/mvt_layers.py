#!/usr/bin/env python3
"""Print each layer name and feature count found in one MVT tile.

Usage: mvt_layers.py MBTILES_FILE ZOOM COLUMN ROW

ROW is the tile_row as stored in the mbtiles map/tiles table (TMS
scheme) -- the same value sqlite3 shows you, no flipping needed.

Exists because tippecanoe-decode silently returns nothing against an
mbtiles file that uses the deduplicated map+images schema (what
tile-join produces): it looks for a literal `tiles` table and finds
only a same-named view. Reading the tile blob straight out of that view
and decoding the vector-tile protobuf ourselves sidesteps the
incompatibility entirely, at the cost of a small hand-rolled parser --
there's no MVT-decoding package in nixpkgs worth adding a dependency
for just this.
"""

import gzip
import sqlite3
import sys


def read_varint(buf, pos):
    result = 0
    shift = 0
    while True:
        b = buf[pos]
        pos += 1
        result |= (b & 0x7F) << shift
        if not (b & 0x80):
            return result, pos
        shift += 7


def iter_fields(buf):
    pos, n = 0, len(buf)
    while pos < n:
        tag, pos = read_varint(buf, pos)
        field_no, wire_type = tag >> 3, tag & 0x7
        if wire_type == 0:
            val, pos = read_varint(buf, pos)
        elif wire_type == 2:
            length, pos = read_varint(buf, pos)
            val, pos = buf[pos : pos + length], pos + length
        elif wire_type == 5:
            val, pos = buf[pos : pos + 4], pos + 4
        elif wire_type == 1:
            val, pos = buf[pos : pos + 8], pos + 8
        else:
            raise ValueError(f"unsupported protobuf wire type {wire_type}")
        yield field_no, val


def mvt_layers(tile_bytes):
    """{layer_name: feature_count} for a Tile message, gzip or not."""
    if tile_bytes[:2] == b"\x1f\x8b":
        tile_bytes = gzip.decompress(tile_bytes)
    layers = {}
    for field_no, val in iter_fields(tile_bytes):
        if field_no != 3:  # Tile.layers
            continue
        name, feature_count = None, 0
        for lf_no, lf_val in iter_fields(val):
            if lf_no == 1:  # Layer.name
                name = lf_val.decode("utf-8")
            elif lf_no == 2:  # Layer.features (repeated)
                feature_count += 1
        if name is not None:
            layers[name] = feature_count
    return layers


def main():
    mbtiles_path, z, x, y = sys.argv[1], *map(int, sys.argv[2:5])
    conn = sqlite3.connect(f"file:{mbtiles_path}?mode=ro", uri=True)
    row = conn.execute(
        "SELECT tile_data FROM tiles WHERE zoom_level=? AND tile_column=? AND tile_row=?",
        (z, x, y),
    ).fetchone()
    if row is None:
        return
    for name, count in mvt_layers(row[0]).items():
        print(f"{name}\t{count}")


if __name__ == "__main__":
    main()
