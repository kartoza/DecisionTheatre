#!/usr/bin/env python3
"""
Convert GeoParquet files (WKB geometry) to Arrow IPC files with native GeoArrow encoding.

Reads data/*.geoarrow (GeoParquet with WKB-encoded geometry) and writes
data/*.arrow (Arrow IPC with native GeoArrow multipolygon encoding).

The output files can be loaded directly in the browser using apache-arrow's
tableFromIPC and rendered with @geoarrow/deck.gl-layers.
"""

import sys
from pathlib import Path

import geopandas as gpd
import pyarrow as pa
import pyarrow.ipc as ipc


def convert(src: Path, dst: Path) -> None:
    print(f"Reading {src.name} ...")
    gdf = gpd.read_parquet(src)
    print(f"  {len(gdf)} rows, {len(gdf.columns)} columns")

    # Convert to Arrow table with native GeoArrow geometry (struct coords)
    arrow_obj = gdf.to_arrow(geometry_encoding="geoarrow", interleaved=False)
    table = pa.RecordBatchReader.from_stream(arrow_obj).read_all()

    print(f"  Writing {dst.name} (Arrow IPC) ...")
    with ipc.new_file(str(dst), table.schema) as writer:
        for batch in table.to_batches():
            writer.write_batch(batch)

    size_mb = dst.stat().st_size / (1024 * 1024)
    print(f"  Done: {size_mb:.1f} MB")


def main() -> None:
    data_dir = Path(__file__).parent.parent / "data"

    for name in ("reference", "current"):
        src = data_dir / f"{name}.geoarrow"
        dst = data_dir / f"{name}.arrow"
        if not src.exists():
            print(f"Skipping {src.name}: file not found")
            continue
        convert(src, dst)

    print("\nAll done!")


if __name__ == "__main__":
    main()
