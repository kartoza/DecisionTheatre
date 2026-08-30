import { useEffect, useMemo, useState } from 'react';
import {
  Box, Button, Divider, Flex, HStack, IconButton,
  Modal, ModalBody, ModalCloseButton, ModalContent, ModalFooter, ModalHeader, ModalOverlay,
  Spinner, Table, Tbody, Td, Text, Th, Thead, Tooltip, Tr, VStack,
  useColorModeValue,
} from '@chakra-ui/react';
import { FiBarChart2, FiInfo, FiMap, FiMaximize, FiGrid, FiActivity, FiTable, FiTrash2, FiSliders } from 'react-icons/fi';
import { BsGrid3X3, BsGrid } from 'react-icons/bs';
import MapView from './MapView';
import ChartView from './ChartView';
import DialChart from './DialChart';
import FlatDial from './FlatDial';
import { loadDialShape, onDialShapeChange } from '../lib/dialShape';
import type { DialShape } from '../lib/dialShape';
import AggregateTable from './AggregateTable';
import type { ComparisonState, LayoutMode, QuadColumns, IdentifyResult, MapExtent, MapStatistics, BoundingBox, ColorScaleMode, ColorScaleType, ViewMode, RangeMode, SiteIndicators } from '../types';
import { SCENARIOS } from '../types';
import { fetchAggregate, getSiteCatchments, useAttributeDetails, useAttributeDial0Middle, useAttributeUnits } from '../hooks/useApi';
import type { FullDomainData } from '../hooks/useApi';
import { COLUMN_FORMULAS, getTriggeredWorkflows } from '../constants/calculationFormulas';
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
  onRangeModeChange?: (mode: RangeMode) => void;
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
  chart: { icon: <FiBarChart2 />, label: 'Chart', nextLabel: 'Show dial gauge' },
  dial: { icon: <FiActivity />, label: 'Dial', nextLabel: 'Show aggregate table' },
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
  onRangeModeChange,
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
  const [isCalcModalOpen, setIsCalcModalOpen] = useState(false);

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
  const [dialShape, setDialShape] = useState<DialShape>(loadDialShape);
  useEffect(() => onDialShapeChange(setDialShape), []);

  const [dialCatchmentData, setDialCatchmentData] = useState<{
    referenceValue?: number;
    currentValue?: number;
  } | null>(null);
  const [dialCatchmentLoading, setDialCatchmentLoading] = useState(false);
  const [dialRangeValues, setDialRangeValues] = useState<{
    referenceValue?: number;
    currentValue?: number;
  } | null>(null);
  const [dialRangeLoading, setDialRangeLoading] = useState(false);

  useEffect(() => {
    if (viewMode !== 'dial' || !siteId || !comparison.attribute) {
      setDialCatchmentData(null);
      setDialCatchmentLoading(false);
      return;
    }

    let cancelled = false;
    setDialCatchmentLoading(true);

    getSiteCatchments(siteId)
      .then((catchments) => {
        if (cancelled || !catchments || catchments.length === 0) {
          if (!cancelled) setDialCatchmentLoading(false);
          return;
        }

        const referenceValue = computeAOIWeightedAttributeValue(catchments, 'reference', comparison.attribute);
        const currentValue = computeAOIWeightedAttributeValue(catchments, 'current', comparison.attribute);

        if (referenceValue === undefined && currentValue === undefined) {
          if (!cancelled) { setDialCatchmentData(null); setDialCatchmentLoading(false); }
          return;
        }

        if (!cancelled) {
          setDialCatchmentData({ referenceValue, currentValue });
          setDialCatchmentLoading(false);
        }
      })
      .catch(() => {
        if (!cancelled) { setDialCatchmentData(null); setDialCatchmentLoading(false); }
      });

    return () => { cancelled = true; };
  }, [comparison.attribute, siteId, viewMode]);

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
    if (viewMode !== 'dial' || !comparison.attribute) {
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
    viewMode,
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
          targetValue = siteIndicators?.ideal?.[attribute] ?? referenceValue;
          const values = [referenceValue, currentValue, targetValue]
            .filter((v): v is number => typeof v === 'number' && !isNaN(v));
          if (values.length > 0) {
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
          targetValue = siteIndicators?.ideal?.[attribute] ?? referenceValue;
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
          targetValue = referenceValue;
        }
        break;
      case 'extent':
        if (dialRangeValues) {
          referenceValue = dialRangeValues.referenceValue;
          currentValue = dialRangeValues.currentValue;
          targetValue = siteIndicators?.ideal?.[attribute] ?? referenceValue;
        }
        if (allowMapStatisticsFallback && mapStatistics?.leftStats && mapStatistics?.rightStats) {
          if (referenceValue === undefined) referenceValue = mapStatistics.leftStats.mean;
          if (currentValue === undefined) currentValue = mapStatistics.rightStats.mean;
          if (targetValue === undefined) targetValue = referenceValue;
          min = Math.min(mapStatistics.leftStats.min, mapStatistics.rightStats.min);
          max = Math.max(mapStatistics.leftStats.max, mapStatistics.rightStats.max);
        } else if (allowMapStatisticsFallback && mapStatistics?.leftStats) {
          if (referenceValue === undefined) referenceValue = mapStatistics.leftStats.mean;
          if (currentValue === undefined) currentValue = mapStatistics.leftStats.mean;
          if (targetValue === undefined) targetValue = referenceValue;
          min = mapStatistics.leftStats.min;
          max = mapStatistics.leftStats.max;
        } else if (allowMapStatisticsFallback && mapStatistics?.rightStats) {
          if (referenceValue === undefined) referenceValue = mapStatistics.rightStats.mean;
          if (currentValue === undefined) currentValue = mapStatistics.rightStats.mean;
          if (targetValue === undefined) targetValue = referenceValue;
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
          targetValue = referenceValue;
        }
        if (allowMapStatisticsFallback && mapStatistics?.fullStats) {
          if (referenceValue === undefined) referenceValue = mapStatistics.fullStats.left?.mean;
          if (currentValue === undefined) currentValue = mapStatistics.fullStats.right?.mean;
          if (targetValue === undefined) targetValue = referenceValue;
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
          if (targetValue === undefined) targetValue = referenceValue;
        } else {
          const values = [referenceValue, currentValue].filter((v): v is number => typeof v === 'number' && !isNaN(v));
          if (values.length > 0) {
            min = Math.min(...values) * 0.9;
            max = Math.max(...values) * 1.1;
          }
        }
        break;
    }

    // Fallback when statistics are unavailable.
    if (allowMapStatisticsFallback && !siteIndicators && !dialCatchmentData && mapStatistics) {
      const leftMean = mapStatistics.leftStats?.mean;
      const rightMean = mapStatistics.rightStats?.mean;

      // Use left scenario mean as "reference", right as "current"
      if (leftMean !== undefined) referenceValue = leftMean;
      if (rightMean !== undefined) currentValue = rightMean;
      // Target mirrors reference value in explore mode
      targetValue = referenceValue;
    }

    // Guard against min/max coming from a source (e.g. mapStatistics) that doesn't
    // actually bound the reference/current/target values (e.g. dialRangeValues) —
    // otherwise the dial clamps the reference marker to min/max and renders it at
    // the wrong position instead of off-scale.
    const displayedValues = [referenceValue, currentValue, targetValue]
      .filter((v): v is number => typeof v === 'number' && !isNaN(v));
    if (displayedValues.length > 0) {
      min = Math.min(min, ...displayedValues);
      max = Math.max(max, ...displayedValues);
    }

    // Keep the dial's scale in proportion to what it's actually displaying —
    // a domain-wide max pulled from an outlier catchment (or a scenario with
    // no curated metadata.csv max) shouldn't dwarf a reference/current/target
    // that are an order of magnitude smaller, making the needle unreadable.
    const DIAL_BALANCE_MULTIPLIER = 4;
    if (displayedValues.length > 0) {
      const maxDisplayedMagnitude = Math.max(...displayedValues.map((v) => Math.abs(v)));
      if (maxDisplayedMagnitude > 0) {
        const balanceCap = maxDisplayedMagnitude * DIAL_BALANCE_MULTIPLIER;
        if (max > balanceCap) max = balanceCap;
        if (min < -balanceCap) min = -balanceCap;
      }
    }

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

    // Only expose target when it actually differs from current — prevents showing a
    // spurious target marker for factors the user never changed (target now starts
    // as a copy of the current state, not reference).
    // Compare both values from siteIndicators (same source) to avoid false positives
    // from minor AOI-weighting differences between dialCatchmentData and siteIndicators.
    const siteIdeal = siteIndicators?.ideal?.[attribute];
    const siteCurrentForTarget = siteIndicators?.current?.[attribute];
    const targetChanged = typeof siteIdeal === 'number' && typeof siteCurrentForTarget === 'number'
      ? siteIdeal !== siteCurrentForTarget
      : (typeof targetValue === 'number' && typeof currentValue === 'number' && targetValue !== currentValue);

    return { min, max, referenceValue, currentValue, targetValue, targetChanged };
  // useMemo has a missing dependency: 'dialCatchmentLoading'
  // eslint-disable-next-line react-hooks/exhaustive-deps -- pre-existing; see the tracking issue
  }, [comparison.attribute, siteIndicators, dialCatchmentData, dialRangeValues, rangeMode, mapStatistics, layoutMode, attributeDial0Middle]);

  const leftInfo = SCENARIOS.find((s) => s.id === comparison.leftScenario);
  const rightInfo = SCENARIOS.find((s) => s.id === comparison.rightScenario);
  const paneLabel = `${leftInfo?.label || ''} vs ${rightInfo?.label || ''}`;

  const isQuad = layoutMode === 'quad';
  const showDialFactorPrompt = isQuad && viewMode === 'dial' && !comparison.attribute;
  const denseDialLayout = isQuad && paneCount > 4;
  const hidePaneLabel = isQuad && (viewMode === 'map' || viewMode === 'chart' || viewMode === 'table');
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

  const triggeredWorkflows = useMemo(
    () => getTriggeredWorkflows(changedInputs.map((x) => x.key)),
    [changedInputs],
  );

  const fv = (n: number) => {
    if (!Number.isFinite(n)) return '—';
    if (Math.abs(n) >= 1_000_000) return (n / 1_000_000).toFixed(2) + 'M';
    if (Math.abs(n) >= 1_000) return (n / 1_000).toFixed(2) + 'K';
    if (Math.abs(n) < 0.01 && n !== 0) return n.toFixed(6);
    if (Math.abs(n) < 10) return n.toFixed(3);
    return n.toFixed(1);
  };

  const DialComponent = dialShape === 'flat' ? FlatDial : DialChart;

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
        visible={viewMode === 'dial' && !showDialFactorPrompt}
        referenceValue={dialData?.referenceValue}
        currentValue={dialData?.currentValue}
        targetValue={targetHasBeenUpdated && (dialData?.targetChanged ?? false) ? dialData?.targetValue : undefined}
        min={dialData?.min ?? 0}
        max={dialData?.max ?? 100}
        attribute={dialAttributeLabel}
        unit={comparison.attribute ? (attributeUnits[comparison.attribute] ?? '') : ''}
        rangeMode={rangeMode}
        onRangeModeChange={isQuad ? undefined : onRangeModeChange}
        isSiteAvailable={!!siteId}
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

      {/* Pane label (shown in quad mode except dial view) */}
      {compact && viewMode !== 'dial' && !hidePaneLabel && (
        <Box
          position="absolute"
          top={2}
          left={2}
          zIndex={5}
          bg="blackAlpha.700"
          color="white"
          px={3}
          py={1}
          borderRadius="md"
          fontSize="xs"
          fontWeight="600"
          letterSpacing="0.5px"
          backdropFilter="blur(8px)"
          pointerEvents="none"
        >
          {paneLabel}
        </Box>
      )}

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
        {isQuad ? (
          <>
            {targetHasBeenUpdated && comparison.attribute && (
              <Tooltip label="View calculation details" placement="top">
                <IconButton
                  aria-label="Calculation details"
                  icon={<FiInfo />}
                  onClick={() => setIsCalcModalOpen(true)}
                  variant="ghost"
                  color="cyan.300"
                  _hover={{ bg: 'whiteAlpha.300' }}
                  size={btnSize}
                  borderRadius="md"
                />
              </Tooltip>
            )}
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
      <Modal isOpen={isCalcModalOpen} onClose={() => setIsCalcModalOpen(false)} size="lg" scrollBehavior="inside">
        <ModalOverlay />
        <ModalContent bg="gray.800" color="white">
          <ModalHeader pb={2}>
            <Text fontSize="md" fontWeight="700">Calculation Details</Text>
            {comparison.attribute && (
              <VStack align="start" spacing={0} mt={1}>
                <Text fontSize="sm" color="gray.200" fontWeight="600">
                  {attributeDetails[comparison.attribute] ?? comparison.attribute}
                </Text>
                <Text fontSize="xs" color="gray.400" fontFamily="mono">{comparison.attribute}</Text>
              </VStack>
            )}
          </ModalHeader>
          <ModalCloseButton />
          <ModalBody>
            <VStack align="stretch" spacing={5}>

              {/* ── 1. Scenario values ── */}
              {comparison.attribute && (() => {
                const attr = comparison.attribute;
                const refVal  = siteIndicators?.reference?.[attr];
                const curVal  = siteIndicators?.current?.[attr];
                const idealVal = siteIndicators?.ideal?.[attr];
                const ref   = typeof refVal  === 'number' && Number.isFinite(refVal)  ? refVal  : null;
                const cur   = typeof curVal  === 'number' && Number.isFinite(curVal)  ? curVal  : null;
                const ideal = typeof idealVal === 'number' && Number.isFinite(idealVal) ? idealVal : null;
                const delta = ref !== null && ideal !== null ? ideal - ref : null;
                const pct   = delta !== null && ref !== null && ref !== 0
                  ? (delta / Math.abs(ref)) * 100 : null;
                const isDirectInput = changedInputs.some((x) => x.key === attr);
                return (
                  <Box>
                    <Text fontSize="xs" fontWeight="700" color="gray.400" textTransform="uppercase" letterSpacing="0.08em" mb={2}>
                      Values
                    </Text>
                    <Table size="sm" variant="simple">
                      <Thead>
                        <Tr>
                          <Th color="gray.400" borderColor="gray.600" fontSize="xs">Scenario</Th>
                          <Th color="gray.400" borderColor="gray.600" fontSize="xs" isNumeric>Value</Th>
                        </Tr>
                      </Thead>
                      <Tbody>
                        <Tr>
                          <Td borderColor="gray.700" fontSize="sm">Reference (baseline)</Td>
                          <Td borderColor="gray.700" fontSize="sm" isNumeric fontFamily="mono">{ref !== null ? fv(ref) : '—'}</Td>
                        </Tr>
                        <Tr>
                          <Td borderColor="gray.700" fontSize="sm">Current state</Td>
                          <Td borderColor="gray.700" fontSize="sm" isNumeric fontFamily="mono">{cur !== null ? fv(cur) : '—'}</Td>
                        </Tr>
                        <Tr>
                          <Td borderColor="gray.700" fontSize="sm" fontWeight="600" color="cyan.300">
                            Target {isDirectInput ? '(set by you)' : '(calculated)'}
                          </Td>
                          <Td borderColor="gray.700" fontSize="sm" isNumeric fontFamily="mono" fontWeight="600" color="cyan.300">
                            {ideal !== null ? fv(ideal) : '—'}
                          </Td>
                        </Tr>
                        {delta !== null && (
                          <Tr>
                            <Td borderColor="gray.700" fontSize="sm" color="gray.400">Change from reference</Td>
                            <Td borderColor="gray.700" fontSize="sm" isNumeric fontFamily="mono"
                              color={delta > 0 ? 'green.300' : delta < 0 ? 'red.300' : 'gray.400'}>
                              {delta >= 0 ? '+' : ''}{fv(delta)}
                              {pct !== null && (
                                <Text as="span" fontSize="xs" ml={1} opacity={0.75}>
                                  ({pct >= 0 ? '+' : ''}{pct.toFixed(1)}%)
                                </Text>
                              )}
                            </Td>
                          </Tr>
                        )}
                      </Tbody>
                    </Table>
                  </Box>
                );
              })()}

              <Divider borderColor="gray.600" />

              {/* ── 2. Formula for this factor ── */}
              {comparison.attribute && (() => {
                const formula = COLUMN_FORMULAS[comparison.attribute];
                const isDirectInput = changedInputs.some((x) => x.key === comparison.attribute);
                if (!formula && !isDirectInput) return null;
                return (
                  <Box>
                    <Text fontSize="xs" fontWeight="700" color="gray.400" textTransform="uppercase" letterSpacing="0.08em" mb={3}>
                      How This Factor Is Calculated
                    </Text>
                    {isDirectInput && !formula && (
                      <Text fontSize="sm" color="gray.300">
                        This factor was <Text as="span" color="cyan.300" fontWeight="600">set directly by you</Text>. It is a user-controlled input — no formula is applied to derive it.
                      </Text>
                    )}
                    {formula && (
                      <VStack align="stretch" spacing={3}>
                        <Box bg="gray.750" border="1px" borderColor="gray.600" borderRadius="md" p={3}>
                          <Text fontSize="xs" color="gray.400" mb={1} fontWeight="600">Formula</Text>
                          <Text
                            fontSize="xs"
                            fontFamily="mono"
                            color="green.200"
                            whiteSpace="pre-wrap"
                            lineHeight="tall"
                          >
                            {formula.formula}
                          </Text>
                        </Box>
                        <Box>
                          <Text fontSize="xs" color="gray.400" mb={1} fontWeight="600">Explanation</Text>
                          <Text fontSize="sm" color="gray.200" lineHeight="tall">
                            {formula.explanation}
                          </Text>
                        </Box>
                        <Text fontSize="xs" color="gray.500">
                          Workflow: <Text as="span" color="gray.400" fontStyle="italic">{formula.workflow}</Text>
                        </Text>
                      </VStack>
                    )}
                  </Box>
                );
              })()}

              <Divider borderColor="gray.600" />

              {/* ── 3. Changed inputs ── */}
              <Box>
                <Text fontSize="xs" fontWeight="700" color="gray.400" textTransform="uppercase" letterSpacing="0.08em" mb={2}>
                  Changed Target Inputs
                </Text>
                {changedInputs.length === 0 ? (
                  <Text fontSize="sm" color="gray.500">No input factors were modified.</Text>
                ) : (
                  <Table size="sm" variant="simple">
                    <Thead>
                      <Tr>
                        <Th color="gray.400" borderColor="gray.600" fontSize="xs">Factor</Th>
                        <Th color="gray.400" borderColor="gray.600" fontSize="xs" isNumeric>Reference</Th>
                        <Th color="gray.400" borderColor="gray.600" fontSize="xs" isNumeric>Target</Th>
                        <Th color="gray.400" borderColor="gray.600" fontSize="xs" isNumeric>Change</Th>
                      </Tr>
                    </Thead>
                    <Tbody>
                      {changedInputs.map(({ key, ref, ideal, delta }) => (
                        <Tr key={key}>
                          <Td borderColor="gray.700" maxW="180px">
                            <Text fontSize="xs" fontWeight="600" noOfLines={1}>{attributeDetails[key] ?? key}</Text>
                            <Text fontSize="xs" color="gray.500" fontFamily="mono">{key}</Text>
                          </Td>
                          <Td borderColor="gray.700" fontSize="xs" isNumeric fontFamily="mono">{fv(ref)}</Td>
                          <Td borderColor="gray.700" fontSize="xs" isNumeric fontFamily="mono" color="cyan.300">{fv(ideal)}</Td>
                          <Td borderColor="gray.700" fontSize="xs" isNumeric fontFamily="mono"
                            color={delta > 0 ? 'green.300' : 'red.300'}>
                            {delta >= 0 ? '+' : ''}{fv(delta)}
                          </Td>
                        </Tr>
                      ))}
                    </Tbody>
                  </Table>
                )}
              </Box>

              {/* ── 4. Calculation chain ── */}
              {triggeredWorkflows.length > 0 && (
                <>
                  <Divider borderColor="gray.600" />
                  <Box>
                    <Text fontSize="xs" fontWeight="700" color="gray.400" textTransform="uppercase" letterSpacing="0.08em" mb={3}>
                      Calculation Chain
                    </Text>
                    <VStack align="stretch" spacing={4}>
                      {triggeredWorkflows.map((wf, wi) => (
                        <Box key={wi} borderLeft="3px solid" borderColor="cyan.700" pl={3}>
                          <Text fontSize="sm" fontWeight="700" color="cyan.200" mb={1}>
                            {wi + 1}. {wf.name}
                          </Text>
                          <Text fontSize="xs" color="gray.400" mb={2} fontStyle="italic">
                            {wf.trigger}
                          </Text>
                          <VStack align="stretch" spacing={1} mb={2}>
                            {wf.steps.map((step, si) => (
                              <HStack key={si} align="start" spacing={2}>
                                <Text fontSize="xs" color="cyan.600" mt="1px" flexShrink={0}>›</Text>
                                <Text
                                  fontSize="xs"
                                  fontFamily={step.startsWith(' ') || step.includes('=') ? 'mono' : undefined}
                                  color={step.startsWith(' ') ? 'gray.400' : 'gray.200'}
                                  whiteSpace="pre-wrap"
                                >
                                  {step}
                                </Text>
                              </HStack>
                            ))}
                          </VStack>
                          <HStack flexWrap="wrap" gap={1}>
                            <Text fontSize="xs" color="gray.500">Outputs:</Text>
                            {wf.outputs.map((out) => (
                              <Text
                                key={out}
                                fontSize="xs"
                                fontFamily="mono"
                                bg={out === comparison.attribute ? 'cyan.800' : 'gray.700'}
                                color={out === comparison.attribute ? 'cyan.200' : 'gray.300'}
                                px={1.5}
                                py={0.5}
                                borderRadius="sm"
                              >
                                {out}
                              </Text>
                            ))}
                          </HStack>
                        </Box>
                      ))}
                    </VStack>
                  </Box>
                </>
              )}

            </VStack>
          </ModalBody>
          <ModalFooter>
            <Button size="sm" colorScheme="cyan" onClick={() => setIsCalcModalOpen(false)}>Close</Button>
          </ModalFooter>
        </ModalContent>
      </Modal>
    </Box>
  );
}

export default ViewPane;
