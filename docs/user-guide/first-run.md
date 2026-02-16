# Tutorial: First Run

This tutorial walks through launching Decision Theatre for the first time.

## Prerequisites

- The `decision-theatre` binary (see [Installation](../user-manual/installation.md))
- `catchments.mbtiles` in the `data/mbtiles/` directory (see [Data Setup](../user-manual/data-setup.md))

## Steps

### 1. Launch the application

```bash
./decision-theatre --data-dir ./data
```

If you are using Nix:

```bash
nix run
```

### 2. Landing Page

When the application starts, you'll see the **Landing Page** with:

- **Landscape Decision Theatre** title with a beautiful background landscape image
- **Strapline**: "Exploring the possibilities of sustainable land use practices"
- **About** button: Learn more about the project, funders, and open source nature
- **Projects** button: Access the project management interface

### 3. About Page

Click the **About** button to view:

- Project overview and mission statement
- Feature highlights (spatial analysis, collaborative decision making, scenario modeling)
- Funders and partners information
- Academic citations and references
- Open source information with links to the GitHub repository

Use the **Back to Home** button to return to the landing page.

### 4. Create Your First Project

1. Click **Projects** from the landing page
2. Click **Create New Project**
3. Fill in the project details:
   - **Thumbnail**: Drag and drop an image or click to upload (optional)
   - **Title**: Give your project a descriptive name (required)
   - **Description**: Add notes about your project (optional)
4. Click **Create Project**

The application will create your project and navigate to the map view.

### 5. View the map

Once in the map view, you'll see:

- A full-screen vector map of Africa showing catchment boundaries, rivers, lakes, and country borders
- A header bar with navigation buttons (Home, Projects) and status indicators
- A slide-out control panel for configuring scenario comparisons

### 6. Check status indicators

In the header, verify:

- **Tiles**: green (map data loaded)

### 7. Open the control panel

Click any pane to focus it and open the control panel. The panel slides out from the right edge, showing:

- Scenario selectors (Reference, Current, Future)
- Attribute selector for choropleth visualization
- Color scale legend

You are now ready to explore the data. See [Comparing Scenarios](comparing-scenarios.md) for the next steps.

## Managing Projects

### Opening an Existing Project

1. Click the **Projects** button (folder icon) in the header or navigate to Projects from the landing page
2. Click on any project card to open it
3. Your map state (scenarios, attributes, layout) will be restored

### Cloning a Project

1. In the Projects page, hover over a project card
2. Click the **Clone** button (copy icon)
3. Modify the title and description as needed
4. Click **Create Project** to create a copy

### Deleting a Project

1. In the Projects page, hover over a project card
2. Click the **Delete** button (trash icon)
3. Confirm the deletion

Note: Project deletion is permanent and cannot be undone.
