/**
 * Where the numbers on a dial came from.
 *
 * A dial's scale is the product of half a dozen steps — a range per mode, a
 * metadata cap, a widening to fit the plotted values, a balance cap, an
 * optional hold — and by the time it reaches the screen it is two numbers with
 * no account of itself. That is fine until someone asks why a marker sits where
 * it does, at which point the only way to answer has been to read the code and
 * work out which branch ran.
 *
 * This panel answers it from the screen instead. It shows every candidate range
 * rather than only the one in use, so "why is Site wider than Extent" is a
 * question you can look at; and it names the source of each value, because the
 * dial does not use one — in Site mode current is an AOI-weighted catchment
 * mean while reference and target are site-level indicators, and those can
 * disagree.
 *
 * Anything not loaded is reported as not loaded. A diagnostic that fills in a
 * plausible number is worse than one that admits it does not know.
 */
import { Box, Button, HStack, IconButton, Slide, VStack } from '@chakra-ui/react';
import { FiArrowLeft, FiChevronRight } from 'react-icons/fi';
import { useEffect, useState } from 'react';
import { SCENARIO_COLORS, formatValue } from '../lib/dialScale';
import type { ScaleDerivation } from '../lib/dialScale';
import CalculationDetails from './CalculationDetails';
import type { CalculationDetailsProps } from './CalculationDetails';

const STRINGS = {
  heading: 'Chart details',
  close: 'Close chart details',
  nothing: 'Select a factor on this pane to see how its scale is derived.',
  ranges: 'Candidate ranges',
  domain: 'Full (dataset)',
  extent: 'Extent (visible map)',
  site: 'Site (catchments)',
  caps: 'Metadata caps',
  capMin: 'Target_min',
  capMax: 'Target_max',
  steps: 'How the scale was reached',
  beforeCap: 'Active mode range',
  afterCap: 'After metadata cap',
  afterValues: 'After fitting the values',
  held: 'Held by scale lock',
  final: 'Drawn against',
  values: 'Values',
  reference: 'Reference',
  current: 'Current',
  target: 'Target',
  active: 'in use',
  notLoaded: 'not loaded',
  none: 'none declared',
  zeroCentred: 'Scale centred on zero (dial_0_middle)',
  showCalculations: 'Show calculations',
  backToScale: 'Back to scale',
  calculationsHeading: 'Calculations',
  noCalculations: 'No calculations to show for this factor.',
  fellBack: 'Values fell back to the site indicators — the active range mode had none.',
} as const;

function Range({ range }: { range: { min: number; max: number } | null }) {
  if (!range) return <Box as="span" color="gray.600" fontStyle="italic">{STRINGS.notLoaded}</Box>;
  return (
    <Box as="span" fontFamily="mono">
      {formatValue(range.min)} … {formatValue(range.max)}
    </Box>
  );
}

function Row({
  label,
  children,
  highlight = false,
}: {
  label: string;
  children: React.ReactNode;
  highlight?: boolean;
}) {
  return (
    <HStack
      justify="space-between"
      align="baseline"
      spacing={3}
      px={2}
      py={1.5}
      borderRadius="md"
      bg={highlight ? 'whiteAlpha.100' : undefined}
    >
      <Box fontSize="xs" color={highlight ? 'gray.100' : 'gray.400'} fontWeight={highlight ? 600 : 400}>
        {label}
      </Box>
      <Box fontSize="xs" color="gray.100" textAlign="right">{children}</Box>
    </HStack>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <Box>
      <Box
        fontSize="2xs"
        letterSpacing="wider"
        textTransform="uppercase"
        color="gray.500"
        fontWeight={700}
        px={2}
        pb={1}
      >
        {title}
      </Box>
      <VStack spacing={0} align="stretch">{children}</VStack>
    </Box>
  );
}

export interface ChartDetailsPanelProps {
  isOpen: boolean;
  onClose: () => void;
  derivation: ScaleDerivation | null;
  /** The target arithmetic, shown behind "Show calculations". */
  calculations: CalculationDetailsProps | null;
}

function ChartDetailsPanel({ isOpen, onClose, derivation, calculations }: ChartDetailsPanelProps) {
  // Two views, one panel. The scale is what you meet; the calculations are a
  // step further in, and replace the content rather than opening a second
  // surface over the chart they describe.
  const [view, setView] = useState<'scale' | 'calculations'>('scale');
  // A new chart starts at the scale again — the calculations you were reading
  // were about the old one.
  useEffect(() => { setView('scale'); }, [derivation?.attribute]);
  // The header is content-sized rather than a fixed height, so it is measured —
  // the same reason the target editor measures it.
  const [headerOffset, setHeaderOffset] = useState(0);
  useEffect(() => {
    const header = document.querySelector('header');
    if (!header) return;
    const apply = () => setHeaderOffset(header.getBoundingClientRect().height);
    apply();
    const observer = new ResizeObserver(apply);
    observer.observe(header);
    return () => observer.disconnect();
  }, []);

  const modeRows: { key: 'domain' | 'extent' | 'site'; label: string }[] = [
    { key: 'domain', label: STRINGS.domain },
    { key: 'extent', label: STRINGS.extent },
    { key: 'site', label: STRINGS.site },
  ];

  return (
    <Slide
      direction="right"
      in={isOpen}
      style={{
        zIndex: 15,
        position: 'fixed',
        top: headerOffset,
        right: 0,
        height: `calc(100% - ${headerOffset}px)`,
        width: 'auto',
      }}
    >
      <Box
        id="tour-chart-details-panel"
        role="region"
        aria-label={STRINGS.heading}
        w={{ base: '100vw', md: '440px' }}
        h="100%"
        bg="gray.800"
        color="white"
        borderLeft="1px"
        borderColor="whiteAlpha.200"
        boxShadow="-4px 0 24px rgba(0,0,0,0.35)"
        display="flex"
        flexDirection="column"
      >
        <HStack px={4} pt={3} pb={2} align="center" spacing={2}>
          {view === 'calculations' && (
            <IconButton
              aria-label={STRINGS.backToScale}
              icon={<FiArrowLeft />}
              size="sm"
              variant="ghost"
              onClick={() => setView('scale')}
            />
          )}
          <Box fontSize="md" fontWeight="bold" flex="1">
            {view === 'calculations' ? STRINGS.calculationsHeading : STRINGS.heading}
          </Box>
          <IconButton
            aria-label={STRINGS.close}
            icon={<FiChevronRight />}
            size="sm"
            variant="ghost"
            onClick={onClose}
          />
        </HStack>

        {view === 'calculations' ? (
          <Box px={4} pb={4} flex="1" overflowY="auto">
            {calculations ? (
              <CalculationDetails {...calculations} />
            ) : (
              <Box fontSize="sm" color="gray.400">{STRINGS.noCalculations}</Box>
            )}
          </Box>
        ) : !derivation ? (
          <Box px={4} py={3} fontSize="sm" color="gray.400">{STRINGS.nothing}</Box>
        ) : (
          <Box px={2} pb={4} flex="1" overflowY="auto">
            <Box px={2} pb={3}>
              <Box fontSize="sm" fontWeight={600} color="gray.100">{derivation.attribute}</Box>
              {derivation.unit && (
                <Box fontSize="xs" color="gray.500">{derivation.unit}</Box>
              )}
            </Box>

            <VStack spacing={4} align="stretch">
              <Section title={STRINGS.ranges}>
                {modeRows.map(({ key, label }) => (
                  <Row
                    key={key}
                    label={label + (derivation.activeMode === key ? ` — ${STRINGS.active}` : '')}
                    highlight={derivation.activeMode === key}
                  >
                    <Range range={derivation.candidates[key]} />
                  </Row>
                ))}
              </Section>

              <Section title={STRINGS.caps}>
                <Row label={STRINGS.capMin}>
                  {derivation.cap?.min != null
                    ? <Box as="span" fontFamily="mono">{formatValue(derivation.cap.min)}</Box>
                    : <Box as="span" color="gray.600" fontStyle="italic">{STRINGS.none}</Box>}
                </Row>
                <Row label={STRINGS.capMax}>
                  {derivation.cap?.max != null
                    ? <Box as="span" fontFamily="mono">{formatValue(derivation.cap.max)}</Box>
                    : <Box as="span" color="gray.600" fontStyle="italic">{STRINGS.none}</Box>}
                </Row>
              </Section>

              <Section title={STRINGS.steps}>
                <Row label={STRINGS.beforeCap}><Range range={derivation.beforeCap} /></Row>
                <Row label={STRINGS.afterCap}><Range range={derivation.afterCap} /></Row>
                <Row label={STRINGS.afterValues}><Range range={derivation.afterValues} /></Row>
                {derivation.held && (
                  <Row label={STRINGS.held}><Range range={derivation.held} /></Row>
                )}
                <Row label={STRINGS.final} highlight><Range range={derivation.final} /></Row>
                {derivation.zeroCentred && (
                  <Box px={2} pt={1} fontSize="2xs" color="gray.500">{STRINGS.zeroCentred}</Box>
                )}
              </Section>

              <Section title={STRINGS.values}>
                {([
                  ['reference', STRINGS.reference, SCENARIO_COLORS.reference],
                  ['current', STRINGS.current, SCENARIO_COLORS.current],
                  ['target', STRINGS.target, SCENARIO_COLORS.future],
                ] as const).map(([key, label, colour]) => {
                  const traced = derivation[key];
                  return (
                    <Box key={key} px={2} py={1.5}>
                      <HStack justify="space-between" align="baseline" spacing={3}>
                        <HStack spacing={2}>
                          <Box w="3px" h="12px" bg={colour} borderRadius="full" />
                          <Box fontSize="xs" color="gray.400">{label}</Box>
                        </HStack>
                        <Box fontSize="xs" color="gray.100" fontFamily="mono">
                          {traced.value !== undefined && !isNaN(traced.value)
                            ? formatValue(traced.value)
                            : <Box as="span" color="gray.600" fontStyle="italic">{STRINGS.notLoaded}</Box>}
                        </Box>
                      </HStack>
                      {/* The source matters: two of these three can come from
                          different computations of the same quantity. */}
                      <Box fontSize="2xs" color="gray.600" pl="13px">{traced.source}</Box>
                    </Box>
                  );
                })}
              </Section>
            </VStack>

            {/* A step further in, replacing this content rather than opening a
                second surface over the chart it describes. */}
            {calculations && (
              <Box pt={5} px={2}>
                <Button
                  size="sm"
                  width="100%"
                  variant="outline"
                  colorScheme="cyan"
                  onClick={() => setView('calculations')}
                >
                  {STRINGS.showCalculations}
                </Button>
              </Box>
            )}
          </Box>
        )}
      </Box>
    </Slide>
  );
}

export default ChartDetailsPanel;
