# Tutorial: First Run

This tutorial walks through launching Decision Theatre for the first time.

## Prerequisites

- The `decision-theatre` binary (see [Installation](../user-manual/installation.md))
- `catchments.mbtiles` in the `resources/mbtiles/` directory (see [Data Setup](../user-manual/data-setup.md))

## Steps

### 1. Launch the application

```bash
./decision-theatre --resources-dir ./resources --data-dir ./data
```

If you are using Nix:

```bash
nix run
```

### 2. Verify the setup guide

If the MBTiles file is not found, the application displays a **Setup Guide** page with:

- A status table showing which components are ready or missing
- Step-by-step instructions for obtaining and converting the data

Follow the on-screen instructions to prepare the required files.

### 3. View the map

Once data is loaded, the main interface appears:

- A full-screen vector map of Africa showing catchment boundaries, rivers, lakes, and country borders
- A header bar with the application title and status indicators
- A settings (gear) icon to open the control panel

### 4. Check status indicators

In the header, verify:

- **Tiles**: green (map data loaded)
- **LLM**: green if you provided a `--model` path, gray otherwise
- **NN**: green if a neural network model is available, gray otherwise

### 5. Open the control panel

Click the gear icon in the header. The control panel slides out from the right edge, and the map area adjusts to accommodate it.

You are now ready to explore the data. See [Comparing Scenarios](comparing-scenarios.md) for the next steps.
