# Scenario Comparison

Decision Theatre allows you to compare catchment attributes across three temporal scenarios: **past**, **present**, and **future**.

## Opening the Indicator Panel

In **quad view**, click the **Focus** button (maximise icon) on any pane's toolbar to switch to single-pane view. The indicator panel automatically slides out from the right, scoped to that pane. A "Pane N" badge in the panel title shows which pane is being configured. When you return to quad view (grid icon), the indicator panel closes automatically.

## Selecting Scenarios

The indicator panel provides dropdown selectors for:

- **Left scenario** -- the scenario shown on the left side of the swipe divider
- **Right scenario** -- the scenario shown on the right side

## Selecting an Attribute (Factor)

Choose a factor from the attribute dropdown. The map will colour catchments according to the selected factor's values using a prism colour gradient (violet through red). Colour transitions are smoothly eased over 800ms.

## Per-Pane Independence

Each of the four quad panes maintains its own scenario and attribute selections independently. This allows you to view different factors or scenario combinations simultaneously across the four panes.

All selections are persisted to local storage and restored when you reopen the application.

## Interpreting the Display

- Each catchment polygon is coloured using a prism gradient from low (violet) to high (red)
- The left side of the swipe shows the left scenario's values
- The right side shows the right scenario's values
- Drag the swipe divider to compare specific areas
- When no attribute is selected, catchments are shown with low opacity; selecting an attribute increases opacity with a smooth fade
