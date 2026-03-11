import { useMemo } from 'react';
import { Box, Table, Thead, Tbody, Tr, Th, Td, Text, HStack, VStack, Badge } from '@chakra-ui/react';
import { motion, AnimatePresence } from 'framer-motion';

interface CatchmentData {
  id: string | number;
  area: number;
  fractionCovered: number;
  value: number;
}

interface AggregateTableProps {
  visible: boolean;
  attribute?: string;
  catchments?: CatchmentData[];
  scenario?: string;
}

// Format numbers for display
function formatNumber(value: number, decimals = 2): string {
  if (Math.abs(value) >= 1000000) return (value / 1000000).toFixed(1) + 'M';
  if (Math.abs(value) >= 1000) return (value / 1000).toFixed(1) + 'K';
  if (Math.abs(value) < 0.001 && value !== 0) return value.toExponential(2);
  return value.toFixed(decimals);
}

// Demo data when no real data is available
function generateDemoData(): CatchmentData[] {
  return [
    { id: 1, area: 100, fractionCovered: 1.0, value: 0.10 },
    { id: 2, area: 200, fractionCovered: 0.5, value: 0.30 },
    { id: 3, area: 250, fractionCovered: 0.4, value: 0.20 },
    { id: 4, area: 300, fractionCovered: 0.3, value: 0.40 },
    { id: 5, area: 400, fractionCovered: 0.9, value: 0.80 },
  ];
}

function AggregateTable({
  visible,
  attribute = 'Factor',
  catchments,
  scenario = 'Current',
}: AggregateTableProps) {
  // Use demo data if no catchments provided
  const data = catchments && catchments.length > 0 ? catchments : generateDemoData();

  // Calculate all derived values
  const calculations = useMemo(() => {
    const rows = data.map((c) => {
      const validArea = c.area * c.fractionCovered;
      return {
        ...c,
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
    };
  }, [data]);

  return (
    <Box
      position="absolute"
      top={0}
      left={0}
      right={0}
      bottom={0}
      overflow="hidden"
      bg="#1a202c"
    >
      <AnimatePresence>
        {visible && (
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -20 }}
            transition={{ duration: 0.4, ease: [0.16, 1, 0.3, 1] }}
            style={{ width: '100%', height: '100%', padding: '24px', overflow: 'auto' }}
          >
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
                <Badge
                  colorScheme="cyan"
                  fontSize="md"
                  px={4}
                  py={2}
                  borderRadius="full"
                >
                  {scenario}
                </Badge>
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
                    {attribute}
                  </Text>
                </HStack>
              </Box>
            </VStack>

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
                    <Th color="gray.300" borderColor="whiteAlpha.200" isNumeric>Area (ha)</Th>
                    <Th color="gray.300" borderColor="whiteAlpha.200" isNumeric>Fraction Covered</Th>
                    <Th color="gray.300" borderColor="whiteAlpha.200" isNumeric>{attribute}</Th>
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
                      <Td color="orange.300" borderColor="whiteAlpha.100" isNumeric fontWeight="500">
                        {formatNumber(row.value, 3)}
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
                      <Td color="cyan.300" borderColor="whiteAlpha.100" isNumeric fontWeight="600">
                        {formatNumber(row.weightedValue, 4)}
                      </Td>
                    </motion.tr>
                  ))}
                </Tbody>
              </Table>
            </Box>

            {/* Summary section */}
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
                    {formatNumber(calculations.totalArea, 1)}
                  </Text>
                  <Text color="gray.500" fontSize="sm">
                    hectares
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
                    {attribute}
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
                    {calculations.rows.length}
                  </Text>
                  <Text color="gray.500" fontSize="sm">
                    in site boundary
                  </Text>
                </VStack>
              </Box>
            </HStack>

            {/* Formula explanation */}
            <Box
              mt={6}
              p={4}
              bg="whiteAlpha.50"
              borderRadius="lg"
              border="1px solid"
              borderColor="whiteAlpha.100"
            >
              <Text color="gray.500" fontSize="xs" textAlign="center">
                <Text as="span" color="gray.400" fontWeight="600">Formula: </Text>
                Site Average = Sum of (Weight × Factor Value) where Weight = Valid Area / Total Valid Area
              </Text>
            </Box>
          </motion.div>
        )}
      </AnimatePresence>
    </Box>
  );
}

export default AggregateTable;
