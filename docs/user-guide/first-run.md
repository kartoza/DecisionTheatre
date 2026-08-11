# Tutorial: First Run

This tutorial walks through launching Decision Theatre for the first time and creating your first site.

## Prerequisites

- The `decision-theatre` binary (see [Installation](../user-manual/installation.md))
- `africa.mbtiles` in the `data/mbtiles/` directory (see [Data Setup](../user-manual/data-setup.md))

## Steps

### 1. Launch the application

```bash
./decision-theatre --data-dir ./data
```

If you are using Nix:

```bash
nix run
```

### 2. Landing page

![The landing page](../assets/images/screenshots/landing-page.jpg)

The landing page ("Welcome to the Landscape Decision Dashboard") gives you a few ways in:

- **Explore the Future of Ecosystem Decision-Making** -- jump into the map with the full dataset and no site loaded (see [Explore mode](../user-manual/sites.md#explore-mode))
- **The FEFA and Rewild Capital Partnership** -- background on the organisations behind the tool
- Four audience cards, each launching a scripted **guided tour** through a pre-built example site (see [Guided tours](#3-guided-tours) below)
- **Guided Tour** -- restarts the app's own onboarding walkthrough, which runs automatically the first time you ever open the app

The first time the app loads in a given browser/profile, the onboarding walkthrough starts automatically. You can skip it with **Skip tour**, or step through it with **Next**.

### 3. Guided tours

Four topic-specific walkthroughs are available from the landing page, each pre-loading one of the built-in read-only demo sites and narrating a sequence of findings:

| Card | Demo site | Focus |
|------|-----------|-------|
| Explore Conservation Futures | Munywana | Woody biomass, tree cover, herbivore grazing pressure |
| Explore Shared Landscapes | Viphya | Miombo woodland restoration and tree-cover trade-offs |
| Explore Policy Impacts | Shai Hills | Forest vs. open-savanna restoration, fire and ecosystem processes |
| Explore Future Possibilities | Africa | Continent-scale herbivore biomass loss, methane/fire/carbon trade-offs, target-setting |

These are a good first stop if you want to see the app fully populated with real data before creating your own site.

### 4. Create your first site

To work with your own study area instead, click **My Sites** in the header (or **Explore...** then **Create Site** from the indicator panel), then:

1. Click **Create New Site**
2. Choose a boundary **Method** -- Shapefile, GeoJSON, Draw, or Catchments
3. Define the boundary on the map (for **Draw**, click at least 3 points; use the location **search box** to fly to a place first if you need to find your area)
4. Click **Confirm Boundary**
5. Give the site a **Title** (required) and optional **Description**, confirm the auto-captured thumbnail, then click **Create Site**

Full details are in [Sites](../user-manual/sites.md#creating-a-site).

The application creates your site and takes you directly to the map view.

### 5. View the map

Once in the map view, you'll see:

- A full-screen vector map of Africa showing catchment boundaries, rivers, lakes, and country borders, with your site's boundary outlined
- A header bar with navigation buttons (Home, My Sites, Indicators) and status indicators
- A slide-out indicator panel for configuring scenario comparisons

### 6. Check status indicators

In the header, verify **Tiles** shows green (map tile data loaded).

### 7. Open the indicator panel

In single-pane view the indicator panel opens automatically. It shows:

- **Zone Range** (Full / Extent / Site)
- A **Factor** selector for the choropleth attribute
- **Scenario 1 (Left)** and **Scenario 2 (Right)** selectors -- Ecological Reference, Current State, or Target State
- A **Color Scale** legend

You're now ready to explore the data. See [Comparing Scenarios](comparing-scenarios.md) for the next steps.

## Managing Sites

### Opening an existing site

1. Click **My Sites** (pin icon) in the header
2. Click on any site card to open it -- your saved layout, scenarios, and factor selections are restored

### Cloning a site

1. On the Sites page, hover over a site card
2. Click the **Clone** icon (copy)
3. Adjust the title and description as needed, then click **Create Site**

### Deleting a site

1. On the Sites page, hover over a site card
2. Click the **Delete** icon (trash)
3. Confirm the deletion

Deletion is permanent and cannot be undone. Note that the four built-in demo/tour sites cannot be edited, cloned, or deleted.
