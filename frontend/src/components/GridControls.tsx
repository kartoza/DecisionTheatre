import { useCallback, useRef } from 'react';
import {
  Box, Button, HStack, Icon, IconButton, Menu, MenuButton, MenuDivider,
  MenuItem, MenuList, Spinner, Tooltip, useColorModeValue,
} from '@chakra-ui/react';
import {
  FiActivity, FiBarChart2, FiEdit2, FiGlobe, FiMap, FiMoreHorizontal,
  FiPlus, FiSquare, FiTable, FiTarget,
} from 'react-icons/fi';
import type { RangeMode, ViewMode } from '../types';

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
  rangeGroupLabel: 'Colour range',
  map: 'Map',
  chart: 'Chart',
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
} as const;

const VIEW_MODES: { id: ViewMode; label: string; icon: React.ReactElement }[] = [
  { id: 'map', label: STRINGS.map, icon: <FiMap /> },
  { id: 'chart', label: STRINGS.chart, icon: <FiBarChart2 /> },
  { id: 'dial', label: STRINGS.dial, icon: <FiActivity /> },
  { id: 'table', label: STRINGS.table, icon: <FiTable /> },
];

const RANGE_MODES: { id: RangeMode; label: string; icon: React.ReactElement }[] = [
  { id: 'domain', label: STRINGS.rangeFull, icon: <FiGlobe size={14} /> },
  { id: 'extent', label: STRINGS.rangeExtent, icon: <FiSquare size={14} /> },
  { id: 'site', label: STRINGS.rangeSite, icon: <FiTarget size={14} /> },
];

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
  renderLabel,
}: {
  label: string;
  options: { id: T; label: string; icon: React.ReactElement }[];
  value: T | undefined;
  onChange: (id: T) => void;
  isOptionDisabled?: (id: T) => boolean;
  renderLabel?: boolean;
}) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const selectedBg = useColorModeValue('brand.500', 'brand.400');
  const selectedFg = 'white';
  const restFg = useColorModeValue('gray.600', 'gray.300');
  const underline = useColorModeValue('brand.700', 'brand.200');

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
            // One tab stop for the group: only the selected option is
            // reachable by Tab, and the arrows move between them.
            tabIndex={isSelected ? 0 : -1}
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
            borderRadius="md"
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
            label={disabled ? STRINGS.noSite : `${option.label}${renderLabel ? ` ${STRINGS.rangeSuffix}` : ''}`}
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
}: GridControlsProps) {
  const dividerColor = useColorModeValue('gray.300', 'gray.600');
  const noSite = useCallback((id: RangeMode) => id === 'site' && !siteId, [siteId]);

  return (
    <>
      {/* Wide enough to lay the controls out: the full set, inline. */}
      <HStack spacing={2} display={{ base: 'none', lg: 'flex' }}>
        <SegmentedGroup
          label={STRINGS.viewGroupLabel}
          options={VIEW_MODES}
          value={viewMode}
          onChange={onViewModeChange}
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
            />
          </HStack>
        )}

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
      <HStack spacing={1} display={{ base: 'flex', lg: 'none' }}>
        <SegmentedGroup
          label={STRINGS.viewGroupLabel}
          options={VIEW_MODES}
          value={viewMode}
          onChange={onViewModeChange}
        />
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
