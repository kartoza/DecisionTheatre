# Scenario Comparison

Decision Theatre allows you to compare catchment attributes across three temporal scenarios: **past**, **present**, and **future**.

## Opening the Control Panel

Click the settings (gear) icon in the header to open the control panel on the right side of the screen.

## Selecting Scenarios

The control panel provides dropdown selectors for:

- **Left scenario** -- the scenario shown on the left side of the swipe divider
- **Right scenario** -- the scenario shown on the right side

Available scenarios depend on which GeoParquet files are present in the `data/` directory.

## Selecting an Attribute

Choose an attribute (factor) from the attribute dropdown. The map will colour catchments according to the selected attribute's values for each scenario, allowing visual comparison of how values change across time.

## Interpreting the Display

- Each catchment polygon is coloured based on the selected attribute's value
- The left side of the swipe shows the left scenario's values
- The right side shows the right scenario's values
- Drag the swipe divider to compare specific areas
