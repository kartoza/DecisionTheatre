#!/usr/bin/env python3
"""
Join catchment geometries from GeoPackage to CSV data and export as GeoArrow files.

This script:
1. Reads catchment polygons from the GeoPackage (catchments_lev12 layer)
2. Reads current.csv and reference.csv data files
3. Joins geometries to CSV data on HYBAS_ID/catchID
4. Writes output as GeoArrow (GeoParquet) files
"""

import geopandas as gpd
import pandas as pd
import pyarrow as pa
import pyarrow.parquet as pq
from pathlib import Path


def main():
    # Paths
    project_root = Path(__file__).parent.parent
    gpkg_path = project_root / "resources" / "mbtiles" / "UoW_layers.gpkg"
    data_dir = project_root / "data"

    current_csv = data_dir / "current.csv"
    reference_csv = data_dir / "reference.csv"

    current_geoarrow = data_dir / "current.geoarrow"
    reference_geoarrow = data_dir / "reference.geoarrow"

    # Read catchment geometries
    print("Reading catchment geometries from GeoPackage...")
    catchments = gpd.read_file(gpkg_path, layer="catchments_lev12")
    print(f"  Loaded {len(catchments)} catchment polygons")

    # Rename HYBAS_ID to catchID for the join
    catchments = catchments.rename(columns={"HYBAS_ID": "catchID"})
    # Convert to int64 for join compatibility
    catchments["catchID"] = catchments["catchID"].astype("int64")

    # Keep only geometry and catchID for the join
    catchments_geom = catchments[["catchID", "geometry"]]

    # Process current.csv
    print("\nProcessing current.csv...")
    current_df = pd.read_csv(current_csv)
    print(f"  Loaded {len(current_df)} rows from current.csv")

    # Join with geometries
    current_gdf = catchments_geom.merge(current_df, on="catchID", how="inner")
    current_gdf = gpd.GeoDataFrame(current_gdf, geometry="geometry", crs=catchments.crs)
    print(f"  Joined {len(current_gdf)} rows with geometries")

    # Write as GeoArrow (GeoParquet with geometry encoding)
    print(f"  Writing to {current_geoarrow}...")
    current_gdf.to_parquet(current_geoarrow, compression="snappy")
    print(f"  Done! File size: {current_geoarrow.stat().st_size / (1024*1024):.1f} MB")

    # Process reference.csv
    print("\nProcessing reference.csv...")
    reference_df = pd.read_csv(reference_csv)
    print(f"  Loaded {len(reference_df)} rows from reference.csv")

    # Join with geometries
    reference_gdf = catchments_geom.merge(reference_df, on="catchID", how="inner")
    reference_gdf = gpd.GeoDataFrame(reference_gdf, geometry="geometry", crs=catchments.crs)
    print(f"  Joined {len(reference_gdf)} rows with geometries")

    # Write as GeoArrow (GeoParquet with geometry encoding)
    print(f"  Writing to {reference_geoarrow}...")
    reference_gdf.to_parquet(reference_geoarrow, compression="snappy")
    print(f"  Done! File size: {reference_geoarrow.stat().st_size / (1024*1024):.1f} MB")

    print("\nAll done!")


if __name__ == "__main__":
    main()
