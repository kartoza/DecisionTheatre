# Step 5 — Choose what to show

!!! abstract "Goal"
    Select a factor, two scenarios, and the area to summarise over.

## Background

Three choices drive every view in the application: **which factor**, **which two
scenarios**, and **over what area**. Get these right and the map, charts, dials and tables
all follow.

The factor list comes from the data itself, so it reflects whatever data pack you have
installed.

<figure markdown>
  ![Where step 5 sits in the guide](../assets/diagrams/generated/journey-05.svg)
  <figcaption class="gen">
    Your place in the guide.
  </figcaption>
</figure>

## Steps

1. Open the indicator panel — it opens automatically in single-pane view.
2. Set **Factor**: a searchable dropdown of every attribute in the loaded data, for example
   *Grass cover fraction*, *Percent burned*, *Total methane production*.
3. Set **Scenario 1 (Left)** and **Scenario 2 (Right)** — any two of the three below.
4. Set **Zone Range** to control what the statistics and colour scale are computed over.

### The three scenarios

| Scenario | Meaning |
|---|---|
| **Ecological Reference** | Condition measured against scientifically determined optimal standards |
| **Current State** | Conditions as currently observed |
| **Target State** | A condition you are aiming for. Starts equal to Current State until you edit it |

### Zone Range

| Option | Summarises over |
|---|---|
| **Full** | The entire loaded domain |
| **Extent** | Only catchments visible in the current viewport |
| **Site** | Only catchments inside the open site's boundary |

**Site** is unavailable in Explore mode, because there is no boundary to aggregate to.

!!! tip "Not every factor appears in every view"
    The factor list is filtered by what the data declares each factor suitable for. A
    factor may be mappable but not graphable, or vice versa. Dial view additionally
    requires the factor to declare a dial type.

!!! success "What you achieved"
    - You can choose a factor from the loaded data
    - You can set the two scenarios being compared
    - You understand what Full, Extent and Site each summarise over

<div class="step-nav" markdown>

[:material-arrow-left: Step 4 — Open the map](open-the-map.md){ .md-button }

[Step 6 — Compare two scenarios :material-arrow-right:](compare-two-scenarios.md){ .md-button .md-button--primary .next-step }

</div>
