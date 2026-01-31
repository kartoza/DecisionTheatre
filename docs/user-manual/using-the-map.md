# Using the Map

The map interface is the primary way to explore catchment data in Decision Theatre.

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

## Per-Pane Toolbar

Each map pane has a floating toolbar in the bottom-right corner with two buttons:

- **Map / Chart toggle** (bar chart / map icon) -- switches between the map view and chart view for this pane.
- **Layout toggle** -- context-dependent:
    - In **quad view**: shows a maximise icon. Click to focus this pane as a single full-screen map and open its indicator panel.
    - In **single view**: shows a grid icon. Click to return to the four-pane quad layout.

## Single and Quad Views

- **Single view** -- one map pane fills the entire content area. The indicator (control) panel automatically opens on the right, letting you choose scenarios and attributes for the focused pane. Use the grid button on the toolbar to switch back to quad view.
- **Quad view** -- four map panes in a 2×2 grid, each with independent scenarios and indicator settings. Click the maximise button on any pane to focus it and open the indicator panel. The quad layout, focused pane, and per-pane indicator selections are all remembered between sessions.

## Chat Panel

The header bar includes a chat icon (speech bubble) that opens a slide-out chat panel on the right side of the screen. Use the chat panel to ask questions about catchment data, scenarios, and attributes using natural language.

When an LLM model is loaded, the chat enriches prompts with data context for intelligent answers. When no LLM is available, a built-in data query engine responds to common queries:

- **"list columns"** or **"what attributes"** -- shows available data attributes
- **"list scenarios"** -- shows loaded scenarios
- **"summary"** or **"overview"** -- gives a data summary
- Ask about a specific attribute name (e.g. "tell me about NPP_gm2") to get per-scenario statistics (count, min, max, mean, std dev)

Usage:

- Click the chat icon in the header to open or close the panel
- Type a question and press Enter or click the send button
- Previous messages are preserved while the panel stays open

## Header Status Indicators

The header bar shows the status of application components:

- **Tiles** -- green when map tile data is loaded
- **LLM** -- green when an AI language model is available
- **NN** -- green when a neural network model is loaded
