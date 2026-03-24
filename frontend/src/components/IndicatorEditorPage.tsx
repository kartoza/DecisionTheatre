import {
  Box,
  Button,
  Flex,
  FormControl,
  Heading,
  HStack,
  Icon,
  IconButton,
  Input,
  NumberInput,
  NumberInputField,
  Spinner,
  Stat,
  StatHelpText,
  StatLabel,
  StatNumber,
  Select,
  Table,
  Tbody,
  Td,
  Text,
  Th,
  Thead,
  Tooltip,
  Tr,
  useColorModeValue,
  useToast,
  VStack,
} from '@chakra-ui/react';
import { motion, AnimatePresence } from 'framer-motion';
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  FiArrowLeft,
  FiRefreshCw,
  FiSave,
  FiAlertTriangle,
  FiBarChart2,
  FiEdit2,
  FiCheck,
  FiX,
  FiChevronDown,
  FiChevronRight,
} from 'react-icons/fi';
import type { Site, SiteIndicators, AppPage } from '../types';
import { getAppRuntime } from '../types/runtime';
import { useAttributeDetails, useAttributeUserInputs, useAttributeVariableTypes } from '../hooks/useApi';
import { colors } from '../styles/colors';

const MotionTr = motion(Tr);

interface IndicatorEditorPageProps {
  site: Site;
  onNavigate: (page: AppPage) => void;
  onSiteUpdated: (site: Site) => void;
}

interface IndicatorRow {
  key: string;
  label: string;
  reference: number;
  current: number;
  ideal: number;
  idealLower: number;
  idealUpper: number;
  unit: string;
  description?: string;
}

// Helper to format numbers nicely
function formatValue(value: number | undefined): string {
  if (value === undefined || value === null) return 'N/A';
  if (Math.abs(value) >= 1000000) return (value / 1000000).toFixed(2) + 'M';
  if (Math.abs(value) >= 1000) return (value / 1000).toFixed(2) + 'K';
  if (Math.abs(value) < 0.01) return value.toExponential(2);
  return value.toFixed(2);
}

// Helper to get a human-readable label from indicator key
function getIndicatorLabel(key: string): string {
  // Remove common suffixes and clean up
  return key
    .replace(/_kgkm2$/i, '')
    .replace(/_tonkm2$/i, '')
    .replace(/_tot$/i, '')
    .split('_')
    .map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(' ');
}

// Helper to get unit from indicator key
function getIndicatorUnit(key: string): string {
  if (key.endsWith('_kgkm2')) return 'kg/km²';
  if (key.endsWith('_tonkm2')) return 'ton/km²';
  if (key.includes('area')) return 'km²';
  if (key.includes('count')) return 'count';
  return '';
}

function formatVariableType(value: string): string {
  return value
    .replace(/_/g, ' ')
    .split(' ')
    .map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(' ');
}

// Calculate trend indicator
function getTrend(current: number, reference: number): 'up' | 'down' | 'neutral' {
  const threshold = 0.05; // 5% change threshold
  const change = (current - reference) / Math.abs(reference || 1);
  if (change > threshold) return 'up';
  if (change < -threshold) return 'down';
  return 'neutral';
}

type ReferenceDeltaDirection = 'left' | 'right' | 'neutral';

function getReferenceDirection(value: number, reference: number): ReferenceDeltaDirection {
  if (value > reference) return 'right';
  if (value < reference) return 'left';
  return 'neutral';
}

function ReferenceDeltaGlyph({ direction, color }: { direction: ReferenceDeltaDirection; color: string }) {
  const lineLength = 10;
  const lineOffset = 1;

  return (
    <Box
      as="span"
      display="inline-block"
      position="relative"
      w="22px"
      h="12px"
      verticalAlign="middle"
      aria-hidden="true"
    >
      <Box
        position="absolute"
        left="50%"
        top="1px"
        bottom="1px"
        w="2px"
        bg="gray.500"
        transform="translateX(-1px)"
        borderRadius="full"
      />
      {direction === 'neutral' ? (
        <Box
          position="absolute"
          left="50%"
          top="4px"
          w="4px"
          h="4px"
          bg={color}
          borderRadius="full"
          transform="translateX(-2px)"
        />
      ) : (
        <Box
          position="absolute"
          top="5px"
          left={direction === 'right' ? `calc(50% + ${lineOffset}px)` : `calc(50% - ${lineLength + lineOffset}px)`}
          w={`${lineLength}px`}
          h="2px"
          bg={color}
          borderRadius="full"
        />
      )}
    </Box>
  );
}

function ReferenceTrendLines({ reference, current, target }: { reference: number; current: number; target: number }) {
  const maxLinePx = 26;
  const referenceMagnitude = Math.abs(reference) || 1;

  const buildLine = (value: number, color: string, top: string) => {
    const delta = value - reference;
    const direction = getReferenceDirection(value, reference);
    if (direction === 'neutral') {
      return (
        <Box
          key={`${color}-neutral`}
          position="absolute"
          left="50%"
          top={top}
          w="4px"
          h="4px"
          bg={color}
          borderRadius="full"
          transform="translate(-2px, -1px)"
        />
      );
    }

    const ratio = Math.min(1, Math.abs(delta) / referenceMagnitude);
    const width = Math.max(2, ratio * maxLinePx);
    const left =
      direction === 'right'
        ? `calc(50% + 1px)`
        : `calc(50% - ${width + 1}px)`;

    return (
      <Box
        key={`${color}-${direction}`}
        position="absolute"
        top={top}
        left={left}
        w={`${width}px`}
        h="2px"
        bg={color}
        borderRadius="full"
      />
    );
  };

  return (
    <Box position="relative" w="90px" h="16px" aria-hidden="true">
      <Box
        position="absolute"
        left="50%"
        top="1px"
        bottom="1px"
        w="2px"
        bg="gray.500"
        transform="translateX(-1px)"
        borderRadius="full"
      />
      {buildLine(current, 'cyan.300', '4px')}
      {buildLine(target, 'green.300', '10px')}
    </Box>
  );
}

export default function IndicatorEditorPage({ site, onNavigate, onSiteUpdated }: IndicatorEditorPageProps) {
  const [isLoading, setIsLoading] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [editingKey, setEditingKey] = useState<string | null>(null);
  const [editValue, setEditValue] = useState<string>('');
  const [editBoundsExpanded, setEditBoundsExpanded] = useState(false);
  const [editUpperValue, setEditUpperValue] = useState<string>('');
  const [localIndicators, setLocalIndicators] = useState<SiteIndicators | null>(site.indicators || null);
  const [hasChanges, setHasChanges] = useState(false);
  const [searchFilter, setSearchFilter] = useState('');
  const [selectedIndicatorKey, setSelectedIndicatorKey] = useState('');
  const [collapsedGroups, setCollapsedGroups] = useState<Record<string, boolean>>({});
  const lastCatchmentCountRef = useRef<number | null>(null);
  const toast = useToast();
  const { details: attributeDetails } = useAttributeDetails();
  const { userInputs } = useAttributeUserInputs();
  const { variableTypes } = useAttributeVariableTypes();

  const headerBg = useColorModeValue('gray.900', 'gray.900');
  const tableBg = useColorModeValue('gray.850', 'gray.850');
  const hoverBg = useColorModeValue('whiteAlpha.100', 'whiteAlpha.100');

  const extractIndicators = useCallback(async () => {
    setIsLoading(true);
    const runtime = getAppRuntime();
    var jsonData = {}
    if (runtime === 'browser') {
        // Use current in-memory site state so boundary edits are included
        const { thumbnail, ...siteWithoutThumbnail } = site;
        jsonData = {
          "runtime": "browser",
          "site": siteWithoutThumbnail,
        };
    }
    else if (runtime === 'webview') {
        jsonData = {
          "runtime": "webview",
          "site": {}
        }
    }
    try {
      const response = await fetch(`/api/sites/${site.id}/indicators`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(jsonData),
      });
      if (response.ok) {
        const updatedSiteFromApi: Site = await response.json();
        // Preserve the local thumbnail since it was excluded from the API request
        const updatedSite: Site = { ...updatedSiteFromApi, thumbnail: site.thumbnail };
        if (runtime === 'browser') {
          try {
            const raw = window.localStorage.getItem('dt-sites');
            if (!raw) {
              window.localStorage.setItem('dt-sites', JSON.stringify([updatedSite]));
            } else {
              const parsed: unknown = JSON.parse(raw);
              if (Array.isArray(parsed)) {
                const storedSites = parsed as Site[];
                const updatedSites = storedSites.some(stored => stored.id === updatedSite.id)
                  ? storedSites.map(stored => (stored.id === updatedSite.id ? updatedSite : stored))
                  : [...storedSites, updatedSite];
                window.localStorage.setItem('dt-sites', JSON.stringify(updatedSites));
              }
            }
          } catch (error) {
            console.warn('Failed to persist updated site to localStorage:', error);
          }
        }
        console.log("updatedSite", updatedSite)
        setLocalIndicators(updatedSite.indicators ?? null);
        onSiteUpdated(updatedSite);
        toast({
          title: 'Indicators extracted',
          description: `Aggregated ${updatedSite.indicators?.catchmentCount || 0} catchments`,
          status: 'success',
          duration: 3000,
        });
      } else {
        throw new Error('Failed to extract indicators');
      }
    } catch (error) {
      toast({
        title: 'Extraction failed',
        description: 'Could not extract indicators from catchments',
        status: 'error',
        duration: 5000,
      });
    } finally {
      setIsLoading(false);
    }
  }, [site.id, onSiteUpdated, toast]);

  // Extract indicators on mount if not already present
  useEffect(() => {
    if (!site.indicators && site.catchmentIds && site.catchmentIds.length > 0) {
      extractIndicators();
    }
  }, [site.id, extractIndicators, site.catchmentIds, site.indicators]);

  useEffect(() => {
    if (!site.indicators) return;
    if (!localIndicators || !hasChanges) {
      setLocalIndicators(site.indicators);
      return;
    }

    setLocalIndicators((prev) => {
      if (!prev) return site.indicators ?? null;
      return {
        ...prev,
        catchmentCount: site.indicators?.catchmentCount ?? prev.catchmentCount,
        totalAreaKm2: site.indicators?.totalAreaKm2 ?? prev.totalAreaKm2,
        catchmentIds: site.indicators?.catchmentIds ?? prev.catchmentIds,
        extractedAt: site.indicators?.extractedAt ?? prev.extractedAt,
      };
    });
  }, [site.id, site.indicators, hasChanges, localIndicators]);

  useEffect(() => {
    const nextCount = site.catchmentIds?.length ?? null;
    if (nextCount === null) return;
    if (lastCatchmentCountRef.current === null) {
      lastCatchmentCountRef.current = nextCount;
      return;
    }

    if (nextCount !== lastCatchmentCountRef.current) {
      lastCatchmentCountRef.current = nextCount;
      if (!hasChanges && !isLoading) {
        extractIndicators();
      }
    }
  }, [site.catchmentIds, hasChanges, isLoading, extractIndicators]);

  const handleSaveChanges = useCallback(async () => {
    if (!localIndicators) return;

    setIsSaving(true);
    try {
      const runtime = getAppRuntime();

      if (runtime === 'browser') {
        const updatedSite: Site = {
          ...site,
          indicators: localIndicators,
        };

        try {
          const raw = window.localStorage.getItem('dt-sites');
          if (!raw) {
            window.localStorage.setItem('dt-sites', JSON.stringify([updatedSite]));
          } else {
            const parsed: unknown = JSON.parse(raw);
            if (Array.isArray(parsed)) {
              const storedSites = parsed as Site[];
              const updatedSites = storedSites.some(stored => stored.id === updatedSite.id)
                ? storedSites.map(stored => (stored.id === updatedSite.id ? updatedSite : stored))
                : [...storedSites, updatedSite];
              window.localStorage.setItem('dt-sites', JSON.stringify(updatedSites));
            }
          }
        } catch (error) {
          console.warn('Failed to persist saved indicator changes to localStorage:', error);
          throw new Error('Failed to save locally');
        }

        onSiteUpdated(updatedSite);
        setHasChanges(false);
        toast({
          title: 'Changes saved',
          status: 'success',
          duration: 2000,
        });
      } else {
        const response = await fetch(`/api/sites/${site.id}/indicators`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ideal: localIndicators.ideal, idealLower: localIndicators.idealLower, idealUpper: localIndicators.idealUpper }),
        });

        if (response.ok) {
          const updatedSite = await response.json();
          onSiteUpdated(updatedSite);
          setHasChanges(false);
          toast({
            title: 'Changes saved',
            status: 'success',
            duration: 2000,
          });
        } else {
          throw new Error('Failed to save');
        }
      }
    } catch (error) {
      toast({
        title: 'Save failed',
        description: 'Could not save indicator changes',
        status: 'error',
        duration: 5000,
      });
    } finally {
      setIsSaving(false);
    }
  }, [site.id, localIndicators, onSiteUpdated, toast]);

  const handleResetIdeal = useCallback(async () => {
    if (!confirm('Reset all ideal values to ecological reference values? This cannot be undone.')) {
      return;
    }

    setIsLoading(true);
    try {
      const runtime = getAppRuntime();

      if (runtime === 'browser') {
        if (!localIndicators) {
          throw new Error('No local indicators to reset');
        }

        const resetIndicators: SiteIndicators = {
          reference: { ...(localIndicators.reference || {}) },
          current: { ...(localIndicators.current || {}) },
          ideal: { ...(localIndicators.reference || {}) },
          idealLower: { ...(localIndicators.reference || {}) },
          idealUpper: { ...(localIndicators.reference || {}) },
          extractedAt: localIndicators.extractedAt,
          catchmentCount: localIndicators.catchmentCount,
          totalAreaKm2: localIndicators.totalAreaKm2,
          catchmentIds: localIndicators.catchmentIds,
        };
        const updatedSite: Site = {
          ...site,
          indicators: resetIndicators,
        };

        try {
          const raw = window.localStorage.getItem('dt-sites');
          if (!raw) {
            window.localStorage.setItem('dt-sites', JSON.stringify([updatedSite]));
          } else {
            const parsed: unknown = JSON.parse(raw);
            if (Array.isArray(parsed)) {
              const storedSites = parsed as Site[];
              const updatedSites = storedSites.some(stored => stored.id === updatedSite.id)
                ? storedSites.map(stored => (stored.id === updatedSite.id ? updatedSite : stored))
                : [...storedSites, updatedSite];
              window.localStorage.setItem('dt-sites', JSON.stringify(updatedSites));
            }
          }
        } catch (error) {
          console.warn('Failed to persist reset indicator values to localStorage:', error);
          throw new Error('Failed to reset locally');
        }

        setLocalIndicators(resetIndicators);
        onSiteUpdated(updatedSite);
        setHasChanges(false);
        toast({
          title: 'Values reset',
          description: 'Ideal values have been reset to ecological reference values',
          status: 'info',
          duration: 3000,
        });
      } else {
        const response = await fetch(`/api/sites/${site.id}/indicators/reset`, {
          method: 'POST',
        });

        if (response.ok) {
          const updatedSite = await response.json();
          setLocalIndicators(updatedSite.indicators ?? null);
          onSiteUpdated(updatedSite);
          setHasChanges(false);
          toast({
            title: 'Values reset',
            description: 'Ideal values have been reset to ecological reference values',
            status: 'info',
            duration: 3000,
          });
        } else {
          throw new Error('Failed to reset');
        }
      }
    } catch (error) {
      toast({
        title: 'Reset failed',
        status: 'error',
        duration: 5000,
      });
    } finally {
      setIsLoading(false);
    }
  }, [site, localIndicators, onSiteUpdated, toast]);

  const handleStartEdit = useCallback((key: string, lower: number, upper: number) => {
    setEditingKey(key);
    setEditBoundsExpanded(lower !== upper);
    setEditValue(parseFloat(lower.toFixed(2)).toString());
    setEditUpperValue(parseFloat(upper.toFixed(2)).toString());
  }, []);

  const handleCancelEdit = useCallback(() => {
    setEditingKey(null);
    setEditValue('');
    setEditUpperValue('');
    setEditBoundsExpanded(false);
  }, []);

  const handleConfirmEdit = useCallback(() => {
    if (!editingKey || !localIndicators) return;

    const lower = parseFloat(editValue);
    const upper = parseFloat(editUpperValue || editValue);
    if (isNaN(lower) || isNaN(upper)) {
      toast({ title: 'Invalid value', status: 'error', duration: 2000 });
      return;
    }
    const mid = (lower + upper) / 2;

    setLocalIndicators(prev => {
      if (!prev) return prev;
      return {
        ...prev,
        ideal: { ...prev.ideal, [editingKey]: mid },
        idealLower: { ...(prev.idealLower ?? {}), [editingKey]: lower },
        idealUpper: { ...(prev.idealUpper ?? {}), [editingKey]: upper },
      };
    });
    setHasChanges(true);
    setEditingKey(null);
    setEditValue('');
    setEditUpperValue('');
    setEditBoundsExpanded(false);
  }, [editingKey, editValue, editUpperValue, localIndicators, toast]);

  const availableIndicatorKeys = useMemo(() => {
    if (!localIndicators) return [] as string[];

    const allowedInputs = Object.keys(userInputs || {}).length > 0
      ? new Set(Object.entries(userInputs).filter(([, allowed]) => allowed).map(([key]) => key))
      : null;

    const allKeys = new Set<string>();
    Object.keys(localIndicators.reference || {}).forEach(k => allKeys.add(k));
    Object.keys(localIndicators.current || {}).forEach(k => allKeys.add(k));
    Object.keys(localIndicators.ideal || {}).forEach(k => allKeys.add(k));

    return Array.from(allKeys)
      .filter(key => !allowedInputs || allowedInputs.has(key))
      .sort();
  }, [localIndicators, userInputs]);

  const indicatorGroups = useMemo(() => {
    const groups = new Map<string, { key: string; label: string }[]>();
    availableIndicatorKeys.forEach(key => {
      const groupName = variableTypes[key] ? formatVariableType(variableTypes[key]) : 'Other';
      const entries = groups.get(groupName) ?? [];
      entries.push({ key, label: attributeDetails[key] ?? getIndicatorLabel(key) });
      groups.set(groupName, entries);
    });

    return Array.from(groups.entries())
      .map(([groupName, entries]) => ({
        groupName,
        entries: entries.sort((a, b) => a.label.localeCompare(b.label)),
      }))
      .sort((a, b) => a.groupName.localeCompare(b.groupName));
  }, [availableIndicatorKeys, attributeDetails, variableTypes]);

  const groupedIndicatorRows = useMemo(() => {
    if (!localIndicators) return [] as { groupName: string; rows: IndicatorRow[] }[];

    const groups = indicatorGroups
      .map(group => {
        const rows = group.entries
          .filter(entry => {
            if (selectedIndicatorKey && entry.key !== selectedIndicatorKey) return false;
            if (!searchFilter) return true;
            const displayLabel = (attributeDetails[entry.key] ?? getIndicatorLabel(entry.key)).toLowerCase();
            return displayLabel.includes(searchFilter.toLowerCase())
              || entry.key.toLowerCase().includes(searchFilter.toLowerCase());
          })
          .map(entry => {
            const refVal = localIndicators.reference?.[entry.key] ?? 0;
            const idealVal = localIndicators.ideal?.[entry.key] ?? refVal;
            return {
              key: entry.key,
              label: attributeDetails[entry.key] ?? getIndicatorLabel(entry.key),
              reference: refVal,
              current: localIndicators.current?.[entry.key] ?? 0,
              ideal: idealVal,
              idealLower: localIndicators.idealLower?.[entry.key] ?? idealVal,
              idealUpper: localIndicators.idealUpper?.[entry.key] ?? idealVal,
              unit: getIndicatorUnit(entry.key),
            };
          });

        return { groupName: group.groupName, rows };
      })
      .filter(group => group.rows.length > 0);

    return groups;
  }, [attributeDetails, indicatorGroups, localIndicators, searchFilter, selectedIndicatorKey]);

  const totalIndicatorRows = useMemo(
    () => groupedIndicatorRows.reduce((sum, group) => sum + group.rows.length, 0),
    [groupedIndicatorRows]
  );

  // Calculate summary statistics
  const summaryStats = useMemo(() => {
    if (!localIndicators) return null;

    const allowedInputs = Object.keys(userInputs || {}).length > 0
      ? new Set(Object.entries(userInputs).filter(([, allowed]) => allowed).map(([key]) => key))
      : null;
    const keys = Object.keys(localIndicators.current || {})
      .filter(key => !allowedInputs || allowedInputs.has(key));
    let improved = 0;
    let degraded = 0;
    let unchanged = 0;

    keys.forEach(key => {
      const ref = localIndicators.reference?.[key] ?? 0;
      const cur = localIndicators.current?.[key] ?? 0;
      const trend = getTrend(cur, ref);
      if (trend === 'up') improved++;
      else if (trend === 'down') degraded++;
      else unchanged++;
    });

    return { total: keys.length, improved, degraded, unchanged };
  }, [localIndicators, userInputs]);

  if (isLoading && !localIndicators) {
    return (
      <Flex h="100%" align="center" justify="center" bg="gray.900">
        <VStack spacing={4}>
          <Spinner size="xl" color="cyan.400" thickness="4px" />
          <Text color="gray.300">Extracting indicators from catchments...</Text>
        </VStack>
      </Flex>
    );
  }

  if (!localIndicators) {
    return (
      <Flex h="100%" align="center" justify="center" bg="gray.900">
        <VStack spacing={6} textAlign="center" p={8}>
          <Icon as={FiAlertTriangle} boxSize={16} color="orange.400" />
          <Heading size="lg" color="white">No Indicators Available</Heading>
          <Text color="gray.400" maxW="400px">
            This site doesn't have indicator data yet. Click below to extract indicators from the constituent catchments.
          </Text>
          <Button
            colorScheme="cyan"
            size="lg"
            leftIcon={<FiBarChart2 />}
            onClick={extractIndicators}
            isLoading={isLoading}
          >
            Extract Indicators
          </Button>
          <Button
            variant="ghost"
            leftIcon={<FiArrowLeft />}
            onClick={() => onNavigate('map')}
          >
            Back to Map
          </Button>
        </VStack>
      </Flex>
    );
  }

  return (
    <Box h="100%" overflow="hidden" bg="gray.900">
      {/* Sticky Header */}
      <Box
        position="sticky"
        top={0}
        zIndex={10}
        bg={headerBg}
        borderBottom="1px solid"
        borderColor="whiteAlpha.200"
        px={6}
        py={4}
      >
        <Flex justify="space-between" align="center">
          <HStack spacing={4}>
            <IconButton
              aria-label="Back"
              icon={<FiArrowLeft />}
              variant="ghost"
              onClick={() => onNavigate('map')}
            />
            <VStack align="start" spacing={0}>
              <Heading size="md" color="white">
                {site.title} - Indicators
              </Heading>
              <Text fontSize="sm" color="gray.400">
                {localIndicators.catchmentCount} catchments | {localIndicators.totalAreaKm2?.toFixed(1)} km²
              </Text>
            </VStack>
          </HStack>

          <HStack spacing={3}>
            <FormControl maxW="250px">
              <Input
                placeholder="Search indicators..."
                value={searchFilter}
                onChange={(e) => setSearchFilter(e.target.value)}
                size="sm"
                bg="whiteAlpha.100"
                border="none"
                _placeholder={{ color: 'gray.500' }}
              />
            </FormControl>

            <FormControl maxW="260px">
              <Select
                size="sm"
                value={selectedIndicatorKey}
                onChange={(e) => setSelectedIndicatorKey(e.target.value)}
                bg="whiteAlpha.100"
                border="none"
                color="gray.100"
              >
                <option value="">All indicators</option>
                {indicatorGroups.map(group => (
                  <optgroup key={group.groupName} label={group.groupName}>
                    {group.entries.map(entry => (
                      <option key={entry.key} value={entry.key}>
                        {entry.label}
                      </option>
                    ))}
                  </optgroup>
                ))}
              </Select>
            </FormControl>

            <Tooltip label="Re-extract indicators from catchments">
              <IconButton
                aria-label="Refresh"
                icon={<FiRefreshCw />}
                variant="ghost"
                onClick={extractIndicators}
                isLoading={isLoading}
              />
            </Tooltip>

            <Tooltip label="Reset target state to ecological reference">
              <IconButton
                aria-label="Reset"
                icon={<FiAlertTriangle />}
                variant="ghost"
                colorScheme="orange"
                onClick={handleResetIdeal}
                isDisabled={isLoading}
              />
            </Tooltip>

            <Button
              leftIcon={<FiSave />}
              bg={colors.pastelLightGreen}
              size="sm"
              onClick={handleSaveChanges}
              isLoading={isSaving}
              isDisabled={!hasChanges}
              style={{width: "100%"}}
            >
              Save Changes
            </Button>
          </HStack>
        </Flex>

        {/* Summary Stats */}
        {summaryStats && (
          <HStack spacing={8} mt={4}>
            <Stat size="sm">
              <StatLabel color="gray.500">Total Indicators</StatLabel>
              <StatNumber color="white">{summaryStats.total}</StatNumber>
            </Stat>
            <Stat size="sm">
              <StatLabel color="gray.500">Above Ecological Reference</StatLabel>
              <StatNumber color="red.400">{summaryStats.improved}</StatNumber>
              <StatHelpText color="red.500">
                <ReferenceDeltaGlyph direction="right" color="red.400" /> above ecological reference
              </StatHelpText>
            </Stat>
            <Stat size="sm">
              <StatLabel color="gray.500">Below Ecological Reference</StatLabel>
              <StatNumber color="red.400">{summaryStats.degraded}</StatNumber>
              <StatHelpText color="red.500">
                <ReferenceDeltaGlyph direction="left" color="red.400" /> below ecological reference
              </StatHelpText>
            </Stat>
            <Stat size="sm">
              <StatLabel color="gray.500">At Ecological Reference</StatLabel>
              <StatNumber color="gray.400">{summaryStats.unchanged}</StatNumber>
            </Stat>
          </HStack>
        )}
      </Box>

      {/* Scrollable Table */}
      <Box h="calc(100% - 140px)" overflow="auto" px={6} py={4}>
        <Table variant="simple" size="sm">
          <Thead position="sticky" top={0} bg={tableBg} zIndex={5} style={{ background: "#171923", paddingBottom: "10px" }}>
            <Tr>
              <Th color="gray.400" borderColor="whiteAlpha.200" minW="250px">Indicator</Th>
              <Th color="gray.400" borderColor="whiteAlpha.200" isNumeric>Ecological Ecological Reference</Th>
              <Th color="gray.400" borderColor="whiteAlpha.200" isNumeric>Current State</Th>
              <Th color="gray.400" borderColor="whiteAlpha.200">Trend</Th>
              <Th color="gray.400" borderColor="whiteAlpha.200" isNumeric>Target State</Th>
              <Th color="gray.400" borderColor="whiteAlpha.200" w="100px">Edit</Th>
            </Tr>
          </Thead>
          <Tbody>
            <AnimatePresence>
              {groupedIndicatorRows.map(group => {
                const isCollapsed = collapsedGroups[group.groupName] ?? false;
                return (
                  <Fragment key={group.groupName}>
                    <Tr>
                      <Td
                        colSpan={6}
                        bg="whiteAlpha.50"
                        borderColor="whiteAlpha.200"
                        py={2}
                      >
                        <HStack spacing={2} align="center">
                          <IconButton
                            aria-label={isCollapsed ? 'Expand group' : 'Collapse group'}
                            icon={isCollapsed ? <FiChevronRight /> : <FiChevronDown />}
                            size="xs"
                            variant="ghost"
                            onClick={() =>
                              setCollapsedGroups(prev => ({
                                ...prev,
                                [group.groupName]: !isCollapsed,
                              }))
                            }
                          />
                          <Text color="gray.200" fontWeight="bold" fontSize="sm">
                            {group.groupName}
                          </Text>
                          <Text color="gray.500" fontSize="xs">
                            {group.rows.length}
                          </Text>
                        </HStack>
                      </Td>
                    </Tr>
                    {!isCollapsed && group.rows.map((row, index) => {
                    const trend = getTrend(row.current, row.reference);
                    const isEditing = editingKey === row.key;
                    const boundsSet = row.idealLower !== row.idealUpper;
                    const idealChanged = row.idealLower !== row.current || row.idealUpper !== row.current;

                    return (
                      <MotionTr
                        key={row.key}
                        initial={{ opacity: 0, y: 20 }}
                        animate={{ opacity: 1, y: 0 }}
                        transition={{ delay: index * 0.01 }}
                        _hover={{ bg: hoverBg }}
                      >
                        <Td borderColor="whiteAlpha.100">
                          <VStack align="start" spacing={0}>
                            <Text color="white" fontWeight="medium">{row.label}</Text>
                            <Text fontSize="xs" color="gray.500">{row.key}</Text>
                            {row.unit && <Text fontSize="xs" color="cyan.400">{row.unit}</Text>}
                          </VStack>
                        </Td>
                        <Td borderColor="whiteAlpha.100" isNumeric>
                          <Text color="orange.300" fontFamily="mono">{formatValue(row.reference)}</Text>
                        </Td>
                        <Td borderColor="whiteAlpha.100" isNumeric>
                          <Text color="cyan.300" fontFamily="mono">{formatValue(row.current)}</Text>
                        </Td>
                        <Td borderColor="whiteAlpha.100">
                          <HStack spacing={3}>
                            <ReferenceTrendLines
                              reference={row.reference}
                              current={row.current}
                              target={row.ideal}
                            />
                            <Text fontSize="xs" color="gray.500">
                              {trend === 'up' ? 'Above' : trend === 'down' ? 'Below' : 'Equal'}
                            </Text>
                          </HStack>
                        </Td>
                        <Td borderColor="whiteAlpha.100" isNumeric>
                          {isEditing ? (
                            <VStack spacing={1} align="stretch">
                              {editBoundsExpanded ? (
                                <>
                                  <HStack spacing={1} justify="flex-end">
                                    <Text fontSize="xs" color="gray.500" minW="10px">lo</Text>
                                    <NumberInput size="sm" value={editValue} onChange={(v) => setEditValue(v)} step={0.01} precision={2}>
                                      <NumberInputField
                                        bg="whiteAlpha.200"
                                        border="none"
                                        textAlign="right"
                                        w="130px"
                                        autoFocus
                                        onKeyDown={(e) => {
                                          if (e.key === 'Enter') handleConfirmEdit();
                                          if (e.key === 'Escape') handleCancelEdit();
                                        }}
                                      />
                                    </NumberInput>
                                  </HStack>
                                  <HStack spacing={1} justify="flex-end">
                                    <Text fontSize="xs" color="gray.500" minW="10px">hi</Text>
                                    <NumberInput size="sm" value={editUpperValue} onChange={(v) => setEditUpperValue(v)} step={0.01} precision={2}>
                                      <NumberInputField
                                        bg="whiteAlpha.200"
                                        border="none"
                                        textAlign="right"
                                        w="130px"
                                        onKeyDown={(e) => {
                                          if (e.key === 'Enter') handleConfirmEdit();
                                          if (e.key === 'Escape') handleCancelEdit();
                                        }}
                                      />
                                    </NumberInput>
                                  </HStack>
                                </>
                              ) : (
                                <HStack spacing={1} justify="flex-end">
                                  <NumberInput size="sm" value={editValue} onChange={(v) => { setEditValue(v); setEditUpperValue(v); }} step={0.01} precision={2}>
                                    <NumberInputField
                                      bg="whiteAlpha.200"
                                      border="none"
                                      textAlign="right"
                                      w="130px"
                                      autoFocus
                                      onKeyDown={(e) => {
                                        if (e.key === 'Enter') handleConfirmEdit();
                                        if (e.key === 'Escape') handleCancelEdit();
                                      }}
                                    />
                                  </NumberInput>
                                  <Tooltip label="Set separate lower/upper bounds">
                                    <IconButton
                                      aria-label="Expand bounds"
                                      icon={<FiChevronDown />}
                                      size="xs"
                                      variant="ghost"
                                      onClick={() => { setEditUpperValue(editValue); setEditBoundsExpanded(true); }}
                                    />
                                  </Tooltip>
                                </HStack>
                              )}
                            </VStack>
                          ) : (
                            <Text
                              color={idealChanged ? 'green.300' : 'gray.300'}
                              fontFamily="mono"
                              fontWeight={idealChanged ? 'bold' : 'normal'}
                            >
                              {boundsSet
                                ? `${formatValue(row.idealLower)} – ${formatValue(row.idealUpper)}`
                                : formatValue(row.idealLower)}
                            </Text>
                          )}
                        </Td>
                        <Td borderColor="whiteAlpha.100">
                          {isEditing ? (
                            <HStack spacing={1}>
                              <IconButton
                                aria-label="Confirm"
                                icon={<FiCheck />}
                                size="xs"
                                colorScheme="green"
                                onClick={handleConfirmEdit}
                              />
                              <IconButton
                                aria-label="Cancel"
                                icon={<FiX />}
                                size="xs"
                                variant="ghost"
                                onClick={handleCancelEdit}
                              />
                            </HStack>
                          ) : (
                            <IconButton
                              aria-label="Edit"
                              icon={<FiEdit2 />}
                              size="xs"
                              variant="ghost"
                              onClick={() => handleStartEdit(row.key, row.idealLower, row.idealUpper)}
                            />
                          )}
                        </Td>
                      </MotionTr>
                    );
                    })}
                  </Fragment>
                );
              })}
            </AnimatePresence>
          </Tbody>
        </Table>

          {totalIndicatorRows === 0 && searchFilter && (
          <Flex justify="center" py={10}>
            <Text color="gray.500">No indicators match "{searchFilter}"</Text>
          </Flex>
        )}
      </Box>
    </Box>
  );
}
