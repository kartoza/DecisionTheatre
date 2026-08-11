# Tutorial: Comparing Scenarios

This tutorial demonstrates how to compare a catchment factor across Decision Theatre's three scenarios -- Ecological Reference, Current State, and Target State.

## Prerequisites

- Decision Theatre running with map tiles loaded
- A site open (see [First Run](first-run.md#4-create-your-first-site)), or [Explore mode](../user-manual/sites.md#explore-mode) for the full dataset

## Steps

### 1. Open the indicator panel

In single-pane view the panel opens automatically. In quad view, click the **maximise icon** on any pane to focus it and open its panel.

### 2. Choose a factor

In the **Factor** field, search for and select an attribute -- for example "Grass cover fraction". The map (or chart/dial/table, depending on view mode) updates immediately.

### 3. Select the left scenario

Use the **Scenario 1 (Left)** dropdown to choose, e.g., **Ecological Reference**.

### 4. Select the right scenario

Use the **Scenario 2 (Right)** dropdown to choose, e.g., **Current State**. (Swap in **Target State** here once you've set one, to compare your intended outcome against today.)

### 5. Use the swipe divider

A vertical divider separates the two scenarios on the map. Drag it left or right to reveal more of either side, directly comparing how the factor changes between them. It docks fully to one edge if you drag within about 3% of it.

### 6. Zoom to an area of interest

Scroll or pinch to zoom into a specific catchment -- both sides of the swipe update together, keeping spatial context aligned. If you have a site open, click **Zoom to Site** to frame it exactly.

### 7. Try the other view modes

Switch the pane's view mode (bottom-right toolbar) to compare the same factor differently:

- **Dial** -- a single gauge showing how far Current (and Target, once set) sit from the Ecological Reference
- **Chart** -- a line or boxplot comparison; choose a **Variable Type** instead of a single factor to compare a whole category at once
- **Table** -- the site's area-weighted average for the factor, with an optional per-catchment breakdown

### 8. Set a target value

If you'd like to model a specific outcome rather than just observing Current vs. Reference, open the **Targets** modal (quad view toolbar) or the full [Indicators page](../user-manual/scenario-comparison.md#the-indicators-page) (header icon) and adjust the factor's Target State value. Switch **Scenario 2 (Right)** to **Target State** to see it reflected on the map, dial, or chart.

See [Scenario Comparison](../user-manual/scenario-comparison.md) for full reference detail on zone range, view modes, and target editing.
