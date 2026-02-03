# UI Reference Guide

A widget-by-widget description of every interface component in Decision Theatre.

## Landing Page

The entry point of the application, displaying a hero section with navigation options.

| Component | Description |
|-----------|-------------|
| **Hero background** | Full-screen landscape image with gradient overlay |
| **Title** | "Landscape Decision Theatre" with gradient text styling |
| **Strapline** | "Exploring the possibilities of sustainable land use practices" |
| **About button** | Navigates to the About page with project information |
| **Projects button** | Navigates to the Projects page for project management |
| **Floating particles** | Subtle animated background elements |

## About Page

Detailed information about the project, funders, and open source nature.

| Component | Description |
|-----------|-------------|
| **Background** | Fixed foggy mountain landscape with dark overlay |
| **Back button** | Returns to the Landing page |
| **Hero section** | "About the Project" title with description |
| **Feature cards** | Four cards highlighting key capabilities (Spatial Analysis, Collaborative Decision Making, Scenario Modeling, Open Source) |
| **Mission section** | Detailed project mission statement |
| **Funders section** | Grid of funder/partner organization placeholders |
| **Citations section** | Academic references and citations |
| **Open Source section** | GitHub link and licensing information |

## Projects Page

Project management interface for creating, opening, and managing projects.

| Component | Description |
|-----------|-------------|
| **Background** | Fixed nature landscape with dark overlay |
| **Back button** | Returns to the Landing page |
| **Page title** | "Your Projects" with folder icon |
| **Create button** | Large primary button to create a new project |
| **Project grid** | Responsive grid of project cards (1-3 columns based on screen size) |
| **Empty state** | Shown when no projects exist, with prompt to create first project |

### Project Card

| Component | Description |
|-----------|-------------|
| **Thumbnail** | Project image or placeholder gradient |
| **Clone button** | Appears on hover; creates a copy of the project |
| **Delete button** | Appears on hover; deletes the project after confirmation |
| **Title** | Project name (truncated if too long) |
| **Description** | Project description (2 lines max) |
| **Created date** | Formatted creation timestamp |

## Create Project Page

Form for creating a new project.

| Component | Description |
|-----------|-------------|
| **Background** | Fixed mountain landscape with dark overlay |
| **Back button** | Returns to the Projects page |
| **Page title** | "Create New Project" or "Clone Project" |
| **Thumbnail upload** | Drag-and-drop zone for project thumbnail; auto-crops to 16:9 |
| **Title input** | Required text field for project name |
| **Description textarea** | Optional multi-line text for project description |
| **Create button** | Submits the form and navigates to map view |

## Setup Guide Page

Displayed when the application starts without required data files.

| Component | Description |
|-----------|-------------|
| **Title** | "Decision Theatre" with project tagline |
| **Data files required badge** | Yellow badge indicating data files are needed |
| **Component Status table** | Shows Ready/Missing status for: Map tiles, Scenario data |
| **Step 1: Obtain the GeoPackage** | Instructions for getting the source `UoW_layers.gpkg` |
| **Step 2: Convert to MBTiles** | Shell commands to run the conversion pipeline |
| **Step 3: Run the application** | Commands to start the app after data is in place |
| **Directory structure** | Visual layout of expected file locations |
| **Version footer** | Application version number |

## Main Application (Map View)

### Header Bar

| Component | Description |
|-----------|-------------|
| **Application title** | "Landscape Decision Theatre" in a gradient (blue to orange); clickable to return to Landing page |
| **Version badge** | Current version number |
| **Home button** | Navigation icon to return to Landing page |
| **Projects button** | Navigation icon to go to Projects page |
| **Map indicator** | Shows when viewing a project map |
| **Tiles indicator** | Green dot when MBTiles data is loaded, gray when missing |
| **Documentation toggle** | Help icon button that opens/closes the documentation panel |

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

The control panel slides in from the right when a pane is focused. The map area shrinks to accommodate it.

| Component | Description |
|-----------|-------------|
| **Left Scenario selector** | Dropdown to choose Reference, Current, or Future for the left map side |
| **Right Scenario selector** | Dropdown to choose the scenario for the right map side |
| **Attribute selector** | Dropdown listing all available catchment attributes from the loaded GeoParquet data |
| **Color scale legend** | Visual representation of the data range for the selected attribute |

### Documentation Panel

Resizable panel for viewing embedded documentation.

| Component | Description |
|-----------|-------------|
| **Resize handle** | Draggable left edge to adjust panel width |
| **Close button** | Dismisses the documentation panel |
| **Documentation iframe** | Embedded MkDocs documentation site |

### Responsive Behaviour

| Breakpoint | Panel width | Behaviour |
|------------|-------------|-----------|
| Mobile (`< md`) | Full width overlay | Map remains full width, panel overlays |
| Tablet (`md`) | 400px | Map shrinks with right margin |
| Desktop (`lg+`) | 440px | Map shrinks with right margin |

## Navigation Flow

```
Landing Page
├── About Page
│   └── Back to Landing
└── Projects Page
    ├── Create Project Page
    │   └── (on create) → Map View
    └── Project Card (click)
        └── Map View
            ├── Home button → Landing Page
            └── Projects button → Projects Page
```
