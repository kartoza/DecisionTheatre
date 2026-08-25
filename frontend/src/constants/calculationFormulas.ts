/**
 * Human-readable descriptions of the ecological recalculation workflows and
 * per-column formulas that the backend (recalculate.go) applies whenever the
 * user edits a TargetInputsAllowed field.
 */

// ─── Per-column formula registry ──────────────────────────────────────────────

export interface ColumnFormula {
  workflow: string;
  formula: string;
  explanation: string;
}

export const COLUMN_FORMULAS: Record<string, ColumnFormula> = {
  // ── Tree-cover zone fractions ────────────────────────────────────────────
  highTC_prop: {
    workflow: "Tree Cover (§1)",
    formula: "highTC_prop = 1 − lowTC_prop",
    explanation:
      "High-tree-cover fraction is always the complement of the low-tree-cover fraction so the two zones sum to 100 % of the landscape.",
  },

  // ── Biomass-class proportions ────────────────────────────────────────────
  // When lowTC_prop is edited directly (§1.1), classes within each zone are
  // redistributed equally.  When meanTC is edited (§1.3), each class shifts
  // by ±diff/10.  When individual classes are edited (§1.2) they are
  // normalised to sum to 1 first.

  // ── Tree-cover-derived indicators ───────────────────────────────────────
  AGBwd_Mgha: {
    workflow: "Tree Cover (§1)",
    formula: "AGBwd = Σᵢ ( prop_class[i] × AGB_midpoint[i] )",
    explanation:
      "Weighted sum of above-ground woody biomass (Mg/ha). " +
      "AGB midpoints for the 10 tree-cover classes are " +
      "2.5, 7.5, 15, 25, 35, 45, 55, 65, 75, 90 Mg/ha. " +
      "Each class proportion is multiplied by its midpoint and the results are summed.",
  },
  LitterBiomass_gm2: {
    workflow: "Tree Cover (§1)",
    formula: "LitterBiomass = Σᵢ ( prop_class[i] × litter_midpoint[i] )",
    explanation:
      "Weighted sum of litter biomass (g/m²). " +
      "Litter midpoints for the 10 classes are " +
      "6.0, 18.0, 36.0, 70.0, 98.0, 144.0, 198.0, 260.0, 330.0, 432.0 g/m². " +
      "Derived from leaf mass fraction (LMF = 4%) of AGB, adjusted for evergreen fraction per class, ×100 to convert Mg/ha to g/m².",
  },
  meanTC: {
    workflow: "Tree Cover (§1)",
    formula: "meanTC = Σᵢ ( prop_class[i] × treeCover_midpoint[i] )",
    explanation:
      "Weighted mean tree cover (%) across all 10 tree-cover classes, range 0–100. " +
      "The tree-cover-percentage midpoints (2.5, 7.5, 15, 25, 35, 45, 55, 65, 75, 90 %) happen to share the " +
      "same numeric values as the AGB midpoints used for AGBwd_Mgha, since each biomass class was defined to " +
      "align with a matching tree-cover band — but meanTC itself is a percentage, not a biomass quantity.",
  },
  NPP_gm2: {
    workflow: "Tree Cover (§1)",
    formula: "NPP = Σᵢ ( prop_class[i] × site_NPP_by_treecover[i] )\n  [fallback: NPP × (new_lowTC / old_lowTC)]",
    explanation:
      "Net primary productivity (g/m²). " +
      "When site-specific NPP-by-tree-cover lookup data are available, NPP is the " +
      "weighted sum of lookup values across all 10 classes (from pre-computed R script output). " +
      "Otherwise NPP scales proportionally with the change in low-tree-cover fraction.",
  },
  flamNPP_gm2: {
    workflow: "Tree Cover (§1)",
    formula: "flamNPP = Σᵢ₌₀⁵ ( prop_class[i] × site_NPP_by_treecover[i] )\n  [fallback: flamNPP × (new_lowTC / old_lowTC)]",
    explanation:
      "Flammable NPP — the same weighted-NPP sum but restricted to the six low-TC " +
      "classes (biomass < 50 Mg/ha) which are the areas capable of carrying fire. " +
      "Otherwise scales proportionally with the change in low-tree-cover fraction, same as NPP_gm2. " +
      "Feeds directly into fuelload_gm2 for the fire cascade.",
  },
  "NPP_gm2.1": {
    workflow: "Tree Cover (§1 step 3) / Herbivores → Grazing Intensity",
    formula: "NPP_gm2.1 = max( 0,  NPP_gm2 − herbs_totGRAZING_DMI_gm2 )",
    explanation:
      "Grass standing biomass (g/m²) — grass NPP net of what grazers consume, floored at zero " +
      "(grazers can't remove more grass than was produced). " +
      "Recomputed together with grazing_intensity whenever NPP or grazing DMI changes.",
  },
  deltaSOC_Mgha_trees: {
    workflow: "SOC — Tree Cover Branch (§3 Branch 1)",
    formula:
      "deltaSOC_trees = Σᵢ(target_prop[i] × SOC_lookup[i])\n" +
      "               − Σᵢ(current_prop[i] × SOC_lookup[i])",
    explanation:
      "Change in soil organic carbon (Mg/ha) due to vegetation change. " +
      "The SOC stock is estimated separately for both the target and current class distributions " +
      "using site-specific SOC-by-tree-cover lookup values, and the difference is taken. " +
      "Fallback: scales with the high-TC fraction when lookup data are unavailable.",
  },

  // ── Herbivores ───────────────────────────────────────────────────────────
  herbs_tot_kgkm2: {
    workflow: "Herbivores (§4)",
    formula: "herbs_tot = Σ( herbs_sp_kgkm2_[species] )\n  [direct edit: all herbs_* sub-fields × (new / old)]",
    explanation:
      "Total herbivore biomass (kg/km²) summed over all species. " +
      "When this field is edited directly, every other herbivore sub-field " +
      "(DMI, CH4, grazing fractions, functional groups, diet groups) is " +
      "scaled proportionally by the ratio new_total / old_total.",
  },
  herbs_tot_DMI_gm2: {
    workflow: "Herbivores (§4)",
    formula: "herbs_tot_DMI = Σ( herbs_sp_DMI_gm2_[species] )\n  [direct edit: scaled by new_total / old_total]",
    explanation:
      "Total herbivore dry matter intake (g/m²/yr) summed over all species. " +
      "Per-species DMI = counts × DMI_per_individual (kg/head/yr) from the species trait table, " +
      "÷1000 to convert from kg/km²/yr to g/m²/yr.",
  },
  herbs_tot_CH4_kgkm2: {
    workflow: "Herbivores (§4)",
    formula: "herbs_tot_CH4 = Σ( herbs_sp_CH4_kgkm2_[species] )\n  [direct edit: scaled by new_total / old_total]",
    explanation:
      "Total herbivore enteric methane (kg/km²/yr) summed over all species. " +
      "Per-species CH4 = counts × CH4_per_individual (kg/head/yr), derived from allometric equations " +
      "for ruminants and non-ruminants based on body mass.",
  },
  herbs_totGRAZING_kgkm2: {
    workflow: "Herbivores (§4)",
    formula: "herbs_totGRAZING = Σ( herbs_sp_kgkm2_[sp] × Prop_Grass[sp] )",
    explanation:
      "Total biomass of grazing herbivores (kg/km²) — only the grass-consuming fraction " +
      "of each species' biomass, weighted by that species' Prop_Grass trait value.",
  },
  herbs_totGRAZING_DMI_gm2: {
    workflow: "Herbivores (§4)",
    formula: "herbs_totGRAZING_DMI = Σ( herbs_sp_DMI_gm2_[sp] × Prop_Grass[sp] )",
    explanation:
      "Dry matter intake (g/m²/yr) attributable to grazing — only the grass portion of each " +
      "species' DMI, weighted by Prop_Grass. Used for fuel-load reduction and grazing intensity, " +
      "both directly in g/m² with no further unit conversion.",
  },
  herbs_totGRAZING_CH4_kgkm2: {
    workflow: "Herbivores (§4)",
    formula: "herbs_totGRAZING_CH4 = Σ( herbs_sp_CH4_kgkm2_[sp] × Prop_Grass[sp] )",
    explanation:
      "Enteric methane (kg/km²/yr) from the grazing fraction of all herbivores, " +
      "weighted by each species' Prop_Grass trait.",
  },
  fracGrazing: {
    workflow: "Herbivores (§4)",
    formula: "fracGrazing = herbs_totGRAZING_kgkm2 / herbs_tot_kgkm2",
    explanation:
      "Fraction of total herbivore biomass that belongs to grazing species " +
      "(those whose diet includes a significant grass component).",
  },
  grazing_intensity: {
    workflow: "Herbivores → Grazing Intensity",
    formula: "GI = min( 1,  herbs_totGRAZING_DMI_gm2 / NPP_gm2 )",
    explanation:
      "Dimensionless grazing intensity (0 – 1). " +
      "Divides total grazing dry-matter intake by grass production — both already " +
      "expressed in g/m², so no unit conversion is needed. " +
      "A value of 1 means grazers consume all available grass.",
  },

  // ── SOC — Grazing branch ─────────────────────────────────────────────────
  deltaSOC_Mgha_grazers: {
    workflow: "SOC — Grazing Branch (§3 Branch 2)",
    formula:
      "% SOC change = −5.916 + 0.587 × (GI×100) − 0.00936 × (GI×100)²\n" +
      "deltaSOC_grazers = SOC_Mgha_0_30 × (% SOC change at target GI / 100)\n" +
      "                 − SOC_Mgha_0_30 × (% SOC change at baseline GI / 100)",
    explanation:
      "A quadratic polynomial (Ren et al. 2023) relates grazing intensity (GI, expressed as 0–100 %) " +
      "to the percentage change in soil carbon relative to no grazing. " +
      "Multiplying by the 0–30 cm SOC stock (Mg/ha) gives an absolute change. " +
      "The baseline SOC effect at the pre-edit grazing intensity is subtracted so the result " +
      "is the net SOC change caused by this edit alone.",
  },
  deltaSOC_Mgha: {
    workflow: "SOC Total (§3)",
    formula: "deltaSOC_Mgha = deltaSOC_Mgha_trees + deltaSOC_Mgha_grazers",
    explanation:
      "Total soil-carbon change (Mg/ha) combining both the tree-cover shift (Branch 1) " +
      "and the grazing-pressure change (Branch 2).",
  },

  // ── Fire cascade ─────────────────────────────────────────────────────────
  fuelload_gm2: {
    workflow: "Fire Cascade (§2)",
    formula: "fuelload = max( 0,  flamNPP_gm2 + LitterBiomass_gm2 − herbs_totGRAZING_DMI_gm2 )",
    explanation:
      "Available fire fuel (g/m²). " +
      "Uses flammable-zone NPP (flamNPP_gm2, the low-tree-cover classes only), not total NPP — " +
      "fire only carries through the open part of the landscape. " +
      "Plus standing litter, minus the grass consumed by grazers " +
      "— all three terms are already in g/m², so no unit conversion is needed. " +
      "Herbivores reduce fuel load and thereby suppress fire.",
  },
  Intensity_early_kW_m: {
    workflow: "Fire Cascade (§2)",
    formula: "Intensity_early = exp( 6.65747 + 0.0011896 × fuelload_gm2 ) − exp( 6.65747 )",
    explanation:
      "Fireline intensity for early-season (April) fires (kW/m). " +
      "An exponential function of fuel load fitted to Kruger National Park burning data. " +
      "The offset exp(6.65747) is subtracted so intensity is zero at zero fuel load.",
  },
  Intensity_late_kW_m: {
    workflow: "Fire Cascade (§2)",
    formula: "Intensity_late = min( 17 000,  exp( 6.65747 + 0.003535 × fuelload_gm2 ) − exp( 6.65747 ) )\n" +
      "  [in high-rainfall areas MAR > 1500 mm: Intensity_late = Intensity_early]",
    explanation:
      "Late-season (October) fire intensity (kW/m) with a steeper fuel-load coefficient and an upper cap " +
      "of 17 000 kW/m (maximum observed fireline intensity). " +
      "In high-rainfall areas the late-season behaviour matches early season.",
  },
  percBurned_early: {
    workflow: "Fire Cascade (§2)",
    formula: "areaBurned_early = max( 0, 98.24 − 97.95 × exp(−0.001122 × Intensity_early) )\n" +
      "percBurned_early = areaBurned_early × lowTC_prop",
    explanation:
      "Percentage of the landscape burned by early fires. " +
      "The area-burned model is an asymptotic function of fire intensity fitted to field data " +
      "(Dick Williams 1989, modified). " +
      "The result is scaled by the open (low tree-cover) fraction because only " +
      "open grassland can carry surface fire.",
  },
  percBurned_late: {
    workflow: "Fire Cascade (§2)",
    formula: "areaBurned_late = max( 0, 98.24 − 97.95 × exp(−0.001122 × Intensity_late) )\n" +
      "percBurned_late = areaBurned_late × lowTC_prop",
    explanation: "Same formula as early-season burn but using late-season fire intensity.",
  },
  percBurned: {
    workflow: "Fire Cascade (§2)",
    formula: "percBurned = propEarly × percBurned_early + (1 − propEarly) × percBurned_late",
    explanation:
      "Blended annual burn percentage, weighted by the proportion of early-season " +
      "fires (propEarly). propEarly defaults to 0.45 if not set.",
  },
  fuelConsumption_early_gm2: {
    workflow: "Fire Cascade (§2)",
    formula: "fuelConsumption_early = fuelload_gm2 × percBurned_early / 100",
    explanation:
      "Grass biomass consumed by early-season fires (g/m²). " +
      "Assumes 100% combustion of the fuel in the burned area.",
  },
  fuelConsumption_late_gm2: {
    workflow: "Fire Cascade (§2)",
    formula: "fuelConsumption_late = fuelload_gm2 × percBurned_late / 100",
    explanation:
      "Grass biomass consumed by late-season fires (g/m²). " +
      "Assumes 100% combustion of the fuel in the burned area.",
  },
  fuelConsumption_gm2: {
    workflow: "Fire Cascade (§2)",
    formula:
      "fuelConsumption = fuelConsumption_early × propEarly + fuelConsumption_late × (1 − propEarly)",
    explanation:
      "Blended annual fuel consumption (g/m²) across early and late seasons. " +
      "A higher percentage burned or greater fuel load both increase consumption.",
  },
  CH4_early_kg_km2: {
    workflow: "Fire Cascade (§2)",
    formula:
      "EFCH4_early = 66 × (1 − 0.92) − 2 = 3.28  g CH4 / kg dry matter\n" +
      "CH4_early = fuelConsumption_early_gm2 × EFCH4_early",
    explanation:
      "Methane emitted by early-season fires (kg/km²). " +
      "The emission factor uses modified combustion efficiency MCE = 0.92 for early fires. " +
      "Units: g/m² × g CH4/kg DM = kg CH4/km².",
  },
  CH4_late_kg_km2: {
    workflow: "Fire Cascade (§2)",
    formula:
      "EFCH4_late = 66 × (1 − 0.96) − 2 = 0.64  g CH4 / kg dry matter\n" +
      "CH4_late = fuelConsumption_late_gm2 × EFCH4_late",
    explanation:
      "Methane emitted by late-season fires (kg/km²). " +
      "Late fires burn more completely (MCE = 0.96) so emit less CH4 per unit fuel than early fires.",
  },
  CH4_kg_km2: {
    workflow: "Fire Cascade (§2)",
    formula:
      "CH4_fire = CH4_early_kg_km2 × propEarly + CH4_late_kg_km2 × (1 − propEarly)",
    explanation:
      "Total fire methane (kg/km²) blended across early and late seasons by propEarly.",
  },
  CH4_both_kg_km2: {
    workflow: "Fire + Herbivores",
    formula: "CH4_both = CH4_kg_km2 + herbs_tot_CH4_kgkm2",
    explanation:
      "Total methane from both fire combustion and herbivore enteric fermentation.",
  },
};

// ─── Workflow chain descriptions ───────────────────────────────────────────────

export interface WorkflowStep {
  name: string;
  trigger: string;
  steps: string[];
  outputs: string[];
}

const LOW_TC_COLS = [
  "prop_X0_5Mgha", "prop_X05_10Mgha", "prop_X10_20Mgha",
  "prop_X20_30Mgha", "prop_X30_40Mgha", "prop_X40_50Mgha",
];
const HIGH_TC_COLS = [
  "prop_X50_60Mgha", "prop_X60_70Mgha", "prop_X70_80Mgha", "prop_X80_100Mgha",
];
const ALL_TC_COLS = [...LOW_TC_COLS, ...HIGH_TC_COLS];

function anyChanged(changed: Set<string>, keys: string[]): boolean {
  return keys.some((k) => changed.has(k));
}

function anyPrefix(changed: Set<string>, prefix: string): boolean {
  return [...changed].some((k) => k.startsWith(prefix));
}

/**
 * Given the set of column keys that the user changed, returns an ordered list
 * of workflow steps that the backend executed, with plain-English descriptions.
 */
export function getTriggeredWorkflows(changedKeys: string[]): WorkflowStep[] {
  const changed = new Set(changedKeys);
  const steps: WorkflowStep[] = [];

  const lowTCChanged = changed.has("lowTC_prop");
  const meanTCChanged = changed.has("meanTC");
  const propClassChanged = anyChanged(changed, ALL_TC_COLS);
  const herbsTotChanged = changed.has("herbs_tot_kgkm2");
  const speciesCountsChanged = anyPrefix(changed, "herbs_sp_counts_");
  const speciesBiomassChanged = anyPrefix(changed, "herbs_sp_kgkm2_");
  const nppChanged = changed.has("NPP_gm2");
  const propEarlyChanged = changed.has("propEarly");
  const anyHerbChange = herbsTotChanged || speciesCountsChanged || speciesBiomassChanged;
  const anyTreeChange = lowTCChanged || meanTCChanged || propClassChanged;

  // §1.3 — meanTC edited directly
  if (meanTCChanged && !lowTCChanged && !propClassChanged) {
    steps.push({
      name: "Tree Cover §1.3 — Mean Tree Cover edited directly",
      trigger: "You set meanTC directly.",
      steps: [
        "Recompute the actual current meanTC from today's class proportions (the stored value may not exactly match the weighted-midpoint sum)",
        "Solve shift = (actual_old_meanTC − new_meanTC) / (Σ decreasing-class midpoints − Σ increasing-class midpoints), so the new weighted mean hits the target exactly",
        "5 low-TC classes (0–40 Mg/ha midpoints) each increase by shift",
        "5 high-TC classes (40–100 Mg/ha midpoints) each decrease by shift — not clamped, so a target outside the reachable range can push a class negative",
        "Recalculate lowTC_prop and highTC_prop from updated class sums",
        "Run shared prop-derived metrics (AGBwd, LitterBiomass, meanTC, NPP, flamNPP, deltaSOC_trees)",
        "Recompute NPP_gm2.1 = max(0, NPP_gm2 − herbs_totGRAZING_DMI_gm2) and grazing_intensity = min(1, herbs_totGRAZING_DMI_gm2 / NPP_gm2)",
        "deltaSOC_Mgha = deltaSOC_Mgha_trees + deltaSOC_Mgha_grazers",
      ],
      outputs: ["lowTC_prop", "highTC_prop", "meanTC", "AGBwd_Mgha", "LitterBiomass_gm2", "NPP_gm2", "flamNPP_gm2", "deltaSOC_Mgha_trees", "grazing_intensity", "deltaSOC_Mgha"],
    });
  }

  // §1.2 — individual prop_X* classes edited
  if (propClassChanged && !lowTCChanged) {
    steps.push({
      name: "Tree Cover §1.2 — Biomass class proportions edited",
      trigger: "You edited one or more prop_X*Mgha biomass class columns.",
      steps: [
        "Normalise all 10 class proportions so they sum to exactly 1",
        "Recalculate lowTC_prop = sum of the 6 low-TC classes (0–50 Mg/ha)",
        "Recalculate highTC_prop = sum of the 4 high-TC classes (50–100 Mg/ha)",
        "Run shared prop-derived metrics (AGBwd, LitterBiomass, meanTC, NPP, flamNPP, deltaSOC_trees)",
        "Recompute NPP_gm2.1 = max(0, NPP_gm2 − herbs_totGRAZING_DMI_gm2) and grazing_intensity = min(1, herbs_totGRAZING_DMI_gm2 / NPP_gm2)",
        "deltaSOC_Mgha = deltaSOC_Mgha_trees + deltaSOC_Mgha_grazers",
      ],
      outputs: ["lowTC_prop", "highTC_prop", "meanTC", "AGBwd_Mgha", "LitterBiomass_gm2", "NPP_gm2", "flamNPP_gm2", "deltaSOC_Mgha_trees", "grazing_intensity", "deltaSOC_Mgha"],
    });
  }

  // §1.1 — lowTC_prop edited directly
  if (lowTCChanged) {
    steps.push({
      name: "Tree Cover §1.1 — Open Ecosystem proportion edited",
      trigger: "You set lowTC_prop (proportion open ecosystem) directly.",
      steps: [
        "Clamp new lowTC_prop to [0, 1]",
        "Set highTC_prop = 1 − lowTC_prop",
        "Redistribute the 6 low-TC biomass classes equally: each = lowTC_prop / 6",
        "Redistribute the 4 high-TC biomass classes equally: each = highTC_prop / 4",
        "Run shared prop-derived metrics (AGBwd, LitterBiomass, meanTC, NPP, flamNPP, deltaSOC_trees)",
        "Recompute NPP_gm2.1 = max(0, NPP_gm2 − herbs_totGRAZING_DMI_gm2) and grazing_intensity = min(1, herbs_totGRAZING_DMI_gm2 / NPP_gm2)",
        "deltaSOC_Mgha = deltaSOC_Mgha_trees + deltaSOC_Mgha_grazers",
      ],
      outputs: ["lowTC_prop", "highTC_prop", "AGBwd_Mgha", "LitterBiomass_gm2", "meanTC", "NPP_gm2", "flamNPP_gm2", "deltaSOC_Mgha_trees", "grazing_intensity", "deltaSOC_Mgha"],
    });
  }

  // §2/§4a/§4b — herbivore edits are mutually exclusive in the backend: a
  // single PATCH only runs one of these three workflows, in this priority
  // order (herbs_tot_kgkm2 wins over species counts, which wins over species
  // biomass), even if multiple herbs_* fields were changed in the same edit.
  if (herbsTotChanged) {
    steps.push({
      name: "Herbivores §2 — Total biomass edited directly",
      trigger: "You set herbs_tot_kgkm2 (total herbivore biomass) directly.",
      steps: [
        "Compute scale = new_total / old_total",
        "Scale all herbs_* sub-fields proportionally (DMI, CH4, grazing fractions, per-species, functional groups, diet groups)",
        "fracGrazing = herbs_totGRAZING_kgkm2 / herbs_tot_kgkm2",
        "Recalculate NPP_gm2.1 = max(0, NPP_gm2 − herbs_totGRAZING_DMI_gm2) and grazing_intensity = min(1, herbs_totGRAZING_DMI_gm2 / NPP_gm2)",
      ],
      outputs: [
        "herbs_tot_DMI_gm2", "herbs_tot_CH4_kgkm2",
        "herbs_totGRAZING_kgkm2", "herbs_totGRAZING_DMI_gm2", "herbs_totGRAZING_CH4_kgkm2",
        "fracGrazing", "NPP_gm2.1", "grazing_intensity",
        "herbs_sp_kgkm2_*", "herbs_sp_counts_*", "herbs_sp_DMI_gm2_*", "herbs_sp_CH4_kgkm2_*",
        "herbs_fg_kgkm2_*", "herbs_fg_counts_*", "herbs_fg_DMI_gm2_*", "herbs_fg_CH4_kgkm2_*",
        "herbs_diet_kgkm2_*", "herbs_diet_counts_*", "herbs_diet_DMI_gm2_*", "herbs_diet_CH4_kgkm2_*",
      ],
    });
  } else if (speciesCountsChanged) {
    steps.push({
      name: "Herbivores §4a — Species counts edited",
      trigger: "You edited one or more species headcount columns (herbs_sp_counts_*).",
      steps: [
        "For each changed species: biomass = count × body_mass (kg/individual)",
        "For each changed species: DMI = count × DMI_per_individual (kg/km²/yr), ÷1000 to g/m²/yr",
        "For each changed species: CH4 = count × CH4_per_individual (kg/km²/yr)",
        "Recompute total biomass, DMI, CH4 as sums over all species",
        "Recompute grazing totals (×Prop_Grass) and diet/functional-group aggregates",
        "fracGrazing = herbs_totGRAZING_kgkm2 / herbs_tot_kgkm2",
        "Recalculate NPP_gm2.1 = max(0, NPP_gm2 − herbs_totGRAZING_DMI_gm2) and grazing_intensity = min(1, herbs_totGRAZING_DMI_gm2 / NPP_gm2)",
      ],
      outputs: [
        "herbs_sp_kgkm2_*", "herbs_sp_DMI_gm2_*", "herbs_sp_CH4_kgkm2_*",
        "herbs_tot_kgkm2", "herbs_tot_DMI_gm2", "herbs_tot_CH4_kgkm2",
        "herbs_totGRAZING_kgkm2", "herbs_totGRAZING_DMI_gm2", "herbs_totGRAZING_CH4_kgkm2",
        "fracGrazing", "NPP_gm2.1", "grazing_intensity",
        "herbs_fg_kgkm2_*", "herbs_fg_counts_*", "herbs_fg_DMI_gm2_*", "herbs_fg_CH4_kgkm2_*",
        "herbs_diet_kgkm2_*", "herbs_diet_counts_*", "herbs_diet_DMI_gm2_*", "herbs_diet_CH4_kgkm2_*",
      ],
    });
  } else if (speciesBiomassChanged) {
    steps.push({
      name: "Herbivores §4b — Species biomass edited",
      trigger: "You edited one or more species biomass columns (herbs_sp_kgkm2_*).",
      steps: [
        "For each species: count = biomass / body_mass",
        "For each species: DMI = count × DMI_per_individual (kg/km²/yr), ÷1000 to g/m²/yr",
        "For each species: CH4 = count × CH4_per_individual",
        "Recompute total biomass, DMI, CH4 and all aggregates",
        "Recalculate NPP_gm2.1 = max(0, NPP_gm2 − herbs_totGRAZING_DMI_gm2) and grazing_intensity = min(1, herbs_totGRAZING_DMI_gm2 / NPP_gm2)",
      ],
      outputs: [
        "herbs_sp_counts_*", "herbs_sp_DMI_gm2_*", "herbs_sp_CH4_kgkm2_*",
        "herbs_tot_kgkm2", "herbs_tot_DMI_gm2", "herbs_tot_CH4_kgkm2",
        "herbs_totGRAZING_kgkm2", "herbs_totGRAZING_DMI_gm2", "herbs_totGRAZING_CH4_kgkm2",
        "fracGrazing", "NPP_gm2.1", "grazing_intensity",
        "herbs_fg_kgkm2_*", "herbs_fg_counts_*", "herbs_fg_DMI_gm2_*", "herbs_fg_CH4_kgkm2_*",
        "herbs_diet_kgkm2_*", "herbs_diet_counts_*", "herbs_diet_DMI_gm2_*", "herbs_diet_CH4_kgkm2_*",
      ],
    });
  }

  // §3 Branch 2 — SOC grazing (runs whenever tree cover, NPP, or grazing DMI changes)
  if (anyTreeChange || anyHerbChange || nppChanged) {
    steps.push({
      name: "SOC Grazing §3 Branch 2 — Grazer carbon effect",
      trigger: "Triggered automatically because tree cover, NPP, or grazing DMI changed.",
      steps: [
        "Compute target grazing intensity: GI = min(1, herbs_totGRAZING_DMI_gm2 / NPP_gm2)",
        "Compute baseline GI at old values (before the edit)",
        "% SOC change = −5.916 + 0.587 × (GI×100) − 0.00936 × (GI×100)²  [Ren et al. 2023]",
        "deltaSOC_grazers = SOC_0_30 × (% SOC change at target GI / 100) − SOC_0_30 × (% SOC change at baseline GI / 100)",
        "deltaSOC_Mgha = deltaSOC_Mgha_trees + deltaSOC_Mgha_grazers",
      ],
      outputs: ["deltaSOC_Mgha_grazers", "deltaSOC_Mgha"],
    });
  }

  // NPP_gm2 edited directly
  if (nppChanged && !anyTreeChange) {
    steps.push({
      name: "Grass NPP — edited directly",
      trigger: "You set NPP_gm2 (net primary productivity) directly.",
      steps: [
        "Recalculate NPP_gm2.1 = max(0, NPP_gm2 − herbs_totGRAZING_DMI_gm2) and grazing_intensity = min(1, herbs_totGRAZING_DMI_gm2 / NPP_gm2)",
      ],
      outputs: ["NPP_gm2.1", "grazing_intensity"],
    });
  }

  // Fire cascade (runs whenever tree cover, herbs, NPP, or propEarly changes)
  if (anyTreeChange || anyHerbChange || nppChanged || propEarlyChanged) {
    steps.push({
      name: "Fire Cascade §2 — Fire regime recalculation",
      trigger: "Triggered automatically because NPP, litter, grazing DMI, tree cover, or propEarly changed.",
      steps: [
        "Fuel load = max(0, flamNPP_gm2 + LitterBiomass_gm2 − herbs_totGRAZING_DMI_gm2)",
        "Intensity_early = exp(6.65747 + 0.0011896 × fuelload) − exp(6.65747)",
        "Intensity_late  = min(17 000, exp(6.65747 + 0.003535 × fuelload) − exp(6.65747))",
        "  [In high-rainfall areas MAR > 1500 mm: Intensity_late = Intensity_early]",
        "areaBurned = max(0, 98.24 − 97.95 × exp(−0.001122 × intensity)) per season",
        "percBurned_early = areaBurned_early × lowTC_prop",
        "percBurned_late  = areaBurned_late  × lowTC_prop",
        "fuelConsumption_early = fuelload × percBurned_early / 100",
        "fuelConsumption_late  = fuelload × percBurned_late  / 100",
        "CH4_early = fuelConsumption_early × 3.28 g/kg  (MCE 0.92)",
        "CH4_late  = fuelConsumption_late  × 0.64 g/kg  (MCE 0.96)",
        "Blend early/late: percBurned = propEarly×early + (1−propEarly)×late",
        "CH4_both = fire_CH4 + herbs_tot_CH4_kgkm2",
      ],
      outputs: [
        "fuelload_gm2",
        "Intensity_early_kW_m", "Intensity_late_kW_m",
        "percBurned_early", "percBurned_late", "percBurned",
        "fuelConsumption_early_gm2", "fuelConsumption_late_gm2", "fuelConsumption_gm2",
        "CH4_early_kg_km2", "CH4_late_kg_km2", "CH4_kg_km2", "CH4_both_kg_km2",
      ],
    });
  }

  return steps;
}
