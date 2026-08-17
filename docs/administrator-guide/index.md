# Administrator Guide

For people responsible for assembling, validating and deploying the data and the
application — as distinct from end users of the interface, or developers changing the
code.

| Page | Covers |
|---|---|
| [The Data Directory](data-directory.md) | What the application reads, what is optional, and what does not belong |
| [Checking the Data Directory](validating-data.md) | The `check-data` tool and how to gate a deployment on it |
| [Server Deployment](../developer-guide/server-deployment.md) | Running the application as a hosted service |
| [Data Preparation](../developer-guide/data-preparation.md) | Building a GeoPackage and tiles from source data |
| [Datapack Format](../developer-guide/datapack-format.md) | The distributable archive format |

## Quick start

<figure markdown>
  ![The groups of checks check-data performs and its exit codes](../assets/diagrams/generated/validation-flow.svg)
  <figcaption class="static">
    Each group corresponds to something the Go runtime actually opens.
  </figcaption>
</figure>


Validate a data directory before running anything against it:

```bash
nix run .#check-data -- /path/to/data
```

Exit status `0` means no errors; `1` means the application will not work correctly.

!!! danger "Do not expose the API to an untrusted network yet"
    The application's HTTP API is unauthenticated, binds all interfaces, and includes
    destructive endpoints — `POST /api/datapack/install` deletes the data directory before
    extracting, and `POST /api/dialog/open-file` opens a window on the host desktop.

    Until the hardening work is complete, run it on a trusted network or behind an
    authenticating proxy that denies `/api/datapack/`, `/api/dialog/` and `/api/executables/`.
    See the [API Guide](../developer-guide/api.md) for the full picture.
