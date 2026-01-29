# Tutorial: Comparing Scenarios

This tutorial demonstrates how to compare catchment attributes across past, present, and future scenarios.

## Prerequisites

- Decision Theatre running with map tiles loaded
- At least two GeoParquet scenario files in the `data/` directory (e.g., `past.geoparquet` and `present.geoparquet`)

## Steps

### 1. Open the control panel

Click the gear icon in the header bar. The control panel slides in from the right.

### 2. Select the left scenario

Use the **Left Scenario** dropdown to choose the time period for the left side of the map (e.g., "Past").

### 3. Select the right scenario

Use the **Right Scenario** dropdown to choose the time period for the right side (e.g., "Future").

### 4. Choose an attribute

Select an attribute from the **Attribute** dropdown. Catchments will be coloured on both sides of the map according to this attribute's values in each scenario.

### 5. Use the swipe divider

A vertical divider separates the two scenarios on the map. Drag it left or right to reveal more of either scenario. This allows direct spatial comparison of how the selected attribute changes between time periods.

### 6. Zoom to an area of interest

Use the scroll wheel or pinch gesture to zoom into a specific catchment. Both sides of the swipe update together, keeping the spatial context aligned.
