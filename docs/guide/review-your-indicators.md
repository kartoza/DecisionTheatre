# Step 12 — Review your indicators

!!! abstract "Goal"
    Read the indicator values computed for your site.

## Background

Once a site exists, the application aggregates every indicator across the catchments inside
it, weighted by how much of each catchment the boundary actually covers.

The Indicators page is where you see all of them at once, rather than one factor at a
time.

<figure markdown>
  ![Where step 12 sits in the guide](../assets/diagrams/generated/journey-12.svg)
  <figcaption class="gen">
    Your place in the guide.
  </figcaption>
</figure>

## Steps

1. Click the **Indicators** icon in the header.

![The Indicators page for a site](../assets/images/screenshots/indicators-page.png)

2. Each row shows one indicator with its **Ecological Reference**, **Current State**, a
   departure-from-reference trend glyph, and **Target State**.
3. Use the toolbar to search, filter by category, or act on the whole set:

| Control | What it does |
|---|---|
| **Refresh** | Re-extracts indicators from the site's catchments |
| **Reset** | Reverts every Target back to Current — asks first, cannot be undone |
| **Save Changes** | Persists your edits |

4. Click the pencil on a row to inline-edit a **Current State** value that is a
   user-supplied input or missing, or a **Reference** value if it is missing. Expand the
   input to set separate lower and upper bounds instead of a single value.

!!! note "If the page is empty"
    A site with no indicators yet shows an **Extract Indicators** button. For large sites
    this can take a little while.

!!! success "What you achieved"
    - You can read every indicator computed for your site
    - You can search and filter them by category
    - You can supply missing values and re-extract

<div class="step-nav" markdown>

[:material-arrow-left: Step 11 — Name and save your site](name-and-save-your-site.md){ .md-button }

[Step 13 — Set target values :material-arrow-right:](set-target-values.md){ .md-button .md-button--primary .next-step }

</div>
