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
  Progress,
  Spinner,
  Stat,
  StatHelpText,
  StatLabel,
  StatNumber,
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
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  FiArrowLeft,
  FiRefreshCw,
  FiSave,
  FiAlertTriangle,
  FiBarChart2,
  FiEdit2,
  FiCheck,
  FiX,
  FiTrendingUp,
  FiTrendingDown,
  FiMinus,
} from 'react-icons/fi';
import type { Site, SiteIndicators, AppPage } from '../types';
import { getAppRuntime } from '../types/runtime';

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

// Calculate trend indicator
function getTrend(current: number, reference: number): 'up' | 'down' | 'neutral' {
  const threshold = 0.05; // 5% change threshold
  const change = (current - reference) / Math.abs(reference || 1);
  if (change > threshold) return 'up';
  if (change < -threshold) return 'down';
  return 'neutral';
}

export default function IndicatorEditorPage({ site, onNavigate, onSiteUpdated }: IndicatorEditorPageProps) {
  const [isLoading, setIsLoading] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [editingKey, setEditingKey] = useState<string | null>(null);
  const [editValue, setEditValue] = useState<string>('');
  const [localIndicators, setLocalIndicators] = useState<SiteIndicators | null>(site.indicators || null);
  const [hasChanges, setHasChanges] = useState(false);
  const [searchFilter, setSearchFilter] = useState('');
  const toast = useToast();

  const headerBg = useColorModeValue('gray.900', 'gray.900');
  const tableBg = useColorModeValue('gray.850', 'gray.850');
  const hoverBg = useColorModeValue('whiteAlpha.100', 'whiteAlpha.100');

  // Extract indicators on mount if not already present
  useEffect(() => {
    if (!site.indicators && site.catchmentIds && site.catchmentIds.length > 0) {
      extractIndicators();
    }
  }, [site.id]);

  const extractIndicators = useCallback(async () => {
    setIsLoading(true);
    const runtime = getAppRuntime();
    var jsonData = {}
    if (runtime === 'browser') {
        // Get site data from localStorage
        let siteData = {};
        try {
          const raw = window.localStorage.getItem('dt-sites');
          if (raw) {
            const sites = JSON.parse(raw);
            const currentSite = Array.isArray(sites) ? sites.find(s => s.id === site.id) : null;
            if (currentSite) {
              // Exclude thumbnail from the request payload
              const { thumbnail, ...siteWithoutThumbnail } = currentSite;
              siteData = siteWithoutThumbnail;
            }
          }
        } catch (error) {
          console.warn('Failed to read site from localStorage:', error);
        }
        jsonData = {
          "runtime": "browser",
          "site": siteData
        }
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
        const updatedSite: Site = await response.json();
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
          body: JSON.stringify({ ideal: localIndicators.ideal }),
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

  const handleStartEdit = useCallback((key: string, currentValue: number) => {
    setEditingKey(key);
    setEditValue(currentValue.toString());
  }, []);

  const handleCancelEdit = useCallback(() => {
    setEditingKey(null);
    setEditValue('');
  }, []);

  const handleConfirmEdit = useCallback(() => {
    if (!editingKey || !localIndicators) return;

    const newValue = parseFloat(editValue);
    if (isNaN(newValue)) {
      toast({ title: 'Invalid value', status: 'error', duration: 2000 });
      return;
    }

    setLocalIndicators(prev => {
      if (!prev) return prev;
      return {
        ...prev,
        ideal: {
          ...prev.ideal,
          [editingKey]: newValue,
        },
      };
    });
    setHasChanges(true);
    setEditingKey(null);
    setEditValue('');
  }, [editingKey, editValue, localIndicators, toast]);

  // Build indicator rows from data
  const indicatorRows: IndicatorRow[] = useMemo(() => {
    if (!localIndicators) return [];

    const allKeys = new Set<string>();
    Object.keys(localIndicators.reference || {}).forEach(k => allKeys.add(k));
    Object.keys(localIndicators.current || {}).forEach(k => allKeys.add(k));
    Object.keys(localIndicators.ideal || {}).forEach(k => allKeys.add(k));

    return Array.from(allKeys)
      .filter(key => {
        if (!searchFilter) return true;
        const label = getIndicatorLabel(key).toLowerCase();
        return label.includes(searchFilter.toLowerCase()) || key.toLowerCase().includes(searchFilter.toLowerCase());
      })
      .sort()
      .map(key => ({
        key,
        label: getIndicatorLabel(key),
        reference: localIndicators.reference?.[key] ?? 0,
        current: localIndicators.current?.[key] ?? 0,
        ideal: localIndicators.ideal?.[key] ?? localIndicators.current?.[key] ?? 0,
        unit: getIndicatorUnit(key),
      }));
  }, [localIndicators, searchFilter]);

  // Calculate summary statistics
  const summaryStats = useMemo(() => {
    if (!localIndicators) return null;

    const keys = Object.keys(localIndicators.current || {});
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
  }, [localIndicators]);

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
              colorScheme="cyan"
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
              <StatLabel color="gray.500">Improved</StatLabel>
              <StatNumber color="green.400">{summaryStats.improved}</StatNumber>
              <StatHelpText color="green.500">
                <FiTrendingUp style={{ display: 'inline' }} /> vs reference
              </StatHelpText>
            </Stat>
            <Stat size="sm">
              <StatLabel color="gray.500">Degraded</StatLabel>
              <StatNumber color="red.400">{summaryStats.degraded}</StatNumber>
              <StatHelpText color="red.500">
                <FiTrendingDown style={{ display: 'inline' }} /> vs reference
              </StatHelpText>
            </Stat>
            <Stat size="sm">
              <StatLabel color="gray.500">Unchanged</StatLabel>
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
              <Th color="gray.400" borderColor="whiteAlpha.200" isNumeric>Ecological Reference</Th>
              <Th color="gray.400" borderColor="whiteAlpha.200" isNumeric>Current State</Th>
              <Th color="gray.400" borderColor="whiteAlpha.200">Trend</Th>
              <Th color="gray.400" borderColor="whiteAlpha.200" isNumeric>Target State</Th>
              <Th color="gray.400" borderColor="whiteAlpha.200" w="100px">Edit</Th>
            </Tr>
          </Thead>
          <Tbody>
            <AnimatePresence>
              {indicatorRows.map((row, index) => {
                const trend = getTrend(row.current, row.reference);
                const isEditing = editingKey === row.key;
                const idealChanged = row.ideal !== row.current;

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
                      <HStack>
                        {trend === 'up' && <Icon as={FiTrendingUp} color="green.400" />}
                        {trend === 'down' && <Icon as={FiTrendingDown} color="red.400" />}
                        {trend === 'neutral' && <Icon as={FiMinus} color="gray.500" />}
                        <Progress
                          value={Math.abs(((row.current - row.reference) / (row.reference || 1)) * 100)}
                          max={100}
                          size="xs"
                          w="60px"
                          colorScheme={trend === 'up' ? 'green' : trend === 'down' ? 'red' : 'gray'}
                          bg="whiteAlpha.200"
                          borderRadius="full"
                        />
                      </HStack>
                    </Td>
                    <Td borderColor="whiteAlpha.100" isNumeric>
                      {isEditing ? (
                        <NumberInput
                          size="sm"
                          value={editValue}
                          onChange={(v) => setEditValue(v)}
                          min={0}
                          step={0.01}
                        >
                          <NumberInputField
                            bg="whiteAlpha.200"
                            border="none"
                            textAlign="right"
                            autoFocus
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') handleConfirmEdit();
                              if (e.key === 'Escape') handleCancelEdit();
                            }}
                          />
                        </NumberInput>
                      ) : (
                        <Text
                          color={idealChanged ? 'green.300' : 'gray.300'}
                          fontFamily="mono"
                          fontWeight={idealChanged ? 'bold' : 'normal'}
                        >
                          {formatValue(row.ideal)}
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
                          onClick={() => handleStartEdit(row.key, row.ideal)}
                        />
                      )}
                    </Td>
                  </MotionTr>
                );
              })}
            </AnimatePresence>
          </Tbody>
        </Table>

        {indicatorRows.length === 0 && searchFilter && (
          <Flex justify="center" py={10}>
            <Text color="gray.500">No indicators match "{searchFilter}"</Text>
          </Flex>
        )}
      </Box>
    </Box>
  );
}
