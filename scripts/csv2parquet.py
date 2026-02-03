#!/usr/bin/env python3
"""Convert Decision Theatre CSV data files to Parquet format.

Usage:
    python3 scripts/csv2parquet.py [--data-dir DIR] [--output-dir DIR]

Converts current.csv, reference.csv, column_metadata.csv
into compressed Parquet files. The catchID column
(present in current and reference files) is preserved as the join key for the
mbtiles catchment map.

Requires: pyarrow (available in nix develop)
"""
import argparse
import sys
from pathlib import Path

try:
    import pyarrow as pa
    import pyarrow.csv as pcsv
    import pyarrow.parquet as pq
except ImportError:
    print("ERROR: pyarrow is required. Enter 'nix develop' to get it.", file=sys.stderr)
    sys.exit(1)


# Files to convert and their specific read options
CSV_FILES = {
    "current.csv": {
        "description": "Current scenario catchment landscape data",
        "output": "current.parquet",
    },
    "reference.csv": {
        "description": "Reference scenario catchment landscape data",
        "output": "reference.parquet",
    },
    "column_metadata.csv": {
        "description": "Column metadata for landscape datasets",
        "output": "column_Metadata.parquet",
    },
}


def convert_csv_to_parquet(
    csv_path: Path, parquet_path: Path, description: str
) -> None:
    """Convert a single CSV file to Parquet with snappy compression."""
    print(f"  Converting {csv_path.name} -> {parquet_path.name} ({description})")

    # Read CSV with pyarrow — handles NA strings and mixed numeric columns
    read_opts = pcsv.ReadOptions(autogenerate_column_names=False)
    parse_opts = pcsv.ParseOptions(delimiter=",")
    convert_opts = pcsv.ConvertOptions(
        null_values=["NA", "na", "N/A", "n/a", ""],
        strings_can_be_null=True,
    )

    table = pcsv.read_csv(
        csv_path,
        read_options=read_opts,
        parse_options=parse_opts,
        convert_options=convert_opts,
    )

    # Write as Parquet with snappy compression (good balance of speed + size)
    pq.write_table(
        table,
        parquet_path,
        compression="snappy",
        version="2.6",
        write_statistics=True,
    )

    csv_size = csv_path.stat().st_size / (1024 * 1024)
    pq_size = parquet_path.stat().st_size / (1024 * 1024)
    ratio = (1 - pq_size / csv_size) * 100 if csv_size > 0 else 0
    print(f"    {csv_size:.1f} MB -> {pq_size:.1f} MB ({ratio:.0f}% reduction)")
    print(f"    {table.num_rows} rows, {table.num_columns} columns")


def main() -> None:
    parser = argparse.ArgumentParser(description="Convert CSV data files to Parquet")
    parser.add_argument(
        "--data-dir",
        type=Path,
        default=Path(__file__).resolve().parent.parent / "data",
        help="Directory containing CSV files (default: ./data)",
    )
    parser.add_argument(
        "--output-dir",
        type=Path,
        default=None,
        help="Output directory for Parquet files (default: same as data-dir)",
    )
    args = parser.parse_args()

    output_dir = args.output_dir or args.data_dir
    output_dir.mkdir(parents=True, exist_ok=True)

    print(f"Converting CSVs in {args.data_dir} -> {output_dir}")
    print()

    converted = 0
    for csv_name, info in CSV_FILES.items():
        csv_path = args.data_dir / csv_name
        if not csv_path.exists():
            print(f"  SKIP {csv_name} (not found)")
            continue

        parquet_path = output_dir / info["output"]
        convert_csv_to_parquet(csv_path, parquet_path, info["description"])
        converted += 1

    print()
    if converted == 0:
        print("No CSV files found to convert.")
        sys.exit(1)
    else:
        print(f"Done. Converted {converted} file(s).")


if __name__ == "__main__":
    main()
