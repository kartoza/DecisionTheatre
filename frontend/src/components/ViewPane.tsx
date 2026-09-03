import { useEffect, useMemo, useState } from 'react';
import {
  Box, Flex, HStack, IconButton, Spinner, Text, Tooltip,
  useColorModeValue,
} from '@chakra-ui/react';
import { FiBarChart2, FiInfo, FiMap, FiMaximize, FiGrid, FiMinus, FiTable, FiTrash2, FiSliders } from 'react-icons/fi';
import { BsGrid3X3, BsGrid, BsSpeedometer2 } from 'react-icons/bs';
import MapView from './MapView';
import PaneHeader from './PaneHeader';
import ChartView from './ChartView';
import DialChart from './DialChart';
import FlatDial from './FlatDial';
import { attributeSpread, capRange, hasDeclaredMax, hasDeclaredMin } from '../lib/dialScale';
import { loadSiteRange, saveSiteRange, siteRangeFingerprint } from '../lib/siteRangeCache';
import type { ScaleDerivation } from '../lib/dialScale';
import type { CalculationDetailsProps } from './CalculationDetails';
import AggregateTable from './AggregateTable';
import type { ComparisonState, LayoutMode, QuadColumns, IdentifyResult, MapExtent, MapStatistics, BoundingBox, ColorScaleMode, ColorScaleType, ViewMode, RangeMode, SiteIndicators } from '../types';
import { SCENARIOS } from '../types';
import { fetchAggregate, getSiteCatchments, useAttributeDetails, useAttributeDial0Middle, useAttributeTargetRanges, useAttributeUnits } from '../hooks/useApi';
import type { FullDomainData } from '../hooks/useApi';
import { computeAOIWeightedAttributeValue } from '../utils/indicators';

interface ViewPaneProps {
  comparison: ComparisonState;
  compact?: boolean;
  paneCount?: number;
  paneIndex: number;
  layoutMode: LayoutMode;
  viewMode: ViewMode;
  onViewModeChange: (paneIndex: number, mode: ViewMode) => void;
  onFocusPane: (index: number) => void;
  onGoQuad: () => void;
  onOpenControlPanel?: (paneIndex: number) => void;
  /**
   * Open the details panel for this pane, handing up the derivation it should
   * show. Passed at the moment of opening rather than held in App, so the panel
   * cannot show a stale account of a chart that has since changed.
   */
  onOpenChartDetails?: (
    paneIndex: number,
    derivation: ScaleDerivation | null,
    calculations: CalculationDetailsProps | null,
  ) => void;
  canRemove?: boolean;
  onRemovePane?: (paneIndex: number) => void;
  onIdentify?: (result: IdentifyResult) => void;
  identifyResult?: IdentifyResult;
  onMapExtentChange?: (extent: MapExtent) => void;
  onStatisticsChange?: (stats: MapStatistics) => void;
  isPanelOpen?: boolean;
  siteId?: string | null;
  siteBounds?: BoundingBox | null;
  isBoundaryEditMode?: boolean;
  siteGeometry?: GeoJSON.Geometry | null;
  onBoundaryUpdate?: (geometry: GeoJSON.Geometry) => void;
  isSwiperEnabled?: boolean;
  colorScaleMode: ColorScaleMode;
  colorScaleType: ColorScaleType;
  is3DMode?: boolean;
  // Global map toggles: one control in the header, every pane reflects it.
  isIdentifyMode?: boolean;
  isChoroplethEnabled?: boolean;
  isGoogleBasemap?: boolean;
  onGoogleBasemapChange?: (enabled: boolean) => void;
  showNavigation?: boolean;
  // Slider synchronization
  swiperPosition?: number;
  onSwiperPositionChange?: (position: number) => void;
  // Dial chart props
  siteIndicators?: SiteIndicators | null;
  rangeMode?: RangeMode;
  mapStatistics?: MapStatistics | null;
  chartGroup?: string | null;
  chartAxisLabelFilter?: string | null;
  chartGraphMode?: 'line' | 'boxplot' | null;
  mapExtent?: MapExtent | null;
  refreshKey?: number;
  targetHasBeenUpdated?: boolean;
  editableTargetKeys?: string[];
  quadColumns?: QuadColumns;
  onQuadColumnsChange?: (cols: QuadColumns) => void;
  fullDomainData?: FullDomainData | null;
}

// View mode cycle order
const VIEW_MODES: ViewMode[] = ['map', 'chart', 'dial', 'table'];

// How long a pane keeps its map mounted after switching to another view.
//
// A mounted MapView holds a WebGL context (two in compare mode), and browsers
// cap the simultaneous total at around sixteen, silently dropping the oldest
// past that. Quad view renders six panes, so a pane showing a chart must not
// keep a map alive for the rest of the session — which is what the previous
// one-way "has shown a map" latch did. The delay is here because a teardown is
// not free: map -> chart -> map is a normal way to read a pane, and that round
// trip should not pay for a fresh MapLibre init and tile fetch. See issue #76.
const MAP_RELEASE_DELAY_MS = 15_000;

// Icons and labels for each view mode
const VIEW_MODE_CONFIG: Record<ViewMode, { icon: React.ReactElement; label: string; nextLabel: string }> = {
  map: { icon: <FiMap />, label: 'Map', nextLabel: 'Show line chart' },
  chart: { icon: <FiBarChart2 />, label: 'Chart', nextLabel: 'Show flat band' },
  flat: { icon: <FiMinus />, label: 'Flat', nextLabel: 'Show dial gauge' },
  dial: { icon: <BsSpeedometer2 />, label: 'Dial', nextLabel: 'Show aggregate table' },
  table: { icon: <FiTable />, label: 'Table', nextLabel: 'Show map' },
};

function ViewPane({
  comparison,
  compact = false,
  paneCount = 1,
  paneIndex,
  layoutMode,
  viewMode,
  onViewModeChange,
  onFocusPane,
  onGoQuad,
  onOpenControlPanel,
  onOpenChartDetails,
  canRemove = false,
  onRemovePane,
  onIdentify,
  identifyResult,
  onMapExtentChange,
  onStatisticsChange,
  isPanelOpen,
  siteId,
  siteBounds,
  isBoundaryEditMode,
  siteGeometry,
  onBoundaryUpdate,
  isSwiperEnabled,
  colorScaleMode,
  colorScaleType,
  is3DMode,
  isIdentifyMode,
  isChoroplethEnabled,
  isGoogleBasemap,
  onGoogleBasemapChange,
  showNavigation,
  swiperPosition,
  onSwiperPositionChange,
  siteIndicators,
  rangeMode = 'domain',
  mapStatistics,
  chartGroup,
  chartAxisLabelFilter,
  chartGraphMode,
  mapExtent,
  refreshKey,
  targetHasBeenUpdated = false,
  editableTargetKeys = [],
  quadColumns = 2,
  onQuadColumnsChange,
  fullDomainData,
}: ViewPaneProps) {
  const borderColor = useColorModeValue('gray.600', 'gray.600');
  const { details: attributeDetails } = useAttributeDetails();
  const { units: attributeUnits } = useAttributeUnits();
  const { dial0Middle: attributeDial0Middle } = useAttributeDial0Middle();
  const { targetRanges: attributeTargetRanges } = useAttributeTargetRanges();

  // Mount MapView only while the pane is showing a map, plus a grace period.
  // A pane that has never been in map mode never pays for map initialization
  // (tile loading, WebGL context) — the main cause of slow quad-view
  // transitions — and one that has left map mode gives its contexts back.
  const [mapMounted, setMapMounted] = useState(viewMode === 'map');
  // mapReady starts false; it becomes true once MapView fires onReady.
  // If the pane starts in map mode, mapMounted is true but mapReady stays
  // false until onReady fires — the spinner shows only during that initial load.
  const [mapReady, setMapReady] = useState(false);
  useEffect(() => {
    if (viewMode === 'map') {
      setMapMounted(true);
      return;
    }
    const releaseTimer = setTimeout(() => setMapMounted(false), MAP_RELEASE_DELAY_MS);
    // Returning to map mode inside the grace period cancels the release, so the
    // still-mounted MapView is simply revealed again — no reload, no spinner.
    return () => clearTimeout(releaseTimer);
  }, [viewMode]);

  // onReady fires once per MapView instance, so the spinner has to be re-armed
  // whenever the instance goes away. Doing it here rather than on the way into
  // map mode also guarantees it can never be left showing over a live map.
  useEffect(() => {
    if (!mapMounted) setMapReady(false);
  }, [mapMounted]);

  // Stagger WebGL context creation across panes so the browser/GPU isn't hit with
  // 8 simultaneous map initializations. Pane 0 starts immediately; each subsequent
  // pane waits an extra 250 ms, spreading the load over ~750 ms in grid view.
  const [mapMountReady, setMapMountReady] = useState(paneIndex === 0);
  useEffect(() => {
    if (paneIndex === 0) { setMapMountReady(true); return; }
    const id = setTimeout(() => setMapMountReady(true), paneIndex * 250);
    return () => clearTimeout(id);
  }, [paneIndex]);

  // Arc gauge or flat band. Both read the same scale (lib/dialScale) and take
  // the same props; only the drawing differs, so the choice is a swap of the
  // component and nothing else. Global rather than per pane — the point of
  // having two is comparing them, and six panes disagreeing would not help.

  // The shape is the view mode. It used to be a stored preference toggled on
  // each widget, which meant six identical toggles for one global choice; it is
  // now picked once from the header, beside the other views.
  const isDialView = viewMode === 'dial' || viewMode === 'flat';


  const [dialCatchmentData, setDialCatchmentData] = useState<{
    referenceValue?: number;
    currentValue?: number;
    /** The site's actual spread for this attribute, across its catchments. */
    spread?: { min: number; max: number } | null;
  } | null>(null);
  const [dialCatchmentLoading, setDialCatchmentLoading] = useState(false);
  const [dialRangeValues, setDialRangeValues] = useState<{
    referenceValue?: number;
    currentValue?: number;
  } | null>(null);
  const [dialRangeLoading, setDialRangeLoading] = useState(false);

  // What makes a cached site range stale: the site being re-extracted, or
  // covering a different set of catchments. Not the clock.
  const siteExtractedAt = siteIndicators?.extractedAt;
  const siteCatchmentCount = siteIndicators?.catchmentCount;

  useEffect(() => {
    if (!isDialView || !siteId || !comparison.attribute) {
      setDialCatchmentData(null);
      setDialCatchmentLoading(false);
      return;
    }

    let cancelled = false;
    setDialCatchmentLoading(true);

    // A remembered spread gives the dial a scale to draw against straight away,
    // rather than a placeholder until the catchments land. The values still
    // come from the fetch below; only the axis is answered early.
    const cachedSpread = loadSiteRange(
      siteId,
      siteRangeFingerprint(siteExtractedAt, siteCatchmentCount),
      comparison.attribute,
    );
    if (cachedSpread) {
      setDialCatchmentData((prev) => (prev ? { ...prev, spread: cachedSpread } : { spread: cachedSpread }));
    }

    getSiteCatchments(siteId)
      .then((catchments) => {
        if (cancelled || !catchments || catchments.length === 0) {
          if (!cancelled) setDialCatchmentLoading(false);
          return;
        }

        const referenceValue = computeAOIWeightedAttributeValue(catchments, 'reference', comparison.attribute);
        const currentValue = computeAOIWeightedAttributeValue(catchments, 'current', comparison.attribute);
        const spread = attributeSpread(catchments, comparison.attribute);
        // Keep the conclusion, not the payload it came from. Two numbers
        // survive the reload; the catchments do not need to.
        if (spread && siteId) {
          saveSiteRange(siteId, siteRangeFingerprint(siteExtractedAt, siteCatchmentCount), comparison.attribute, spread);
        }

        if (referenceValue === undefined && currentValue === undefined) {
          if (!cancelled) { setDialCatchmentData(null); setDialCatchmentLoading(false); }
          return;
        }

        if (!cancelled) {
          setDialCatchmentData({ referenceValue, currentValue, spread });
          setDialCatchmentLoading(false);
        }
      })
      .catch(() => {
        if (!cancelled) { setDialCatchmentData(null); setDialCatchmentLoading(false); }
      });

    return () => { cancelled = true; };
  }, [comparison.attribute, siteId, isDialView, siteExtractedAt, siteCatchmentCount]);

  /**
   * The bbox this pane's aggregates are scoped to, as a string, or '' when the
   * range mode does not use one.
   *
   * mapExtent is a fresh object on every map move, and it was a dependency of
   * the effect below regardless of range mode — so panning the map re-ran the
   * aggregate fetch even in Full-domain mode, where the extent is not read at
   * all and the answer cannot change. Six panes, two scenarios, a 4.8-second
   * full-domain query each. Depending on a string that is only non-empty when
   * the extent actually matters removes both the identity churn and the
   * irrelevant re-runs.
   */
  const aggregateExtentQuery = useMemo(() => {
    if (rangeMode !== 'extent' || !mapExtent?.bounds) return '';
    const [minx, miny, maxx, maxy] = mapExtent.bounds;
    return new URLSearchParams({
      minx: String(minx),
      miny: String(miny),
      maxx: String(maxx),
      maxy: String(maxy),
    }).toString();
  }, [rangeMode, mapExtent]);

  useEffect(() => {
    if (!isDialView || !comparison.attribute) {
      setDialRangeValues(null);
      setDialRangeLoading(false);
      return;
    }

    if (rangeMode === 'site') {
      setDialRangeValues(null);
      setDialRangeLoading(false);
      return;
    }

    if (rangeMode === 'extent' && !aggregateExtentQuery) {
      setDialRangeValues(null);
      setDialRangeLoading(false);
      return;
    }

    // For full-domain mode, use precalculated data directly when available
    // to avoid redundant per-attribute API calls on every attribute switch.
    if (rangeMode === 'domain' && fullDomainData) {
      const referenceValue = fullDomainData.reference[comparison.attribute];
      const currentValue = fullDomainData.current[comparison.attribute];
      setDialRangeValues({
        referenceValue: typeof referenceValue === 'number' && !isNaN(referenceValue) ? referenceValue : undefined,
        currentValue: typeof currentValue === 'number' && !isNaN(currentValue) ? currentValue : undefined,
      });
      setDialRangeLoading(false);
      return;
    }

    let cancelled = false;
    // Cancels the requests, not just their effect: a pan supersedes the
    // previous extent's aggregates immediately, and every pane is asking.
    const abort = new AbortController();
    setDialRangeLoading(true);

    const attribute = comparison.attribute || '';

    const aggregateFor = async (scenario: string): Promise<number | undefined> => {
      const params = new URLSearchParams(aggregateExtentQuery);
      params.set('scenario', scenario);
      params.set('attributes', attribute);

      // Shared with every other pane asking the same question, and with the
      // chart view's summary series. A failure or a cancellation reads as "no
      // value", exactly as the non-2xx case did before.
      const payload = await fetchAggregate(params, abort.signal).catch(() => ({} as Record<string, number>));
      const value = payload[attribute];
      return typeof value === 'number' && !isNaN(value) ? value : undefined;
    };

    Promise.all([
      aggregateFor(comparison.leftScenario),
      aggregateFor(comparison.rightScenario),
    ]).then(([referenceValue, currentValue]) => {
      if (cancelled) return;
      setDialRangeValues({ referenceValue, currentValue });
      setDialRangeLoading(false);
    }).catch(() => {
      if (!cancelled) { setDialRangeValues(null); setDialRangeLoading(false); }
    });

    return () => { cancelled = true; abort.abort(); };
  }, [
    isDialView,
    rangeMode,
    comparison.attribute,
    comparison.leftScenario,
    comparison.rightScenario,
    aggregateExtentQuery,
    fullDomainData,
  ]);

  const dialAttributeLabel = comparison.attribute
    ? attributeDetails[comparison.attribute]
      ?? comparison.attribute
        .replace(/_/g, ' ')
        .replace(/\b\w/g, (c) => c.toUpperCase())
    : undefined;

  // Calculate dial chart values based on current attribute and range mode
  const dialData = useMemo(() => {
    const attribute = comparison.attribute;
    if (!attribute) return null;
    const allowMapStatisticsFallback = layoutMode !== 'quad';

    let min = 0;
    let max = 100;
    let referenceValue: number | undefined;
    let currentValue: number | undefined;
    let targetValue: number | undefined;

    // Determine values and min/max based on range mode.
    // This ensures the dial reflects full dataset, current extent, or site-only stats.
    switch (rangeMode) {
      case 'site':
        // Current uses AOI-weighted catchment values to match the Site Aggregation table.
        // Reference uses siteIndicators.reference so the green callout aligns with the
        // popup "Reference (baseline)" value — the AOI-weighted reference can differ enough
        // to place the callout at the wrong arc position.
        // Target (ideal) comes from siteIndicators as it is a site-level computed value.
        if (dialCatchmentData) {
          currentValue = dialCatchmentData.currentValue;
          referenceValue = siteIndicators?.reference?.[attribute] ?? dialCatchmentData.referenceValue;
          targetValue = siteIndicators?.ideal?.[attribute];
          // The site's actual spread across its catchments, which is what "Site
          // range" means — and, unlike a pad around the plotted values, does not
          // move when a target moves. The pad is kept only as a fallback for a
          // site whose catchment values cannot be read.
          const spread = dialCatchmentData.spread;
          const values = [referenceValue, currentValue, targetValue]
            .filter((v): v is number => typeof v === 'number' && !isNaN(v));
          if (spread) {
            // Still has to contain what it plots: a target set outside the
            // site's observed spread would otherwise render clamped to an end.
            min = values.length > 0 ? Math.min(spread.min, ...values) : spread.min;
            max = values.length > 0 ? Math.max(spread.max, ...values) : spread.max;
          } else if (values.length > 0) {
            min = Math.min(...values) * 0.9;
            max = Math.max(...values) * 1.1;
          }
        } else if (!dialCatchmentLoading && (siteIndicators?.reference || siteIndicators?.current)) {
          // Live per-catchment data is unavailable (e.g. a demo/walkthrough
          // site that isn't registered in the backend site store) — fall back
          // to the site's precomputed aggregate indicators. Available in any
          // layout, unlike the mapStatistics.siteStats fallback below.
          referenceValue = siteIndicators?.reference?.[attribute];
          currentValue = siteIndicators?.current?.[attribute];
          targetValue = siteIndicators?.ideal?.[attribute];
          const values = [referenceValue, currentValue, targetValue]
            .filter((v): v is number => typeof v === 'number' && !isNaN(v));
          if (values.length > 0) {
            min = Math.min(...values) * 0.9;
            max = Math.max(...values) * 1.1;
          }
        } else if (allowMapStatisticsFallback && mapStatistics?.siteStats) {
          referenceValue = mapStatistics.siteStats.left?.mean;
          currentValue = mapStatistics.siteStats.right?.mean;
          const mins = [mapStatistics.siteStats.left?.min, mapStatistics.siteStats.right?.min]
            .filter((v): v is number => typeof v === 'number' && !isNaN(v));
          const maxs = [mapStatistics.siteStats.left?.max, mapStatistics.siteStats.right?.max]
            .filter((v): v is number => typeof v === 'number' && !isNaN(v));
          if (mins.length > 0) min = Math.min(...mins);
          if (maxs.length > 0) max = Math.max(...maxs);
        }
        break;
      case 'extent':
        if (dialRangeValues) {
          referenceValue = dialRangeValues.referenceValue;
          currentValue = dialRangeValues.currentValue;
          targetValue = siteIndicators?.ideal?.[attribute];
        }
        if (allowMapStatisticsFallback && mapStatistics?.leftStats && mapStatistics?.rightStats) {
          if (referenceValue === undefined) referenceValue = mapStatistics.leftStats.mean;
          if (currentValue === undefined) currentValue = mapStatistics.rightStats.mean;
          min = Math.min(mapStatistics.leftStats.min, mapStatistics.rightStats.min);
          max = Math.max(mapStatistics.leftStats.max, mapStatistics.rightStats.max);
        } else if (allowMapStatisticsFallback && mapStatistics?.leftStats) {
          if (referenceValue === undefined) referenceValue = mapStatistics.leftStats.mean;
          if (currentValue === undefined) currentValue = mapStatistics.leftStats.mean;
          min = mapStatistics.leftStats.min;
          max = mapStatistics.leftStats.max;
        } else if (allowMapStatisticsFallback && mapStatistics?.rightStats) {
          if (referenceValue === undefined) referenceValue = mapStatistics.rightStats.mean;
          if (currentValue === undefined) currentValue = mapStatistics.rightStats.mean;
          min = mapStatistics.rightStats.min;
          max = mapStatistics.rightStats.max;
        } else {
          const values = [referenceValue, currentValue].filter((v): v is number => typeof v === 'number' && !isNaN(v));
          if (values.length > 0) {
            min = Math.min(...values) * 0.9;
            max = Math.max(...values) * 1.1;
          }
        }
        break;
      case 'domain':
      default:
        if (dialRangeValues) {
          referenceValue = dialRangeValues.referenceValue;
          currentValue = dialRangeValues.currentValue;
        }
        if (allowMapStatisticsFallback && mapStatistics?.fullStats) {
          if (referenceValue === undefined) referenceValue = mapStatistics.fullStats.left?.mean;
          if (currentValue === undefined) currentValue = mapStatistics.fullStats.right?.mean;
          const mins = [mapStatistics.fullStats.left?.min, mapStatistics.fullStats.right?.min]
            .filter((v): v is number => typeof v === 'number' && !isNaN(v));
          const maxs = [mapStatistics.fullStats.left?.max, mapStatistics.fullStats.right?.max]
            .filter((v): v is number => typeof v === 'number' && !isNaN(v));
          if (mins.length > 0) min = Math.min(...mins);
          if (maxs.length > 0) max = Math.max(...maxs);
        } else if (allowMapStatisticsFallback && mapStatistics?.domainRange) {
          min = mapStatistics.domainRange.min;
          max = mapStatistics.domainRange.max;
          const leftMean = mapStatistics.leftStats?.mean;
          const rightMean = mapStatistics.rightStats?.mean;
          if (referenceValue === undefined && leftMean !== undefined) referenceValue = leftMean;
          if (currentValue === undefined && rightMean !== undefined) currentValue = rightMean;
        } else {
          const values = [referenceValue, currentValue].filter((v): v is number => typeof v === 'number' && !isNaN(v));
          if (values.length > 0) {
            min = Math.min(...values) * 0.9;
            max = Math.max(...values) * 1.1;
          }
        }
        break;
    }

    // Whatever the mode derived, metadata has the final word on how far the
    // scale may run. A range that reaches values the factor cannot physically
    // take spends its width on impossible readings and crowds the real ones
    // together. Applied only where a bound is declared and actually exceeded,
    // so a factor with no declared bounds keeps its derived range untouched.
    const beforeCap = { min, max };
    ({ min, max } = capRange({ min, max }, attributeTargetRanges[attribute]));
    const afterCap = { min, max };

    // Site indicators as the last resort for the values.
    //
    // Extent mode needs a map extent to aggregate over, and Full mode needs the
    // domain statistics; in a grid neither is available, because
    // allowMapStatisticsFallback is false there and the shared mapStatistics
    // describes the focused pane rather than this one's factor. The result was
    // every belt reading Reference N/A, Current N/A, Target N/A with no markers
    // at all — a dial showing nothing because of how its *scale* was chosen.
    //
    // The site's own indicators are keyed by factor, so they are correct for any
    // pane whatever it is showing. Values only: the scale still comes from the
    // mode that was asked for.
    const usedSiteIndicatorFallback =
      siteIndicators != null &&
      (referenceValue === undefined || currentValue === undefined);
    if (usedSiteIndicatorFallback) {
      if (referenceValue === undefined) referenceValue = siteIndicators?.reference?.[attribute];
      if (currentValue === undefined) currentValue = siteIndicators?.current?.[attribute];
      if (targetValue === undefined) targetValue = siteIndicators?.ideal?.[attribute];
    }

    // Fallback when statistics are unavailable.
    if (allowMapStatisticsFallback && !siteIndicators && !dialCatchmentData && mapStatistics) {
      const leftMean = mapStatistics.leftStats?.mean;
      const rightMean = mapStatistics.rightStats?.mean;

      // Use left scenario mean as "reference", right as "current"
      if (leftMean !== undefined) referenceValue = leftMean;
      if (rightMean !== undefined) currentValue = rightMean;
      // Target mirrors reference value in explore mode
    }

    // The scale is pinned by something that does not move while you edit.
    //
    // Where metadata declares a bound, that bound is the scale and nothing
    // widens it. Where it does not, the range mode's own minima and maxima —
    // the site's spread, the visible extent, the whole dataset — serve as the
    // cap instead. Either way the ruler is fixed before any target exists.
    //
    // The target is deliberately excluded from what may widen the scale. It is
    // the one value the user changes, so letting it stretch the axis meant
    // every other marker slid while the reading it stood for had not moved —
    // "the blue line moves when I drag rhino". A target beyond the scale reads
    // at the end of the band, which is the honest rendering of a target outside
    // what the data or the metadata says is reachable.
    //
    // The observations may still widen an *underived* end, because the range
    // and the values do not always come from the same computation, and a
    // reference marker pinned to an edge it does not actually sit on is a lie
    // about a measurement. Neither of them moves when a target is edited, so
    // the scale stays still regardless.
    const cap = attributeTargetRanges[attribute];
    const observedValues = [referenceValue, currentValue]
      .filter((v): v is number => typeof v === 'number' && !isNaN(v));
    if (observedValues.length > 0) {
      if (!hasDeclaredMin(cap)) min = Math.min(min, ...observedValues);
      if (!hasDeclaredMax(cap)) max = Math.max(max, ...observedValues);
    }

    // The balance cap that used to sit here shrank the scale toward whatever
    // was being displayed, target included, so it was a second way for an edit
    // to move the ruler. It existed to stop an outlier-driven domain maximum
    // dwarfing the values; that is now the range mode's business, and the mode
    // the user picked is the answer.

    const afterValues = { min, max };

    // Ensure min < max
    if (min >= max) {
      const mid = (min + max) / 2 || 50;
      min = mid - 10;
      max = mid + 10;
    }

    // When flagged in metadata.csv, center the dial on zero: positive values
    // read to the right, negative values to the left.
    if (attributeDial0Middle[attribute]) {
      const absMax = Math.max(Math.abs(min), Math.abs(max));
      min = -absMax;
      max = absMax;
    }

    // A declared bound is the scale, so it gets the last word — every step
    // since the cap was applied (fitting the plotted values, the balance cap,
    // zero-centring) is free to move an end that metadata does not pin, and
    // none of them may move one it does. Percent burned is 0–100 because it is
    // a percentage, whatever this site happens to span.
    ({ min, max } = capRange({ min, max }, attributeTargetRanges[attribute]));

    return {
      min, max, referenceValue, currentValue, targetValue,
      // The workings, for the chart details panel. Kept rather than recomputed
      // there: half these numbers are intermediate states of this function and
      // could not be reproduced from outside it without repeating it.
      beforeCap, afterCap, afterValues,
      zeroCentred: Boolean(attributeDial0Middle[attribute]),
      usedSiteIndicatorFallback,
    };
  // useMemo has a missing dependency: 'dialCatchmentLoading'
  // eslint-disable-next-line react-hooks/exhaustive-deps -- pre-existing; see the tracking issue
  }, [comparison.attribute, siteIndicators, dialCatchmentData, dialRangeValues, rangeMode, mapStatistics, layoutMode, attributeDial0Middle, attributeTargetRanges]);

  const leftInfo = SCENARIOS.find((s) => s.id === comparison.leftScenario);
  const rightInfo = SCENARIOS.find((s) => s.id === comparison.rightScenario);

  const isQuad = layoutMode === 'quad';
  const showDialFactorPrompt = isQuad && (viewMode === 'dial' || viewMode === 'flat') && !comparison.attribute;
  const denseDialLayout = isQuad && paneCount > 4;
  const btnSize = compact ? 'xs' : 'sm';

  const changedInputs = useMemo(() => {
    if (!siteIndicators?.ideal || !siteIndicators?.current) return [];
    return editableTargetKeys
      .map((key) => {
        const cur = siteIndicators.current[key];
        const ideal = siteIndicators.ideal![key];
        if (typeof cur !== 'number' || typeof ideal !== 'number') return null;
        if (cur === ideal) return null;
        const refRaw = siteIndicators.reference?.[key];
        const ref = typeof refRaw === 'number' ? refRaw : cur;
        return { key, ref, ideal, delta: ideal - ref };
      })
      .filter((x): x is { key: string; ref: number; ideal: number; delta: number } => x !== null);
  }, [editableTargetKeys, siteIndicators]);



  /**
   * What each range mode would give, whether or not it is the active one.
   *
   * The dial only ever computes the mode in use, so the other two have to be
   * derived separately for the details panel. Read from the same sources the
   * switch reads, and null where that source has not loaded — a diagnostic that
   * fills in a plausible number is worse than one that says it does not know.
   */
  const candidateRanges = useMemo(() => {
    const spanOf = (stats: Array<{ min?: number; max?: number } | null | undefined>) => {
      const mins = stats.map((s) => s?.min).filter((v): v is number => typeof v === 'number' && !isNaN(v));
      const maxs = stats.map((s) => s?.max).filter((v): v is number => typeof v === 'number' && !isNaN(v));
      if (mins.length === 0 || maxs.length === 0) return null;
      return { min: Math.min(...mins), max: Math.max(...maxs) };
    };
    return {
      domain: mapStatistics?.fullStats
        ? spanOf([mapStatistics.fullStats.left, mapStatistics.fullStats.right])
        : mapStatistics?.domainRange ?? null,
      extent: spanOf([mapStatistics?.leftStats, mapStatistics?.rightStats]),
      site: dialCatchmentData?.spread
        ?? spanOf([mapStatistics?.siteStats?.left, mapStatistics?.siteStats?.right]),
    };
  }, [mapStatistics, dialCatchmentData]);

  /**
   * What the calculations view of the details panel needs.
   *
   * Assembled here because these are ViewPane's own inputs; the panel renders
   * it for whichever pane asked, and holds none of it itself.
   */
  const calculationDetails = useMemo(() => (
    comparison.attribute
      ? { attribute: comparison.attribute, siteIndicators, attributeDetails, changedInputs }
      : null
  ), [comparison.attribute, siteIndicators, attributeDetails, changedInputs]);

  const DialComponent = viewMode === 'flat' ? FlatDial : DialChart;

  // The scale actually drawn against. Unlocked, it is whatever dialData just
  // derived. Locked, it is whatever was held when the lock was taken — so
  // moving a slider moves the markers and leaves the axis alone. The hold is
  // re-taken when the factor or the range mode changes, since a scale held for
  // one factor means nothing for another and a range-mode switch is an explicit
  // request for a different range.
  // No hold to consult any more: the scale is already fixed by the metadata
  // bound or, failing that, by the range mode's own minima and maxima.
  const dialMin = dialData?.min ?? 0;
  const dialMax = dialData?.max ?? 100;

  /**
   * Everything behind the number on screen, for the details panel.
   *
   * Includes where each value came from, because the dial does not use one
   * source: in Site mode current is an AOI-weighted catchment mean while
   * reference and target are site-level indicators, and those are different
   * computations that can disagree. That is invisible on the dial and is
   * exactly the kind of thing this panel exists to show.
   */
  const dialDerivation = useMemo<ScaleDerivation | null>(() => {
    if (!comparison.attribute || !dialData) return null;
    const usedCatchments = rangeMode === 'site' && Boolean(dialCatchmentData);
    const trace = (value: number | undefined, source: string) => ({ value, source });
    return {
      attribute: dialAttributeLabel ?? comparison.attribute,
      unit: attributeUnits[comparison.attribute] ?? '',
      activeMode: rangeMode ?? 'domain',
      candidates: candidateRanges,
      cap: attributeTargetRanges[comparison.attribute]
        ? {
            min: attributeTargetRanges[comparison.attribute].min ?? null,
            max: attributeTargetRanges[comparison.attribute].max ?? null,
          }
        : null,
      beforeCap: dialData.beforeCap,
      afterCap: dialData.afterCap,
      afterValues: dialData.afterValues,
      final: { min: dialMin, max: dialMax },
      zeroCentred: dialData.zeroCentred,
      reference: trace(dialData.referenceValue, usedCatchments ? 'Site indicators (reference)' : 'Map statistics'),
      current: trace(
        dialData.currentValue,
        usedCatchments ? 'AOI-weighted catchment mean' : 'Map statistics / site indicators',
      ),
      target: trace(dialData.targetValue, 'Site indicators (ideal)'),
    };
  }, [
    comparison.attribute, dialAttributeLabel, attributeUnits, rangeMode, candidateRanges,
    attributeTargetRanges, dialData, dialMin, dialMax, dialCatchmentData,
  ]);


  return (
    <Box
      className="dt-pane"
      position="relative"
      w="100%"
      h="100%"
      overflow="hidden"
      border={compact ? '1px' : 'none'}
      borderColor={borderColor}
    >
      {/* Map layer — mounted only while this pane is showing a map (issue #76) */}
      <Box
        position="absolute"
        top={0}
        left={0}
        right={0}
        bottom={0}
        opacity={viewMode === 'map' ? 1 : 0}
        transition="opacity 0.5s cubic-bezier(0.4, 0, 0.2, 1)"
        pointerEvents={viewMode === 'map' ? 'auto' : 'none'}
      >
        {mapMounted && mapMountReady && <MapView
          comparison={comparison}
          onOpenSettings={() => onFocusPane(paneIndex)}
          onIdentify={onIdentify}
          identifyResult={identifyResult}
          onMapExtentChange={onMapExtentChange}
          onStatisticsChange={onStatisticsChange}
          isPanelOpen={isPanelOpen}
          isQuad={isQuad}
          siteId={siteId}
          siteBounds={siteBounds}
          isBoundaryEditMode={isBoundaryEditMode}
          siteGeometry={siteGeometry}
          onBoundaryUpdate={onBoundaryUpdate}
          isSwiperEnabled={isSwiperEnabled}
          colorScaleMode={colorScaleMode}
          colorScaleType={colorScaleType}
          rangeMode={rangeMode}
          is3DMode={is3DMode}
          isIdentifyMode={isIdentifyMode}
          isChoroplethEnabled={isChoroplethEnabled}
          isGoogleBasemap={isGoogleBasemap}
          onGoogleBasemapChange={onGoogleBasemapChange}
          showNavigation={showNavigation}
          swiperPosition={swiperPosition}
          onSwiperPositionChange={onSwiperPositionChange}
          refreshKey={refreshKey}
          onReady={() => setMapReady(true)}
          siteIndicators={siteIndicators}
        />}
        {viewMode === 'map' && !mapReady && (
          <Box
            position="absolute"
            top={0}
            left={0}
            right={0}
            bottom={0}
            display="flex"
            alignItems="center"
            justifyContent="center"
            bg="rgba(26, 32, 44, 0.75)"
            zIndex={10}
            backdropFilter="blur(2px)"
          >
            <Spinner size="xl" color="orange.400" thickness="3px" speed="0.7s" />
          </Box>
        )}
      </Box>

      {/* Line Chart layer */}
      <ChartView
        visible={viewMode === 'chart'}
        attribute={comparison.attribute}
        siteIndicators={siteIndicators}
        siteId={siteId}
        rangeMode={rangeMode}
        mapStatistics={mapStatistics}
        leftScenario={comparison.leftScenario}
        rightScenario={comparison.rightScenario}
        chartGroup={chartGroup}
        chartAxisLabelFilter={chartAxisLabelFilter}
        chartGraphMode={chartGraphMode}
        mapExtent={mapExtent}
        targetHasBeenUpdated={targetHasBeenUpdated}
      />

      {/* Dial Chart layer */}
      <DialComponent
        visible={isDialView && !showDialFactorPrompt}
        referenceValue={dialData?.referenceValue}
        currentValue={dialData?.currentValue}
        // Always drawn, whenever the site has an ideal for this factor.
        //
        // It used to be hidden unless the ideal differed from current, which
        // conflated two different things: a target nobody has set, and a target
        // deliberately set *to* current. Reset to current produces the second
        // and looked like the first — the buckle vanished instead of landing on
        // the blue line. Target State starts equal to Current State and diverges
        // only where you make it, so a target sitting on current is the truth
        // about a site, not an absence of one.
        targetValue={dialData?.targetValue}
        min={dialMin}
        max={dialMax}
        attribute={dialAttributeLabel}
        unit={comparison.attribute ? (attributeUnits[comparison.attribute] ?? '') : ''}
        compact={compact}
        denseLayout={denseDialLayout}
        paneCount={paneCount}
        isLoading={dialCatchmentLoading || dialRangeLoading}
        zeroCentered={comparison.attribute ? Boolean(attributeDial0Middle[comparison.attribute]) : false}
      />

      {/* Quad dial empty state for panes with no selected factor */}
      {showDialFactorPrompt && (
        <Flex
          position="absolute"
          top={0}
          left={0}
          right={0}
          bottom={0}
          zIndex={4}
          align="center"
          justify="center"
          textAlign="center"
          bg="rgba(26, 32, 44, 0.92)"
          px={6}
        >
          <Box maxW="300px">
            <Text color="white" fontSize={compact ? 'sm' : 'md'} fontWeight="600" mb={2}>
              Select a factor for this pane
            </Text>
            <Text color="gray.300" fontSize={compact ? 'xs' : 'sm'}>
              Choose a factor to view dial chart data.
            </Text>
          </Box>
        </Flex>
      )}

      {/* Aggregate Table layer */}
      <AggregateTable
        visible={viewMode === 'table'}
        attribute={comparison.attribute}
        siteId={siteId}
        scenario={comparison.leftScenario}
        siteGeometry={siteGeometry}
        siteIndicators={siteIndicators}
      />

      {/*
        One header for every view mode except the map, which draws its own —
        those are tied to the swiper and hide when it docks. Same component,
        same position, same styling, so cycling through the modes changes what
        is drawn inside the pane and not the frame around it.

        The table shows a single scenario (it aggregates the left one), so it
        gets a single label rather than a comparison it is not making. The
        chart draws its own Reference/Current/Target legend, and the flat dial
        labels its REF/NOW markers directly on the band, so for both the
        corner labels would just repeat what is already on the chart.
      */}
      {viewMode !== 'map' && (
        <PaneHeader
          compact={compact}
          title={dialAttributeLabel}
          leftLabel={viewMode === 'chart' || viewMode === 'flat' ? undefined : (leftInfo?.label || comparison.leftScenario)}
          leftColor={leftInfo?.color}
          rightLabel={viewMode === 'table' || viewMode === 'chart' || viewMode === 'flat' ? undefined : (rightInfo?.label || comparison.rightScenario)}
          rightColor={rightInfo?.color}
        />
      )}

      {/* The combined "A vs B" label that used to sit in the top-left is gone:
          PaneHeader above says the same thing in the same place as the map,
          split into the two scenarios it was joining. */}

      {/* Per-pane toolbar */}
      <HStack
        id="tour-view-modes"
        className="dt-pane-chrome"
        position="absolute"
        bottom={compact ? 2 : 3}
        right={compact ? 2 : 3}
        zIndex={5}
        spacing={1}
        bg="blackAlpha.600"
        borderRadius="lg"
        px={1.5}
        py={1}
        backdropFilter="blur(8px)"
        transition="opacity 0.3s ease"
      >
        {/* In quad mode, only allow focusing a pane from inside the pane. */}
        {!isQuad && VIEW_MODES.map((mode) => {
          if (mode === viewMode) return null;
          const config = VIEW_MODE_CONFIG[mode];
          return (
            <Tooltip key={mode} label={`Show ${config.label}`} placement="top">
              <IconButton
                aria-label={`Show ${config.label}`}
                icon={config.icon}
                onClick={() => onViewModeChange(paneIndex, mode)}
                variant="ghost"
                color="white"
                _hover={{ bg: 'whiteAlpha.300' }}
                size={btnSize}
                borderRadius="md"
              />
            </Tooltip>
          );
        })}

        {/* Layout toggle — context-dependent */}
          {/* Outside the layout branch: it used to sit in the quad-only arm, so
              a single pane had no way to open the panel at all. Nor is it gated
              on a target existing any more — the panel explains the scale as
              well as the target arithmetic, and the scale is worth asking about
              either way. */}
          {comparison.attribute && onOpenChartDetails && (
            <Tooltip label="Explain this chart" placement="top">
              <IconButton
                aria-label="Explain this chart"
                icon={<FiInfo />}
                onClick={() => onOpenChartDetails(paneIndex, dialDerivation, calculationDetails)}
                variant="ghost"
                // White like the rest of the cluster. It was cyan, which read
                // as a different kind of control among plain white siblings.
                color="white"
                _hover={{ bg: 'whiteAlpha.300' }}
                size={btnSize}
                borderRadius="md"
              />
            </Tooltip>
          )}

        {isQuad ? (
          <>
            <Tooltip label="Focus this pane" placement="top">
              <IconButton
                aria-label="Focus pane"
                icon={<FiMaximize />}
                onClick={() => onFocusPane(paneIndex)}
                variant="ghost"
                color="white"
                _hover={{ bg: 'whiteAlpha.300' }}
                size={btnSize}
                borderRadius="md"
              />
            </Tooltip>
            {onOpenControlPanel && (
              <Tooltip label="Configure factor" placement="top">
                <IconButton
                  aria-label="Configure factor"
                  icon={<FiSliders />}
                  onClick={() => onOpenControlPanel(paneIndex)}
                  variant="ghost"
                  color="white"
                  _hover={{ bg: 'whiteAlpha.300' }}
                  size={btnSize}
                  borderRadius="md"
                />
              </Tooltip>
            )}
            {paneIndex === 0 && onQuadColumnsChange && (
              <Tooltip label={quadColumns === 2 ? '3 across' : '2 across'} placement="top">
                <IconButton
                  aria-label={quadColumns === 2 ? 'Switch to 3 columns' : 'Switch to 2 columns'}
                  icon={quadColumns === 2 ? <BsGrid3X3 /> : <BsGrid />}
                  onClick={() => onQuadColumnsChange(quadColumns === 2 ? 3 : 2)}
                  variant="ghost"
                  color="white"
                  _hover={{ bg: 'whiteAlpha.300' }}
                  size={btnSize}
                  borderRadius="md"
                />
              </Tooltip>
            )}
            {canRemove && onRemovePane && (
              <Tooltip label="Remove pane" placement="top">
                <IconButton
                  aria-label="Remove pane"
                  icon={<FiTrash2 />}
                  onClick={() => onRemovePane(paneIndex)}
                  variant="ghost"
                  color="white"
                  _hover={{ bg: 'whiteAlpha.300' }}
                  size={btnSize}
                  borderRadius="md"
                />
              </Tooltip>
            )}
          </>
        ) : (
          <Tooltip label="Grid view" placement="top">
            <IconButton
              aria-label="Switch to grid view"
              icon={<FiGrid />}
              onClick={onGoQuad}
              variant="ghost"
              color="white"
              _hover={{ bg: 'whiteAlpha.300' }}
              size={btnSize}
              borderRadius="md"
            />
          </Tooltip>
        )}
      </HStack>

      {/* Calculation details modal */}
      {/* The Calculation Details modal was here. It is now a view of the
          chart details side panel: a calculation you want to check against
          the chart is not something to read with the chart covered up. Its
          body moved to CalculationDetails, unchanged. */}
    </Box>
  );
}

export default ViewPane;
