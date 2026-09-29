/**
 * How a factor's target was arrived at.
 *
 * This was a modal opened from each pane's info button. It is now a view of the
 * chart details side panel, reached from "Show calculations" there, because a
 * calculation you want to check against the chart is not something to read with
 * the chart covered up.
 *
 * Everything it needs is passed in: it reads no context and holds no state, so
 * the panel can render it for whichever pane asked.
 */
import {
  Box, Divider, HStack, Table, Tbody, Td, Text, Th, Thead, Tr, VStack,
} from '@chakra-ui/react';
import type { SiteIndicators } from '../types';
import { COLUMN_FORMULAS, getTriggeredWorkflows } from '../constants/calculationFormulas';

/** Value formatting for this view, matching what the modal used. */
function fv(n: number): string {
  if (!Number.isFinite(n)) return '—';
  if (Math.abs(n) >= 1_000_000) return (n / 1_000_000).toFixed(2) + 'M';
  if (Math.abs(n) >= 1_000) return (n / 1_000).toFixed(2) + 'K';
  if (Math.abs(n) < 0.01 && n !== 0) return n.toFixed(6);
  if (Math.abs(n) < 10) return n.toFixed(3);
  return n.toFixed(1);
}

export interface CalculationDetailsProps {
  attribute: string;
  siteIndicators?: SiteIndicators | null;
  attributeDetails: Record<string, string>;
  /** Target inputs the user has actually changed, with what they moved from. */
  changedInputs: { key: string; ref: number; ideal: number; delta: number }[];
}

function CalculationDetails({
  attribute,
  siteIndicators,
  attributeDetails,
  changedInputs,
}: CalculationDetailsProps) {
  // The extracted body referred to `comparison.attribute`; it is a prop here.
  const comparison = { attribute };
  const triggeredWorkflows = getTriggeredWorkflows(changedInputs.map((x) => x.key));
  return (
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
  );
}

export default CalculationDetails;
