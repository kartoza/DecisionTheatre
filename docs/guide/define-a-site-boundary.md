# Step 10 — Define a site boundary

!!! abstract "Goal"
    Mark out the study area you actually care about.

## Background

Everything so far has been exploration. A **site** is a saved study area — define the
boundary once and every view, statistic and target is computed for it from then on.

There are four ways to define one. They all end at the same place: the server works out
which catchments fall inside and by how much.

<figure markdown>
  ![Where step 10 sits in the guide](../assets/diagrams/generated/journey-10.svg)
  <figcaption class="gen">
    Your place in the guide.
  </figcaption>
</figure>

<figure markdown>
  ![Define a site boundary](../assets/diagrams/generated/site-creation-methods.svg)
  <figcaption class="static">
    Define a site boundary.
  </figcaption>
</figure>

## Steps

1. Click **My Sites** in the header, then **Create New Site**.
2. Choose a **Method**:

![Choosing a boundary method](../assets/images/screenshots/create-site-method.png)

| Method | Use when |
|---|---|
| **Draw** | You want to sketch an area by hand |
| **Catchments** | Your area follows catchment boundaries |
| **Shapefile** | You have a `.zip` containing `.shp`, `.shx` and `.dbf` |
| **GeoJSON** | You have a `.geojson` or `.json` file |

3. Define the boundary on the map.

    - **Draw** — click at least three points. **Undo** and **Clear** are bottom-left.
    - **Catchments** — click catchments to toggle them, or use **Box Select** to drag a
      rectangle. Zoom in until catchment boundaries are visible first.
    - **Shapefile / GeoJSON** — upload, then review the parsed boundary.

4. Use the **location search** (top-left, three characters minimum) to fly to a place
   first if you need to find your area. Results combine a bundled gazetteer of major
   African cities with live lookups for smaller towns.

![Searching for a location while drawing a boundary](../assets/images/screenshots/create-site-search.jpg)

5. Click **Confirm Boundary** — or **Create Boundary** for the Catchments method. A map
   thumbnail is captured automatically at this point.

!!! tip "The satellite basemap helps"
    The globe icon switches to satellite imagery, which makes it much easier to see what
    you are drawing around.

!!! success "What you achieved"
    - You have chosen a boundary method
    - You have defined a boundary on the map
    - A thumbnail has been captured automatically

<div class="step-nav" markdown>

[:material-arrow-left: Step 9 — Work with several panes](work-with-several-panes.md){ .md-button }

[Step 11 — Name and save your site :material-arrow-right:](name-and-save-your-site.md){ .md-button .md-button--primary .next-step }

</div>
