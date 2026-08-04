import { useEffect, useRef, useState } from 'react';
import {
  Box,
  Button,
  Flex,
  HStack,
  IconButton,
  Portal,
  Spinner,
  Text,
  useToast,
  VStack,
} from '@chakra-ui/react';
import { AnimatePresence, motion, useDragControls } from 'framer-motion';
import { FiX } from 'react-icons/fi';
import { colors } from '../styles/colors';
import { getSite, loadLocalSites, saveLocalSites, normalizeWalkthroughSite } from '../hooks/useApi';
import type { Site } from '../types';

export interface DemoStep {
  icon: React.ReactElement;
  title: string;
  description: string;
  targetId?: string;
  navigateTo?: string;
  autoPaneState?: { attribute: string; leftScenario: 'reference' | 'current' | 'future'; rightScenario: 'reference' | 'current' | 'future' };
  autoUiEvent?: string;
}

export interface DemoTourProps {
  /** UUID of the walkthrough site under data/walkthroughs/{siteId}.json. */
  siteId: string;
  /** Window event name that opens the tour, e.g. 'dt:start-munywana-demo'. */
  startEvent: string;
  steps: DemoStep[];
  /** Step index at which the walkthrough site is loaded and zoomed to. Defaults to 1. */
  loadSiteStep?: number;
  /** Step indices at which opening the targets modal should auto-advance to the next step. */
  targetsModalAdvanceSteps?: number[];
  /** Called whenever the visible step changes, for site-specific side effects. */
  onStepChange?: (step: number, visible: boolean) => void;
}

const MotionBox = motion(Box);

function useSpotlightRect(targetId: string | undefined) {
  const [rect, setRect] = useState<DOMRect | null>(null);
  const observerRef = useRef<ResizeObserver | null>(null);

  useEffect(() => {
    setRect(null);
    if (!targetId) return;

    const update = () => {
      const element = document.getElementById(targetId);
      setRect(element ? element.getBoundingClientRect() : null);
    };

    let pollCount = 0;
    const poll = setInterval(() => {
      update();
      if (++pollCount >= 20) clearInterval(poll);
    }, 100);

    observerRef.current?.disconnect();
    const element = document.getElementById(targetId);
    if (element) {
      observerRef.current = new ResizeObserver(update);
      observerRef.current.observe(element);
    }

    window.addEventListener('scroll', update, true);
    window.addEventListener('resize', update);
    window.addEventListener('pointermove', update);

    return () => {
      clearInterval(poll);
      observerRef.current?.disconnect();
      window.removeEventListener('scroll', update, true);
      window.removeEventListener('resize', update);
      window.removeEventListener('pointermove', update);
    };
  }, [targetId]);

  return rect;
}

function SpotlightRing({ rect }: { rect: DOMRect }) {
  const padding = 6;
  return (
    <Box
      position="fixed"
      pointerEvents="none"
      zIndex={1401}
      style={{
        top: `${rect.top - padding}px`,
        left: `${rect.left - padding}px`,
        width: `${rect.width + padding * 2}px`,
        height: `${rect.height + padding * 2}px`,
      }}
      borderRadius="md"
      border="4px solid"
      borderColor={colors.brightGreen}
      boxShadow={`0 0 0 4px ${colors.brightGreen}`}
      transition="all 0.3s ease"
    />
  );
}

export default function DemoTour({
  siteId,
  startEvent,
  steps,
  loadSiteStep = 1,
  targetsModalAdvanceSteps = [],
  onStepChange,
}: DemoTourProps) {
  const [step, setStep] = useState(0);
  const [visible, setVisible] = useState(false);
  const [loadStatus, setLoadStatus] = useState<{ message: string; pct: number } | null>(null);
  const [isBlockedByModal, setIsBlockedByModal] = useState(false);
  const dragControls = useDragControls();
  const toast = useToast();

  useEffect(() => {
    const handler = () => {
      setStep(0);
      setVisible(true);
    };
    window.addEventListener(startEvent, handler);
    return () => window.removeEventListener(startEvent, handler);
  }, [startEvent]);

  useEffect(() => {
    onStepChange?.(step, visible);
  }, [step, visible, onStepChange]);

  useEffect(() => {
    if (targetsModalAdvanceSteps.length === 0) return;
    const handleOpen = () => {
      setIsBlockedByModal(true);
      setStep((current) => (targetsModalAdvanceSteps.includes(current) ? current + 1 : current));
    };
    const handleClose = () => setIsBlockedByModal(false);
    window.addEventListener('dt:targets-modal-opened', handleOpen);
    window.addEventListener('dt:targets-modal-closed', handleClose);
    return () => {
      window.removeEventListener('dt:targets-modal-opened', handleOpen);
      window.removeEventListener('dt:targets-modal-closed', handleClose);
    };
  }, [targetsModalAdvanceSteps]);

  const navigateTo = (page: string) => {
    window.dispatchEvent(new CustomEvent('dt:navigate', { detail: page }));
  };

  const applyAutoPaneState = (demoStep: DemoStep) => {
    if (!demoStep.autoPaneState) return;
    window.dispatchEvent(new CustomEvent('dt:demo-pane-state', { detail: demoStep.autoPaneState }));
  };

  const dismiss = () => {
    setVisible(false);
    setLoadStatus(null);
  };

  const goToStep = (nextStep: number) => {
    const target = steps[nextStep];
    if (target?.navigateTo) navigateTo(target.navigateTo);
    applyAutoPaneState(target);
    if (target?.autoUiEvent) window.dispatchEvent(new Event(target.autoUiEvent));
    setStep(nextStep);
  };

  const loadDemoSite = async (): Promise<Site> => {
    let site: Site | null = await getSite(siteId);

    if (!site) {
      setLoadStatus({ message: 'Fetching site data…', pct: 40 });
      const response = await fetch(`/data/walkthroughs/${siteId}.json`);
      if (!response.ok) throw new Error('Walkthrough site data not found');
      site = normalizeWalkthroughSite({ ...await response.json() as Site, source: 'walkthrough' as const });
    }

    // Reset ideal (target) values to match current each time the tour starts
    // so that any changes from a previous run do not carry over.
    if (site.indicators?.current) {
      site = {
        ...site,
        indicators: { ...site.indicators, ideal: { ...site.indicators.current } },
      };
    }

    // Persist the reset state so it is available for the rest of the session.
    const existingSites = loadLocalSites();
    const siteIndex = existingSites.findIndex((s) => s.id === site!.id);
    if (siteIndex >= 0) {
      existingSites[siteIndex] = site;
      saveLocalSites(existingSites);
    } else {
      saveLocalSites([...existingSites, site]);
    }

    return site;
  };

  // Automatically load and zoom to the walkthrough site when loadSiteStep is reached.
  useEffect(() => {
    if (step !== loadSiteStep || !visible) return;
    let cancelled = false;

    const run = async () => {
      setLoadStatus({ message: 'Loading site…', pct: 20 });
      try {
        const site = await loadDemoSite();
        if (cancelled) return;

        setLoadStatus({ message: 'Opening on map…', pct: 75 });
        // Strip stored layout/pane state so handleOpenSite does not restore a
        // previously saved quad layout and override the single-pane reset.
        const siteForTour = { ...site, layoutMode: undefined, paneStates: undefined };
        window.dispatchEvent(new CustomEvent('dt:tour-open-site', { detail: siteForTour }));
        await new Promise<void>((resolve) => setTimeout(resolve, 600));
        if (cancelled) return;

        setLoadStatus({ message: 'Zooming to site…', pct: 95 });
        window.dispatchEvent(new Event('dt:tour-zoom-to-site'));
        await new Promise<void>((resolve) => setTimeout(resolve, 1000));
        if (cancelled) return;

        // Second zoom dispatch ensures the view is correct even when the first
        // fitBounds call was calculated against a mid-transition container size
        // (e.g. the control panel still sliding in from the previous session).
        window.dispatchEvent(new Event('dt:tour-zoom-to-site'));
        await new Promise<void>((resolve) => setTimeout(resolve, 600));
        if (cancelled) return;

        setLoadStatus(null);
      } catch (error) {
        if (!cancelled) {
          console.error(`[demo-tour:${siteId}] Failed to load site:`, error);
          setLoadStatus(null);
          toast({
            title: 'Could not load tour site',
            description: 'The map still shows whatever was previously open.',
            status: 'error',
            duration: 5000,
          });
        }
      }
    };

    run();
    return () => { cancelled = true; };
  // loadDemoSite is defined inside the component but doesn't change — safe to omit.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, visible, loadSiteStep, siteId]);

  const next = () => {
    if (step < steps.length - 1) {
      goToStep(step + 1);
    } else {
      dismiss();
    }
  };

  const prev = () => {
    if (step > 0) goToStep(step - 1);
  };

  const current = steps[step];
  const isLast = step === steps.length - 1;
  const spotlightRect = useSpotlightRect(visible ? current.targetId : undefined);

  if (!visible || isBlockedByModal) return null;

  return (
    <Portal>
      {spotlightRect && <SpotlightRing rect={spotlightRect} />}

      <AnimatePresence mode="wait">
        <MotionBox
          key={step}
          position="fixed"
          bottom={{ base: '12px', md: '28px' }}
          left="50%"
          style={{ translateX: '-50%' }}
          zIndex={1402}
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -12 }}
          transition={{ duration: 0.22 }}
          drag
          dragControls={dragControls}
          dragMomentum={false}
          bg={colors.darkGray}
          borderRadius="xl"
          boxShadow="dark-lg"
          border="1px solid"
          borderColor="whiteAlpha.200"
          p={5}
          w={{ base: 'calc(100vw - 24px)', sm: '420px' }}
          maxW="420px"
        >
          <IconButton
            aria-label="Close demo"
            icon={<FiX />}
            size="xs"
            position="absolute"
            top={2}
            right={2}
            variant="ghost"
            color="whiteAlpha.500"
            onClick={dismiss}
            _hover={{ color: 'white' }}
          />

          <VStack align="start" spacing={3}>
            <HStack
              spacing={3}
              onPointerDown={(e) => dragControls.start(e)}
              cursor="grab"
              userSelect="none"
              w="full"
              pr={6}
            >
              <Flex
                align="center"
                justify="center"
                w={10}
                h={10}
                borderRadius="lg"
                bg="whiteAlpha.100"
                color={colors.brightGreen}
                flexShrink={0}
              >
                {current.icon}
              </Flex>
              <Text fontWeight="bold" fontSize="sm" color="white" lineHeight="short">
                {current.title}
              </Text>
            </HStack>

            <Text fontSize="sm" color="whiteAlpha.800" lineHeight="tall">
              {current.description}
            </Text>

            <HStack spacing={1.5}>
              {steps.map((_, index) => (
                <Box
                  key={index}
                  w={index === step ? 4 : 2}
                  h={2}
                  borderRadius="full"
                  bg={index === step ? colors.brightGreen : 'whiteAlpha.300'}
                  transition="all 0.2s"
                  cursor={loadStatus ? 'default' : 'pointer'}
                  onClick={() => { if (!loadStatus) goToStep(index); }}
                />
              ))}
            </HStack>

            {loadStatus ? (
              <VStack spacing={2} w="full" pt={1}>
                <HStack spacing={2} w="full">
                  <Spinner size="xs" color={colors.brightGreen} flexShrink={0} />
                  <Text fontSize="xs" color="whiteAlpha.700" flex={1}>{loadStatus.message}</Text>
                  <Text fontSize="xs" color={colors.brightGreen} fontWeight="bold">{loadStatus.pct}%</Text>
                </HStack>
                <Box w="full" bg="whiteAlpha.100" borderRadius="full" h="6px" overflow="hidden">
                  <Box
                    w={`${loadStatus.pct}%`}
                    bg={colors.brightGreen}
                    h="full"
                    borderRadius="full"
                    transition="width 0.4s ease"
                  />
                </Box>
              </VStack>
            ) : (
              <Flex w="full" justify="space-between" align="center">
                <Button
                  size="xs"
                  variant="ghost"
                  color="whiteAlpha.500"
                  onClick={dismiss}
                  _hover={{ color: 'white' }}
                >
                  Close
                </Button>
                <HStack spacing={2}>
                  {step > 0 && (
                    <Button
                      size="xs"
                      variant="ghost"
                      color="whiteAlpha.700"
                      onClick={prev}
                      _hover={{ color: 'white' }}
                    >
                      Back
                    </Button>
                  )}
                  <Button
                    size="xs"
                    bg={colors.brightGreen}
                    color="white"
                    _hover={{ opacity: 0.85 }}
                    onClick={next}
                  >
                    {isLast ? 'Start exploring' : 'Next'}
                  </Button>
                </HStack>
              </Flex>
            )}
          </VStack>
        </MotionBox>
      </AnimatePresence>
    </Portal>
  );
}
