# Step 13 — Set target values

!!! abstract "Goal"
    Say what you are aiming for, and see what it implies.

## Background

This is the point of the tool. Setting a target is not just annotation — the application
recalculates the ecological consequences, so changing tree cover moves the factors that
depend on it.

Target State starts equal to Current State. It only diverges where you make it.

<figure markdown>
  ![Where step 13 sits in the guide](../assets/diagrams/generated/journey-13.svg)
  <figcaption class="gen">
    Your place in the guide.
  </figcaption>
</figure>

<figure markdown>
  ![Set target values](../assets/diagrams/generated/indicator-cascade.svg)
  <figcaption class="static">
    Set target values.
  </figcaption>
</figure>

## Steps

### Quick edit — the Targets modal

1. In grid view, once the site has indicators, click **Targets** in the top toolbar.

![Editing target values by category](../assets/images/screenshots/targets-modal.jpg)

2. Values are grouped by category — Fire, Herbivores, Vegetation Structure and so on — in
   a collapsible accordion.
3. Expand a group to reveal a labelled slider per indicator, showing its current value,
   unit and allowed range.
4. Click **Save**. Only the sliders you actually moved are applied.

### Full editor — the Indicators page

For finer control, use the Indicators page from the previous step, which exposes every
indicator with its bounds.

### Seeing the result

Set **Scenario 2 (Right)** to **Target State** and the map, chart, dial and table all
redraw against your target rather than current conditions.

!!! warning "Targets are checked for plausibility"
    Saving a target that is not ecologically plausible raises a warning — for example
    setting grazing intake more than ten times current plant productivity shows
    *"Herbivore consumption is higher than available biomass."* This is an early-stage
    check and more rules may be added.

!!! success "What you achieved"
    - You can set target values for any indicator
    - You have seen dependent factors recalculate
    - You can compare Target State against Current on any view

<div class="step-nav" markdown>

[:material-arrow-left: Step 12 — Review your indicators](review-your-indicators.md){ .md-button }

[Step 14 — Refine a boundary :material-arrow-right:](refine-a-boundary.md){ .md-button .md-button--primary .next-step }

</div>
