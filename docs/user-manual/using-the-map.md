# Using the Map

The map interface is the primary way to explore catchment data in Landscape Decision Theatre.

## Map Controls

- **Pan** -- click and drag to move the map
- **Zoom** -- scroll wheel, pinch gesture, or double-click to zoom in; shift+double-click to zoom out
- **Rotate** -- right-click and drag, or use the compass control
- **Reset bearing** -- click the compass icon to reset north

## Map Layers

The map displays several vector layers at different zoom levels:

- **African countries** -- country boundaries and labels (visible from zoom 2)
- **Ecoregions** -- ecological region boundaries (visible from zoom 2)
- **Rivers** -- major river networks (visible from zoom 6)
- **Lakes** -- lake boundaries (visible from zoom 6)
- **Populated places** -- cities and towns (visible from zoom 6)
- **Catchments** -- level-12 catchment boundaries (visible from zoom 8)

## Swipe View

The map supports a side-by-side comparison mode using a vertical swipe divider. The left side shows one scenario and the right side shows another. Drag the divider to reveal more of either side.

## Map Tools

When an indicator is selected, a vertical tool bar appears on the left side of the map with the following buttons:

- **Identify** (i icon) -- toggles identify mode. When active, the cursor changes to a crosshair. Click any catchment to see all its attribute values across all scenarios in a table in the side panel. The currently selected indicator is highlighted in the table. Click the button again to disable identify mode.
- **3D View** (cube icon) -- toggles 3D extrusion mode. When active, catchment polygons are extruded based on their attribute values, providing a visual height-based comparison. The map pitch tilts to 60 degrees for a perspective view.

## Per-Pane Toolbar

Each map pane has a floating toolbar in the bottom-right corner with two buttons:

- **Map / Chart toggle** (bar chart / map icon) -- switches between the map view and chart view for this pane.
- **Layout toggle** -- context-dependent:
    - In **quad view**: shows a maximise icon. Click to focus this pane as a single full-screen map and open its indicator panel.
    - In **single view**: shows a grid icon. Click to return to the four-pane quad layout.

## Single and Quad Views

- **Single view** -- one map pane fills the entire content area. The indicator (control) panel automatically opens on the right, letting you choose scenarios and attributes for the focused pane. Use the grid button on the toolbar to switch back to quad view.
- **Quad view** -- four map panes in a 2×2 grid, each with independent scenarios and indicator settings. Click the maximise button on any pane to focus it and open the indicator panel. The quad layout, focused pane, and per-pane indicator selections are all remembered between sessions.

## Header Status Indicators

The header bar shows the status of application components:

- **Tiles** -- green when map tile data is loaded

## Navigation

The header also provides navigation controls:

- **Home** icon -- return to the Landing Page
- **Projects** icon -- go directly to the Projects page
- **Documentation** icon -- open the embedded documentation panel
