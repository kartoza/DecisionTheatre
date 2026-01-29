# UI Reference Guide

A widget-by-widget description of every interface component in Decision Theatre.

## Setup Guide Page

Displayed when the application starts without required data files.

| Component | Description |
|-----------|-------------|
| **Title** | "Decision Theatre" with project tagline |
| **Data files required badge** | Yellow badge indicating data files are needed |
| **Component Status table** | Shows Ready/Missing status for: Map tiles, Scenario data, Embedded LLM, Neural network |
| **Step 1: Obtain the GeoPackage** | Instructions for getting the source `UoW_layers.gpkg` |
| **Step 2: Convert to MBTiles** | Shell commands to run the conversion pipeline |
| **Step 3: Run the application** | Commands to start the app after data is in place |
| **Directory structure** | Visual layout of expected file locations |
| **Version footer** | Application version number |

## Main Application

### Header Bar

| Component | Description |
|-----------|-------------|
| **Application title** | "Decision Theatre" in a gradient (blue to orange) |
| **Version badge** | Current version number |
| **Tiles indicator** | Green dot when MBTiles data is loaded, gray when missing |
| **LLM indicator** | Green dot when a language model is loaded, gray otherwise |
| **NN indicator** | Green dot when a neural network is loaded, gray otherwise |
| **Settings toggle** | Gear icon button that opens/closes the control panel |

### Map View

| Component | Description |
|-----------|-------------|
| **Map canvas** | Full MapLibre GL JS map rendering vector tiles from the local MBTiles |
| **Swipe divider** | Vertical line separating left and right scenarios; draggable |
| **Left map** | Renders the left scenario's catchment colouring |
| **Right map** | Renders the right scenario's catchment colouring |
| **Zoom controls** | Standard MapLibre zoom in/out buttons |
| **Compass** | Bearing indicator; click to reset to north |

### Control Panel

The control panel slides in from the right when toggled. The map area shrinks to accommodate it.

| Component | Description |
|-----------|-------------|
| **Left Scenario selector** | Dropdown to choose past, present, or future for the left map side |
| **Right Scenario selector** | Dropdown to choose the scenario for the right map side |
| **Attribute selector** | Dropdown listing all available catchment attributes from the loaded GeoParquet data |

### Responsive Behaviour

| Breakpoint | Panel width | Behaviour |
|------------|-------------|-----------|
| Mobile (`< md`) | Full width overlay | Map remains full width, panel overlays |
| Tablet (`md`) | 400px | Map shrinks with right margin |
| Desktop (`lg+`) | 440px | Map shrinks with right margin |
