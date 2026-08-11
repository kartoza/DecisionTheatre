import { useMemo, useEffect, useState } from 'react';
import { Box, Table, Thead, Tbody, Tr, Th, Td, Text, HStack, VStack, Badge, Spinner, Button } from '@chakra-ui/react';
import { motion, AnimatePresence } from 'framer-motion';
import type { CatchmentIndicators, Scenario, SiteIndicators } from '../types';
import { getSiteCatchments, useAttributeDetails } from '../hooks/useApi';

interface AggregateTableProps {
  visible: boolean;
  attribute?: string;
  siteId?: string | null;
  scenario?: Scenario;
  siteGeometry?: GeoJSON.Geometry | null;
  // Site-level aggregate, used as a fallback "Site Average" when no
  // per-catchment breakdown is available (e.g. a site with too many
  // catchments to embed individually) — otherwise the average silently
  // shows as 0 instead of the real, already-computed site-wide value.
  siteIndicators?: SiteIndicators | null;
}

// Format numbers for display
function formatNumber(value: number, decimals = 2): string {
  if (Math.abs(value) >= 1000000) return (value / 1000000).toFixed(1) + 'M';
  if (Math.abs(value) >= 1000) return (value / 1000).toFixed(1) + 'K';
  if (Math.abs(value) < 0.001 && value !== 0) return value.toExponential(2);
  return value.toFixed(decimals);
}

function AggregateTable({
  visible,
  attribute = 'Factor',
  siteId,
  scenario = 'current',
  siteGeometry,
  siteIndicators,
}: AggregateTableProps) {
  const [catchments, setCatchments] = useState<CatchmentIndicators[]>([]);
  const [loading, setLoading] = useState(false);
  const [isTableVisible, setIsTableVisible] = useState(true);
  const { details: attributeDetails } = useAttributeDetails();

  const attributeLabel = attributeDetails[attribute] ?? attribute;

  // Show the table by default whenever the panel opens; reset when it closes.
  useEffect(() => {
    setIsTableVisible(visible);
  }, [visible]);

  // Fetch catchment data when panel is visible and siteId is available.
  useEffect(() => {
    if (!visible || !siteId) {
      return;
    }

    let cancelled = false;
    setLoading(true);

    getSiteCatchments(siteId)
      .then((data) => {
        if (!cancelled) {
          setCatchments(data || []);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setCatchments([]);
        }
      })
      .finally(() => {
        if (!cancelled) {
          setLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [visible, siteId, siteGeometry]);

  // Calculate all derived values from catchment data.
  // Step 1: For each catchment, compute how much of its area is inside the site.
  //         validArea = areaKm2 * aoiFraction (or 0 when aoiFraction is missing,
  //         matching the precomputed site.indicators convention of excluding
  //         catchments with no known AOI overlap from the weighted average).
  //         Also 0 when the attribute itself has no value for this catchment/
  //         scenario, so a missing reading isn't silently treated as a real 0.
  // Step 2: Sum validArea across all catchments to get totalArea.
  // Step 3: For each catchment, compute its share of the site.
  //         weight = validArea / totalArea
  // Step 4: Multiply each catchment value by its weight.
  //         weightedValue = weight * value
  // Step 5: Add all weighted values to get the site average.
  //         siteAverage = sum(weightedValue)
  // Site-level aggregate for the current scenario/attribute, used when there's
  // no per-catchment breakdown to compute from (e.g. a site with too many
  // catchments to embed individually, like a continent-scale demo).
  const fallbackAverage = useMemo(() => {
    if (!attribute || !siteIndicators) return undefined;
    const key = scenario === 'reference' ? 'reference' : scenario === 'future' ? 'ideal' : 'current';
    const value = siteIndicators[key as keyof Pick<SiteIndicators, 'reference' | 'current' | 'ideal'>]?.[attribute];
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
  }, [attribute, scenario, siteIndicators]);

  const calculations = useMemo(() => {
    if (!catchments || catchments.length === 0 || !attribute) {
      return { rows: [], totalArea: 0, siteAverage: fallbackAverage ?? 0, hasData: false };
    }

    // Build rows with calculated values
    const rows = catchments.map((c) => {
      const fractionCovered = c.aoiFraction ?? 0; // Unknown overlap contributes no weight
      const scenarioValues =
        scenario === 'reference' ? c.reference
        : scenario === 'future' ? (c.ideal ?? c.reference)
        : c.current;
      const rawValue = scenarioValues?.[attribute];
      const hasValue = typeof rawValue === 'number' && Number.isFinite(rawValue);
      // A catchment with no data for this attribute contributes no weight,
      // same as an unknown aoiFraction above — otherwise it silently defaults
      // to a value of 0 and drags the average down as if that were a real
      // reading, rather than being excluded like the live map stats already
      // exclude it (they only tally features with an actual numeric value).
      const validArea = hasValue ? c.areaKm2 * fractionCovered : 0;

      return {
        id: c.id,
        area: c.areaKm2,
        fractionCovered,
        value: hasValue ? rawValue : 0,
        hasValue,
        validArea,
      };
    });

    const totalArea = rows.reduce((sum, r) => sum + r.validArea, 0);

    const rowsWithWeights = rows.map((r) => ({
      ...r,
      weight: totalArea > 0 ? r.validArea / totalArea : 0,
      weightedValue: totalArea > 0 ? (r.validArea / totalArea) * r.value : 0,
    }));

    const siteAverage = rowsWithWeights.reduce((sum, r) => sum + r.weightedValue, 0);

    return {
      rows: rowsWithWeights,
      totalArea,
      siteAverage,
      hasData: true,
    };
  }, [catchments, attribute, scenario]);

  return (
    <Box
      position="absolute"
      top={0}
      left={0}
      right={0}
      bottom={0}
      overflow="hidden"
      bg={visible ? "#1a202c" : "transparent"}
      pointerEvents={visible ? "auto" : "none"}
      opacity={visible ? 1 : 0}
      transition="opacity 0.3s ease, background 0.3s ease"
    >
      <AnimatePresence>
        {visible && (
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -20 }}
            transition={{ duration: 0.4, ease: [0.16, 1, 0.3, 1] }}
            style={{ width: '100%', height: '100%', display: 'flex', flexDirection: 'column', overflowY: 'auto', overflowX: 'hidden' }}
          >
            {/* Header + summary cards — scrolls together with the table below. */}
            <Box px={6} pt={6} pb={4} flexShrink={0}>
              {/* Header */}
              <VStack spacing={4} align="stretch" mb={6}>
                <HStack justify="space-between" align="center">
                  <VStack align="start" spacing={1}>
                    <Text fontSize="2xl" fontWeight="bold" color="white">
                      Site Aggregate Calculation
                    </Text>
                    <Text fontSize="md" color="gray.400">
                      Area-weighted average for selected factor
                    </Text>
                  </VStack>
                  <HStack spacing={3}>
                    <Badge
                      colorScheme={scenario === 'reference' ? 'orange' : scenario === 'future' ? 'green' : 'cyan'}
                      fontSize="md"
                      px={4}
                      py={2}
                      borderRadius="full"
                    >
                      {scenario === 'reference' ? 'Reference' : scenario === 'future' ? 'Target' : 'Current'}
                    </Badge>
                    <Button
                      size="sm"
                      colorScheme="cyan"
                      variant={isTableVisible ? 'outline' : 'solid'}
                      onClick={() => setIsTableVisible((prev) => !prev)}
                    >
                      {isTableVisible ? 'Hide Table' : 'Show Table'}
                    </Button>
                  </HStack>
                </HStack>

                {/* Factor being calculated */}
                <Box
                  bg="whiteAlpha.100"
                  borderRadius="lg"
                  p={4}
                  border="1px solid"
                  borderColor="whiteAlpha.200"
                >
                  <HStack justify="space-between">
                    <Text color="gray.400" fontSize="sm" fontWeight="600" textTransform="uppercase">
                      Selected Factor
                    </Text>
                    <Text color="cyan.300" fontSize="lg" fontWeight="bold">
                      {attributeLabel}
                    </Text>
                  </HStack>
                </Box>
              </VStack>

              {/* Summary cards */}
              <HStack spacing={4} justify="center">
                {/* Total Area */}
                <Box
                  bg="whiteAlpha.100"
                  borderRadius="xl"
                  p={6}
                  border="1px solid"
                  borderColor="whiteAlpha.200"
                  flex={1}
                  maxW="300px"
                >
                  <VStack spacing={2}>
                    <Text color="gray.400" fontSize="sm" fontWeight="600" textTransform="uppercase">
                      Total Valid Area
                    </Text>
                    <Text color="white" fontSize="3xl" fontWeight="bold">
                      {formatNumber(calculations.hasData ? calculations.totalArea : (siteIndicators?.totalAreaKm2 ?? 0), 1)}
                    </Text>
                    <Text color="gray.500" fontSize="sm">
                      km²
                    </Text>
                  </VStack>
                </Box>

                {/* Site Average - Highlighted */}
                <Box
                  bg="linear-gradient(135deg, rgba(0, 188, 212, 0.2), rgba(156, 39, 176, 0.2))"
                  borderRadius="xl"
                  p={6}
                  border="2px solid"
                  borderColor="cyan.400"
                  flex={1}
                  maxW="400px"
                  boxShadow="0 0 30px rgba(0, 188, 212, 0.3)"
                >
                  <VStack spacing={2}>
                    <Text color="cyan.300" fontSize="sm" fontWeight="700" textTransform="uppercase" letterSpacing="wider">
                      Site Average
                    </Text>
                    <Text
                      color="white"
                      fontSize="5xl"
                      fontWeight="bold"
                      textShadow="0 0 20px rgba(0, 188, 212, 0.5)"
                    >
                      {formatNumber(calculations.siteAverage, 3)}
                    </Text>
                    <Text color="gray.400" fontSize="sm">
                      {attributeLabel}
                    </Text>
                  </VStack>
                </Box>

                {/* Catchment Count */}
                <Box
                  bg="whiteAlpha.100"
                  borderRadius="xl"
                  p={6}
                  border="1px solid"
                  borderColor="whiteAlpha.200"
                  flex={1}
                  maxW="300px"
                >
                  <VStack spacing={2}>
                    <Text color="gray.400" fontSize="sm" fontWeight="600" textTransform="uppercase">
                      Catchments
                    </Text>
                    <Text color="white" fontSize="3xl" fontWeight="bold">
                      {calculations.hasData ? calculations.rows.length : (siteIndicators?.catchmentCount ?? 0)}
                    </Text>
                    <Text color="gray.500" fontSize="sm">
                      in site boundary
                    </Text>
                  </VStack>
                </Box>
              </HStack>
            </Box>

            {/* Table section — height comes from content; the outer pane scrolls, not this box. */}
            <Box px={6} pb={6}>
              {!isTableVisible ? (
                <Box
                  bg="whiteAlpha.50"
                  borderRadius="xl"
                  border="1px solid"
                  borderColor="whiteAlpha.200"
                  p={10}
                  textAlign="center"
                >
                  <Text color="gray.400" fontSize="lg" mb={2}>
                    Aggregate table hidden
                  </Text>
                  <Text color="gray.500" fontSize="sm">
                    Use the Show Table button to view the full calculation breakdown
                  </Text>
                </Box>
              ) : loading ? (
                <Box
                  bg="whiteAlpha.50"
                  borderRadius="xl"
                  border="1px solid"
                  borderColor="whiteAlpha.200"
                  p={12}
                  textAlign="center"
                >
                  <VStack spacing={4}>
                    <Spinner size="xl" color="cyan.400" thickness="4px" />
                    <Text color="gray.400" fontSize="lg">
                      Loading catchment data...
                    </Text>
                  </VStack>
                </Box>
              ) : !calculations.hasData ? (
                <Box
                  bg="whiteAlpha.50"
                  borderRadius="xl"
                  border="1px solid"
                  borderColor="whiteAlpha.200"
                  p={12}
                  textAlign="center"
                >
                  <Text color="gray.400" fontSize="lg" mb={2}>
                    {fallbackAverage !== undefined ? 'Per-catchment breakdown not available' : 'No catchment data available'}
                  </Text>
                  <Text color="gray.500" fontSize="sm">
                    {fallbackAverage !== undefined
                      ? 'This site has too many catchments to list individually — the Site Average above is the site-wide aggregate.'
                      : 'Create a site with catchments to see the aggregate calculation breakdown'}
                  </Text>
                </Box>
              ) : (
                <>
                  {/* Main calculation table */}
                  <Box
                    bg="whiteAlpha.50"
                    borderRadius="xl"
                    border="1px solid"
                    borderColor="whiteAlpha.200"
                    overflow="hidden"
                    mb={6}
                  >
                    <Table variant="simple" size="sm">
                      <Thead>
                        <Tr bg="whiteAlpha.100">
                          <Th color="gray.300" borderColor="whiteAlpha.200" py={4}>Catchment ID</Th>
                          <Th color="gray.300" borderColor="whiteAlpha.200" isNumeric>Area (km²)</Th>
                          <Th color="gray.300" borderColor="whiteAlpha.200" isNumeric>Fraction Covered</Th>
                          <Th color="gray.300" borderColor="whiteAlpha.200" isNumeric>{attributeLabel}</Th>
                          <Th color="gray.300" borderColor="whiteAlpha.200" isNumeric>Valid Area</Th>
                          <Th color="gray.300" borderColor="whiteAlpha.200" isNumeric>Weight</Th>
                          <Th color="cyan.300" borderColor="whiteAlpha.200" isNumeric>Weighted Value</Th>
                        </Tr>
                      </Thead>
                      <Tbody>
                        {calculations.rows.map((row, idx) => (
                          <motion.tr
                            key={row.id}
                            initial={{ opacity: 0, x: -20 }}
                            animate={{ opacity: 1, x: 0 }}
                            transition={{ delay: idx * 0.05, duration: 0.3 }}
                            style={{ background: idx % 2 === 0 ? 'rgba(255,255,255,0.02)' : 'transparent' }}
                          >
                            <Td color="white" borderColor="whiteAlpha.100" fontWeight="600">
                              {row.id}
                            </Td>
                            <Td color="gray.300" borderColor="whiteAlpha.100" isNumeric>
                              {formatNumber(row.area, 1)}
                            </Td>
                            <Td color="gray.300" borderColor="whiteAlpha.100" isNumeric>
                              <HStack justify="flex-end" spacing={2}>
                                <Box
                                  w={`${row.fractionCovered * 40}px`}
                                  h="8px"
                                  bg="purple.400"
                                  borderRadius="full"
                                  opacity={0.7}
                                />
                                <Text>{(row.fractionCovered * 100).toFixed(0)}%</Text>
                              </HStack>
                            </Td>
                            <Td color={row.hasValue ? 'orange.300' : 'gray.500'} borderColor="whiteAlpha.100" isNumeric fontWeight="500">
                              {row.hasValue ? formatNumber(row.value, 3) : 'N/A'}
                            </Td>
                            <Td color="gray.300" borderColor="whiteAlpha.100" isNumeric>
                              {formatNumber(row.validArea, 1)}
                            </Td>
                            <Td color="gray.300" borderColor="whiteAlpha.100" isNumeric>
                              <HStack justify="flex-end" spacing={2}>
                                <Box
                                  w={`${row.weight * 60}px`}
                                  h="8px"
                                  bg="cyan.400"
                                  borderRadius="full"
                                  opacity={0.7}
                                />
                                <Text>{(row.weight * 100).toFixed(1)}%</Text>
                              </HStack>
                            </Td>
                            <Td color={row.hasValue ? 'cyan.300' : 'gray.500'} borderColor="whiteAlpha.100" isNumeric fontWeight="600">
                              {row.hasValue ? formatNumber(row.weightedValue, 4) : 'N/A'}
                            </Td>
                          </motion.tr>
                        ))}
                      </Tbody>
                    </Table>
                  </Box>

                  {/* Formula explanation */}
                  <Box
                    p={4}
                    bg="whiteAlpha.50"
                    borderRadius="lg"
                    border="1px solid"
                    borderColor="whiteAlpha.100"
                  >
                    <VStack align="stretch" spacing={1}>
                      <Text color="gray.500" fontSize="xs" textAlign="center">
                        <Text as="span" color="gray.400" fontWeight="600">Formula: </Text>
                        Site Average = Sum of (Weight × Factor Value) where Weight = Valid Area / Total Valid Area
                      </Text>
                      <Text color="gray.500" fontSize="xs" textAlign="left">
                        Calculate all derived values from catchment data.
                      </Text>
                      <Text color="gray.500" fontSize="xs" textAlign="left">
                        Step 1: For each catchment, compute how much of its area is inside the site.
                      </Text>
                      <Text color="gray.500" fontSize="xs" textAlign="left">
                        validArea = areaKm2 * aoiFraction (0 when aoiFraction or the factor value is missing)
                      </Text>
                      <Text color="gray.500" fontSize="xs" textAlign="left">
                        Step 2: Sum validArea across all catchments to get totalArea.
                      </Text>
                      <Text color="gray.500" fontSize="xs" textAlign="left">
                        Step 3: For each catchment, compute its share of the site.
                      </Text>
                      <Text color="gray.500" fontSize="xs" textAlign="left">
                        weight = validArea / totalArea
                      </Text>
                      <Text color="gray.500" fontSize="xs" textAlign="left">
                        Step 4: Multiply each catchment value by its weight.
                      </Text>
                      <Text color="gray.500" fontSize="xs" textAlign="left">
                        weightedValue = weight * value
                      </Text>
                      <Text color="gray.500" fontSize="xs" textAlign="left">
                        Step 5: Add all weighted values to get the site average.
                      </Text>
                      <Text color="gray.500" fontSize="xs" textAlign="left">
                        siteAverage = sum(weightedValue)
                      </Text>
                    </VStack>
                  </Box>
                </>
              )}
            </Box>
          </motion.div>
        )}
      </AnimatePresence>
    </Box>
  );
}

export default AggregateTable;
