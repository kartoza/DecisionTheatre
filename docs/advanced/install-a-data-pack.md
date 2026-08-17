# Install a data pack

!!! abstract "Goal"
    Give the application some data to show.

!!! info "You probably do not need this"
    Decision Theatre is hosted at
    [africanlandscapefutures.wits.ac.za](https://africanlandscapefutures.wits.ac.za/)
    and needs no installation. Run it locally only if you need it offline — in the
    field, or in a workshop without reliable internet.

    To use the hosted version instead, start at
    [Step 1 — Open the dashboard](../guide/open-the-dashboard.md).

## Background

A fresh install has no data. On first launch the application looks for map tiles and
scenario data; if it cannot find them it shows a **Setup Guide** instead of a map.

A data pack is a single archive containing the vector map tiles, the map style, and the
GeoPackage of scenario data. It is distributed separately from the application because it
is large and changes on its own schedule.

<figure markdown>
  ![Install a data pack](../assets/diagrams/generated/datapack-install.svg)
  <figcaption class="static">
    Install a data pack.
  </figcaption>
</figure>

## Steps

1. Obtain a data pack archive (`.zip` or `.7z`) from the project maintainers.
2. Launch the application. If no data is present you will see the **Setup Guide**.
3. Enter the full path to the archive in the **Install Data Pack** field.
4. Click **Install**. Progress is reported as the archive extracts.
5. The application reloads automatically when extraction finishes.

Your existing sites and thumbnails are backed up and restored around the install, so
installing a new pack does not discard work.

### Where the data ends up

| Platform | Path |
|---|---|
| Linux | `~/.local/share/decision-theatre/datapacks/` |
| macOS | `~/Library/Application Support/decision-theatre/datapacks/` |
| Windows | `%LOCALAPPDATA%\decision-theatre\datapacks\` |

The location is remembered, so subsequent launches load it automatically.

### Pointing at a directory instead

If you already have an extracted data directory, skip the installer:

```bash
./decision-theatre --data-dir /path/to/data
```

!!! tip "If the map is blank, or most factors are missing"
    Both have known causes that a validator will identify in seconds:

    ```bash
    nix run .#check-data -- /path/to/data
    ```

    See [The Data Directory](../administrator-guide/data-directory.md) for what it checks
    and why.

!!! success "What you achieved"
    - A data pack is installed and loaded
    - You know where the extracted data lives
    - You know how to check a data directory when something looks wrong

<div class="step-nav" markdown>

[Back to the guide :material-arrow-right:](../guide/index.md){ .md-button .md-button--primary .next-step }

</div>
