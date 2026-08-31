import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Box, Button, HStack, Icon, IconButton, Menu, MenuButton, MenuDivider,
  MenuItem, MenuList, Spinner, Tooltip, useColorModeValue,
} from '@chakra-ui/react';
import {
  FiBarChart2, FiBox, FiColumns, FiEdit2, FiGlobe, FiInfo, FiMap,
  FiMinus, FiMoreHorizontal, FiPlus, FiSquare, FiTable, FiTarget,
} from 'react-icons/fi';
import { BsSpeedometer2 } from 'react-icons/bs';
import { colors } from '../styles/colors';
import type { RangeMode, ViewMode } from '../types';
import { satelliteUnavailable, subscribeSatelliteUnavailable } from '../lib/satelliteBasemap';

/**
 * The controls that act on the whole grid, in one place.
 *
 * These used to live in a full-width bar above the panes, which cost a
 * horizontal band of vertical space on the most space-starved screen in the
 * application, to hold four icons. They now sit in the header, in the gap that
 * was previously empty between the site title and the navigation group.
 *
 * Everything here is global by definition. Anything that acts on one pane
 * belongs in that pane's overlay and stays there — six panes legitimately need
 * six focus buttons, and that is not duplication.
 */

/**
 * Every user-visible string, in one object.
 *
 * There is no i18n layer in this application yet. Collecting the strings here
 * does not create one, but it means the eventual extraction is mechanical
 * rather than a hunt through JSX, and it stops new hardcoded English being
 * scattered while that remains outstanding.
 */
const STRINGS = {
  viewGroupLabel: 'View for all panes',
  noSiteTable: 'The table needs a site — create or select one first',
  rangeGroupLabel: 'Colour range',
  map: 'Map',
  chart: 'Chart',
  flat: 'Flat',
  dial: 'Dial',
  table: 'Table',
  rangeFull: 'Full',
  rangeExtent: 'Extent',
  rangeSite: 'Site',
  rangeSuffix: 'range',
  noSite: 'No site selected',
  addPane: 'Add pane',
  targets: 'Targets',
  editTargets: 'Edit target values',
  extracting: 'Extracting indicators…',
  more: 'More controls',
  mapGroupLabel: 'Map display',
  view3D: 'Show 3D extrusion',
  view2D: 'Show flat map',
  showChoropleth: 'Show choropleth',
  hideChoropleth: 'Hide choropleth',
  identifyOn: 'Identify catchment',
  identifyOff: 'Stop identifying',
  satelliteOn: 'Switch to satellite',
  satelliteOff: 'Switch to default basemap',
  satelliteUnavailable: 'Satellite imagery is unavailable',
  swiperOn: 'Enable map swiper',
  swiperOff: 'Disable map swiper',
  zoomToSite: 'Zoom to site',
} as const;

/**
 * Broadcast to every mounted map. The maps own their own MapLibre instance and
 * cannot be reached from the header by prop, so the zoom is an event — the same
 * one the guided tour already dispatches, handled by the same listener.
 */
function zoomToSite() {
  window.dispatchEvent(new Event('dt:zoom-to-site'));
}

const VIEW_MODES: { id: ViewMode; label: string; icon: React.ReactElement }[] = [
  { id: 'map', label: STRINGS.map, icon: <FiMap /> },
  { id: 'chart', label: STRINGS.chart, icon: <FiBarChart2 /> },
  { id: 'flat', label: STRINGS.flat, icon: <FiMinus /> },
  // A half-circle gauge rather than a zigzag: the icon should look like the
  // thing it switches to.
  { id: 'dial', label: STRINGS.dial, icon: <BsSpeedometer2 /> },
  { id: 'table', label: STRINGS.table, icon: <FiTable /> },
];

const RANGE_MODES: { id: RangeMode; label: string; icon: React.ReactElement }[] = [
  { id: 'domain', label: STRINGS.rangeFull, icon: <FiGlobe size={14} /> },
  { id: 'extent', label: STRINGS.rangeExtent, icon: <FiSquare size={14} /> },
  { id: 'site', label: STRINGS.rangeSite, icon: <FiTarget size={14} /> },
];

/**
 * The accent a control group paints its active state with.
 *
 * The header carries three clusters — view, colour range, map display — and
 * with one shared accent they read as a single undifferentiated row of icons.
 * Giving each its own accent ties it to the thing it acts on: view keeps the
 * brand blue, colour range takes the Create Site orange, and the map toggles
 * take the site green. `selectedFg` is dark on the orange and the green because
 * white on either sits below the AA contrast floor.
 *
 * Passing no tone leaves a group on the brand blue it had before.
 */
interface Tone {
  selectedBg: string;
  selectedFg: string;
  underline: string;
}

const TONE_RANGE: Tone = {
  selectedBg: colors.orange,
  selectedFg: colors.dark,
  underline: colors.pastelDarkOrange,
};

const TONE_MAP: Tone = {
  selectedBg: colors.brightGreen,
  selectedFg: colors.dark,
  underline: colors.pastelLightGreen,
};

/**
 * An independent on/off control.
 *
 * Deliberately not a radio: these five are not a set of alternatives, they are
 * five separate settings, so each is its own tab stop with `aria-pressed`. As
 * with SegmentedGroup, the pressed state carries an underline as well as a
 * background, because colour alone is not a distinction everyone can see.
 */
function ToggleButton({
  label, icon, isOn, onToggle, isDisabled, disabledLabel, tone,
}: {
  label: string;
  icon: React.ReactElement;
  isOn: boolean;
  onToggle: () => void;
  isDisabled?: boolean;
  disabledLabel?: string;
  tone?: Tone;
}) {
  const brandBg = useColorModeValue('brand.500', 'brand.400');
  const brandUnderline = useColorModeValue('brand.700', 'brand.200');
  const offFg = useColorModeValue('gray.600', 'gray.300');
  const onBg = tone?.selectedBg ?? brandBg;
  const onFg = tone?.selectedFg ?? 'white';
  const underline = tone?.underline ?? brandUnderline;
  return (
    <Tooltip label={isDisabled ? disabledLabel ?? label : label} placement="bottom">
      {/* Tooltip needs a focusable child, so the disabled case wraps in a Box. */}
      <Box>
        <IconButton
          aria-label={label}
          aria-pressed={isOn}
          icon={icon}
          isDisabled={isDisabled}
          onClick={onToggle}
          size="sm"
          variant="ghost"
          minW={8}
          bg={isOn ? onBg : 'transparent'}
          color={isOn ? onFg : offFg}
          borderBottom="2px solid"
          borderColor={isOn ? underline : 'transparent'}
          _hover={{ bg: isDisabled ? 'transparent' : isOn ? onBg : 'blackAlpha.100' }}
        />
      </Box>
    </Tooltip>
  );
}

interface MapToggle {
  key: string;
  label: string;
  icon: React.ReactElement;
  isOn: boolean;
  onToggle: () => void;
  isDisabled?: boolean;
  disabledLabel?: string;
}

/**
 * The five toggles and zoom-to-site, as one unit.
 *
 * Shared by both layouts below rather than written twice: the whole point of
 * this component is that a control exists once, and duplicating the markup to
 * get two breakpoints would reintroduce the problem one level up.
 */
function MapToggleCluster({
  toggles, siteId, dividerColor,
}: {
  toggles: MapToggle[];
  siteId?: string | null;
  dividerColor: string;
}) {
  if (toggles.length === 0) return null;
  return (
    <HStack
      spacing={0.5}
      pl={2}
      borderLeft="1px solid"
      borderColor={dividerColor}
      aria-label={STRINGS.mapGroupLabel}
      role="group"
    >
      {toggles.map((t) => (
        <ToggleButton
          key={t.key}
          label={t.label}
          icon={t.icon}
          isOn={t.isOn}
          onToggle={t.onToggle}
          isDisabled={t.isDisabled}
          disabledLabel={t.disabledLabel}
          tone={TONE_MAP}
        />
      ))}
      <Tooltip label={STRINGS.zoomToSite} placement="bottom">
        <Box>
          <IconButton
            aria-label={STRINGS.zoomToSite}
            icon={<FiTarget />}
            onClick={zoomToSite}
            isDisabled={!siteId}
            size="sm"
            variant="ghost"
            minW={8}
          />
        </Box>
      </Tooltip>
    </HStack>
  );
}

interface GridControlsProps {
  viewMode: ViewMode;
  onViewModeChange: (mode: ViewMode) => void;
  rangeMode?: RangeMode;
  onRangeModeChange?: (mode: RangeMode) => void;
  onAddPane?: () => void;
  onOpenTargets?: () => void;
  hasTargets?: boolean;
  siteId?: string | null;
  isExtracting?: boolean;
  // The five map toggles. Each acted on every pane already, while being drawn
  // once per pane; they are drawn once now.
  is3DMode?: boolean;
  onIs3DModeChange?: (enabled: boolean) => void;
  isChoroplethEnabled?: boolean;
  onChoroplethEnabledChange?: (enabled: boolean) => void;
  isIdentifyMode?: boolean;
  onIdentifyModeChange?: (enabled: boolean) => void;
  isGoogleBasemap?: boolean;
  onGoogleBasemapChange?: (enabled: boolean) => void;
  isSwiperEnabled?: boolean;
  onSwiperEnabledChange?: (enabled: boolean) => void;
}

/**
 * A set of mutually exclusive choices, with the keyboard behaviour that implies.
 *
 * These were four independent IconButtons distinguished only by background
 * colour: four tab stops for one decision, and a selection a screen reader could
 * not report. A radiogroup is one tab stop with arrow keys between the options,
 * and `aria-checked` says which is chosen. The selected option also carries an
 * underline, because colour alone is not a distinction everyone can see.
 */
function SegmentedGroup<T extends string>({
  label,
  options,
  value,
  onChange,
  isOptionDisabled,
  disabledLabel,
  renderLabel,
  tone,
}: {
  label: string;
  options: { id: T; label: string; icon: React.ReactElement }[];
  value: T | undefined;
  onChange: (id: T) => void;
  isOptionDisabled?: (id: T) => boolean;
  disabledLabel?: string;
  renderLabel?: boolean;
  tone?: Tone;
}) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const brandBg = useColorModeValue('brand.500', 'brand.400');
  const brandUnderline = useColorModeValue('brand.700', 'brand.200');
  const restFg = useColorModeValue('gray.600', 'gray.300');
  const selectedBg = tone?.selectedBg ?? brandBg;
  const selectedFg = tone?.selectedFg ?? 'white';
  const underline = tone?.underline ?? brandUnderline;

  // Arrow keys move within the group and wrap, which is what a radiogroup is
  // expected to do; Home and End jump to the ends.
  const onKeyDown = useCallback((event: React.KeyboardEvent, index: number) => {
    const usable = options.filter((o) => !isOptionDisabled?.(o.id));
    if (usable.length === 0) return;

    let next: number | null = null;
    switch (event.key) {
      case 'ArrowRight':
      case 'ArrowDown':
        next = (index + 1) % options.length;
        break;
      case 'ArrowLeft':
      case 'ArrowUp':
        next = (index - 1 + options.length) % options.length;
        break;
      case 'Home':
        next = 0;
        break;
      case 'End':
        next = options.length - 1;
        break;
      default:
        return;
    }
    // Step over anything disabled rather than landing on it.
    let guard = 0;
    while (next !== null && isOptionDisabled?.(options[next].id) && guard < options.length) {
      next = (next + (event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -1 : 1) + options.length) % options.length;
      guard += 1;
    }
    if (next === null) return;
    event.preventDefault();
    refs.current[next]?.focus();
    onChange(options[next].id);
  }, [options, isOptionDisabled, onChange]);

  // The selected option carries the group's only tab stop — unless it is
  // itself disabled, which would take the whole group out of the tab order.
  // That is reachable: the table view disables when the site is cleared, and it
  // can be the selected view when that happens. The stop falls back to the
  // first enabled option so the group stays usable from the keyboard.
  const selectedIndex = options.findIndex((o) => o.id === value);
  const tabStopIndex = selectedIndex >= 0 && !isOptionDisabled?.(options[selectedIndex].id)
    ? selectedIndex
    : options.findIndex((o) => !isOptionDisabled?.(o.id));

  return (
    <HStack role="radiogroup" aria-label={label} spacing={0.5}>
      {options.map((option, index) => {
        const isSelected = option.id === value;
        const disabled = isOptionDisabled?.(option.id) ?? false;
        const content = (
          <Button
            key={option.id}
            ref={(el) => { refs.current[index] = el; }}
            role="radio"
            aria-checked={isSelected}
            aria-label={renderLabel ? undefined : option.label}
            // One tab stop for the group, and the arrows move between the
            // options from there. See tabStopIndex above for which option
            // carries it.
            tabIndex={index === tabStopIndex ? 0 : -1}
            isDisabled={disabled}
            onClick={() => !disabled && onChange(option.id)}
            onKeyDown={(e) => onKeyDown(e, index)}
            size="sm"
            variant="ghost"
            px={renderLabel ? 3 : 2}
            minW={renderLabel ? undefined : 8}
            fontSize="xs"
            fontWeight={isSelected ? 600 : 400}
            bg={isSelected ? selectedBg : 'transparent'}
            color={isSelected ? selectedFg : restFg}
            borderBottom="2px solid"
            borderColor={isSelected ? underline : 'transparent'}
            _hover={{ bg: disabled ? 'transparent' : isSelected ? selectedBg : 'blackAlpha.100' }}
          >
            {renderLabel
              ? <HStack spacing={1.5}><Icon as={() => option.icon} />{option.label}</HStack>
              : option.icon}
          </Button>
        );
        return (
          <Tooltip
            key={option.id}
            label={disabled ? disabledLabel ?? STRINGS.noSite : `${option.label}${renderLabel ? ` ${STRINGS.rangeSuffix}` : ''}`}
            placement="bottom"
          >
            {content}
          </Tooltip>
        );
      })}
    </HStack>
  );
}

function GridControls({
  viewMode,
  onViewModeChange,
  rangeMode,
  onRangeModeChange,
  onAddPane,
  onOpenTargets,
  hasTargets,
  siteId,
  isExtracting,
  is3DMode = false,
  onIs3DModeChange,
  isChoroplethEnabled = true,
  onChoroplethEnabledChange,
  isIdentifyMode = false,
  onIdentifyModeChange,
  isGoogleBasemap = false,
  onGoogleBasemapChange,
  isSwiperEnabled = true,
  onSwiperEnabledChange,
}: GridControlsProps) {
  const dividerColor = useColorModeValue('gray.300', 'gray.600');
  const noSite = useCallback((id: RangeMode) => id === 'site' && !siteId, [siteId]);
  const noSiteTable = useCallback((id: ViewMode) => id === 'table' && !siteId, [siteId]);

  // Satellite can become unavailable at runtime — quota spent, or no provider
  // configured once /api/info resolves. The button says so rather than offering
  // a switch that silently fails.
  const [noSatellite, setNoSatellite] = useState(satelliteUnavailable);
  useEffect(() => subscribeSatelliteUnavailable(setNoSatellite), []);

  // Only meaningful over a map. In chart, dial or table view they would be
  // controls for something not on screen.
  const showMapToggles = viewMode === 'map';
  const mapToggles: (MapToggle & { on?: (enabled: boolean) => void })[] = ([
    { key: '3d', label: is3DMode ? STRINGS.view2D : STRINGS.view3D, icon: <FiBox />, isOn: is3DMode, onToggle: () => onIs3DModeChange?.(!is3DMode), on: onIs3DModeChange },
    { key: 'choropleth', label: isChoroplethEnabled ? STRINGS.hideChoropleth : STRINGS.showChoropleth, icon: <FiMap />, isOn: isChoroplethEnabled, onToggle: () => onChoroplethEnabledChange?.(!isChoroplethEnabled), on: onChoroplethEnabledChange },
    { key: 'identify', label: isIdentifyMode ? STRINGS.identifyOff : STRINGS.identifyOn, icon: <FiInfo />, isOn: isIdentifyMode, onToggle: () => onIdentifyModeChange?.(!isIdentifyMode), on: onIdentifyModeChange },
    { key: 'satellite', label: isGoogleBasemap ? STRINGS.satelliteOff : STRINGS.satelliteOn, icon: <FiGlobe />, isOn: isGoogleBasemap, onToggle: () => onGoogleBasemapChange?.(!isGoogleBasemap), on: onGoogleBasemapChange, isDisabled: noSatellite && !isGoogleBasemap, disabledLabel: STRINGS.satelliteUnavailable },
    { key: 'swiper', label: isSwiperEnabled ? STRINGS.swiperOff : STRINGS.swiperOn, icon: <FiColumns />, isOn: isSwiperEnabled, onToggle: () => onSwiperEnabledChange?.(!isSwiperEnabled), on: onSwiperEnabledChange },
  ] as const).filter((t) => t.on && showMapToggles);

  return (
    <>
      {/* Wide enough to lay the controls out: the full set, inline. */}
      <HStack spacing={2} display={{ base: 'none', xl: 'flex' }} data-testid="grid-controls-wide">
        <SegmentedGroup
          label={STRINGS.viewGroupLabel}
          options={VIEW_MODES}
          value={viewMode}
          onChange={onViewModeChange}
          isOptionDisabled={noSiteTable}
          disabledLabel={STRINGS.noSiteTable}
        />

        {onRangeModeChange && (
          <HStack spacing={2} pl={2} borderLeft="1px solid" borderColor={dividerColor}>
            <SegmentedGroup
              label={STRINGS.rangeGroupLabel}
              options={RANGE_MODES}
              value={rangeMode}
              onChange={onRangeModeChange}
              isOptionDisabled={noSite}
              renderLabel
              tone={TONE_RANGE}
            />
          </HStack>
        )}

        <MapToggleCluster toggles={mapToggles} siteId={siteId} dividerColor={dividerColor} />

        {onAddPane && (
          <Tooltip label={STRINGS.addPane} placement="bottom">
            <IconButton
              aria-label={STRINGS.addPane}
              icon={<FiPlus />}
              onClick={onAddPane}
              size="sm"
              variant="ghost"
            />
          </Tooltip>
        )}

        {hasTargets && onOpenTargets && (
          <Tooltip label={STRINGS.editTargets} placement="bottom">
            <Button
              id="demo-edit-targets-btn"
              size="sm"
              variant="ghost"
              leftIcon={<FiEdit2 size={14} />}
              onClick={onOpenTargets}
            >
              {STRINGS.targets}
            </Button>
          </Tooltip>
        )}

        {isExtracting && (
          <HStack spacing={2} color="gray.500">
            <Spinner size="xs" />
            <Box fontSize="sm">{STRINGS.extracting}</Box>
          </HStack>
        )}
      </HStack>

      {/*
        Narrow: the view switch stays visible, because it is the primary control
        on this screen and hiding it would make the interface unusable on a
        phone. Everything else moves into a menu rather than disappearing — the
        existing navigation group's display:none pattern is not acceptable here.
      */}
      <HStack spacing={1} display={{ base: 'flex', xl: 'none' }} data-testid="grid-controls-narrow">
        <SegmentedGroup
          label={STRINGS.viewGroupLabel}
          options={VIEW_MODES}
          value={viewMode}
          onChange={onViewModeChange}
          isOptionDisabled={noSiteTable}
          disabledLabel={STRINGS.noSiteTable}
        />
        {/*
          The toggles are icons already, so they still fit beside the view
          switch on a laptop; below md they would push the title off the row,
          and the menu carries them from there down.
        */}
        <Box display={{ base: 'none', md: 'flex' }}>
          <MapToggleCluster toggles={mapToggles} siteId={siteId} dividerColor={dividerColor} />
        </Box>
        <Menu>
          <MenuButton
            as={IconButton}
            aria-label={STRINGS.more}
            icon={<FiMoreHorizontal />}
            size="sm"
            variant="ghost"
          />
          <MenuList>
            {onRangeModeChange && RANGE_MODES.map((mode) => (
              <MenuItem
                key={mode.id}
                icon={mode.icon}
                isDisabled={noSite(mode.id)}
                onClick={() => onRangeModeChange(mode.id)}
                fontWeight={rangeMode === mode.id ? 600 : 400}
              >
                {`${mode.label} ${STRINGS.rangeSuffix}`}
              </MenuItem>
            ))}
            {showMapToggles && mapToggles.length > 0 && <MenuDivider />}
            {showMapToggles && mapToggles.map((t) => (
              <MenuItem
                key={t.key}
                icon={t.icon}
                isDisabled={t.isDisabled}
                onClick={t.onToggle}
                fontWeight={t.isOn ? 600 : 400}
              >
                {t.isDisabled ? t.disabledLabel ?? t.label : t.label}
              </MenuItem>
            ))}
            {showMapToggles && (
              <MenuItem icon={<FiTarget />} isDisabled={!siteId} onClick={zoomToSite}>
                {STRINGS.zoomToSite}
              </MenuItem>
            )}
            {onAddPane && <MenuDivider />}
            {onAddPane && (
              <MenuItem icon={<FiPlus />} onClick={onAddPane}>{STRINGS.addPane}</MenuItem>
            )}
            {hasTargets && onOpenTargets && (
              <MenuItem icon={<FiEdit2 />} onClick={onOpenTargets}>{STRINGS.targets}</MenuItem>
            )}
          </MenuList>
        </Menu>
      </HStack>
    </>
  );
}

export default GridControls;
export { STRINGS as GRID_CONTROL_STRINGS };
