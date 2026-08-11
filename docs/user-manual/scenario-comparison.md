# Scenario Comparison

Landscape Decision Theatre compares catchment attributes across three scenarios, and offers four ways to view that comparison for a chosen factor.

## The Three Scenarios

| Scenario | Meaning |
|----------|---------|
| **Ecological Reference** | Condition compared to scientifically determined optimal standards |
| **Current State** | Current observed conditions |
| **Target State** | A user-defined target condition -- what you're aiming to achieve. Starts equal to Current State until you edit it (see [Setting target values](#setting-target-values)) |

Each view's indicator panel lets you pick a **Scenario 1 (Left)** and **Scenario 2 (Right)** -- any two of the three -- to compare. The map's swipe divider, and every other view mode, redraw around whichever pair you choose.

## Zone Range

Every view offers a **Zone Range** toggle that controls which catchments its statistics and colour scale are computed over:

- **Full** -- the entire loaded domain
- **Extent** -- only catchments currently visible in the map viewport
- **Site** -- only catchments within the open site's boundary (unavailable in [Explore mode](sites.md#explore-mode), or without a site loaded)

## Choosing a Factor

The indicator panel's **Factor** field is a searchable dropdown of every attribute available in the loaded data (for example "Grass cover fraction", "Percent burned", "Total Methane production"). In Chart view, you can instead browse by **Variable Type** to compare a whole category of related factors at once (see [Chart view](#chart-view)).

## View Modes

Switch any pane between four view modes using its toolbar (bottom-right in single view; the top toolbar in quad view can set all panes at once).

### Map view

The default choropleth map, described in [Using the Map](using-the-map.md).

### Chart view

A line or box-and-whisker plot of Reference / Current / Target values for the chosen factor.

![Chart view for a single factor](../assets/images/screenshots/view-chart.png)

- **Summary mode** -- with a single factor chosen, shows one 3-point comparison (Reference, Current, Target).
- **Grouped mode** -- choose a **Variable Type** instead of a single factor to chart every related factor at once, optionally drilling down further with a **Grouping Variable**. A **Line / Whisker Boxplot** toggle switches the chart style when the data supports it (boxplots use upper/lower bound data for the whiskers). Long axes with widely spread values switch automatically to a logarithmic scale, and large grouped charts paginate with **Prev / Next** controls.

### Dial view

A semicircular gauge for a single factor, giving an at-a-glance read of how far Current and Target sit from the ecological reference.

![Dial view showing Reference, Current, and Target](../assets/images/screenshots/view-dial.png)

The green band marks the healthy reference zone, fading to yellow and red toward the extremes. The solid blue needle shows **Current**; a dashed green needle appears alongside it once **Target** differs from Current.

### Table view

For a site, shows the **Site Aggregate Calculation**: the area-weighted average of the chosen factor across every catchment in the site.

![Site Aggregate Calculation table view](../assets/images/screenshots/view-table.png)

Summary cards show Total Valid Area, the highlighted **Site Average**, and catchment count. Click **Show Table** to reveal a full per-catchment breakdown (catchment ID, area, fraction covered, value, weight) with the underlying formula -- unless the site has too many catchments to list individually, in which case only the pre-computed site average is shown.

## Setting Target Values

There are two ways to edit a site's Target State values:

**Quick edit -- the Targets modal**: in quad view, once the site has indicators, click **Targets** in the top toolbar. Values are grouped by category (for example Fire, Herbivores, Vegetation Structure) in a collapsible accordion; expand a group to reveal a labelled slider per indicator, showing its current value, unit, and allowed range. Click **Save** to apply only the sliders you actually moved.

![Editing target values by category](../assets/images/screenshots/targets-modal.jpg)

**Full editor -- the Indicators page**: click the **Indicators** icon in the header to open the complete indicator table for the site, grouped by category, with Ecological Reference, Current State, a departure-from-reference trend glyph, and Target State for every indicator. See [The Indicators page](#the-indicators-page) below.

### The Indicators page

![The Indicators page for a site](../assets/images/screenshots/indicators-page.png)

Each row shows Ecological Reference / Current State / Target State for one indicator. Click the pencil icon to inline-edit a **Current State** value that's a user-supplied input (or missing), or a **Reference** value if it's missing -- expand the input to set separate lower/upper bounds instead of just a single value.

The toolbar offers a search box, a category filter, **Refresh** (re-extract indicators from the site's catchments), **Reset** (revert every Target back to Current -- asks for confirmation, and cannot be undone), and **Save Changes**.

If a site has no indicators yet, an **Extract Indicators** button computes them from its catchments; this can take a little while for large sites.

!!! note "Target warnings"
    Saving target values that aren't ecologically plausible can trigger a warning toast -- for example, setting a target grazing intake more than 10x the current plant productivity shows *"Herbivore consumption is higher than available biomass."* This is an early-stage check; more rules may be added over time.
