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
  VStack,
} from '@chakra-ui/react';
import { AnimatePresence, motion, useDragControls } from 'framer-motion';
import {
  FiActivity,
  FiBarChart2,
  FiCheckCircle,
  FiMap,
  FiTarget,
  FiX,
} from 'react-icons/fi';
import { colors } from '../styles/colors';
import { getSite, loadLocalSites, saveLocalSites } from '../hooks/useApi';
import type { Site } from '../types';

const MUNYWANA_SITE_ID = 'fb1066ef-978e-4744-ac62-570a7cb366ed';
const LOAD_SITE_STEP = 1;

interface DemoStep {
  icon: React.ReactElement;
  title: string;
  description: string;
  targetId?: string;
  navigateTo?: string;
  autoPaneState?: { attribute: string; leftScenario: 'reference' | 'current' | 'future'; rightScenario: 'reference' | 'current' | 'future' };
  autoUiEvent?: string;
}

const DEMO_STEPS: DemoStep[] = [
  {
    icon: <FiMap size={28} />,
    title: 'Munywana Conservancy',
    description:
      'Welcome to the Munywana Conservancy - a 30,000 ha protected landscape in KwaZulu-Natal, South Africa. Use the LDD to explore environmental change, uncover patterns, and investigate potential management options.',
  },
  {
    icon: <FiMap size={28} />,
    title: 'Exploring the Landscape',
    description:
      'Munywana contains a mosaic of habitats, from open Zululand lowveld savanna to coastal woodland. Woody encroachment is a key management challenge. Click Next to begin exploring.',
    navigateTo: 'map',
    autoUiEvent: 'dt:demo-single-map-view',
  },
  {
    icon: <FiBarChart2 size={28} />,
    title: 'Above-ground Woody Biomass',
    description:
      'Munywana’s vegetation has changed over time. By comparing the ecological reference state with today’s landscape, we can identify where woody encroachment is most pronounced.',
    targetId: 'demo-attribute-selector',
    navigateTo: 'map',
    autoPaneState: { attribute: 'AGBwd_Mgha', leftScenario: 'reference', rightScenario: 'current' },
  },
  {
    icon: <FiMap size={28} />,
    title: 'Compare with the Swiper',
    description:
      'Drag the swiper handle left and right to reveal where woody biomass has changed. The western portion of the conservancy shows the highest biomass, while eastern areas show smaller increases relative to the ecological reference state.',
    targetId: 'tour-map-swiper',
    navigateTo: 'map',
  },
  {
    icon: <FiActivity size={28} />,
    title: 'Ecosystem Indicator Dials',
    description:
      'Let’s switch to dial view and compare multiple ecosystem indicators. Notice how many strays away from the ecological reference.',
    targetId: 'tour-view-modes',
    navigateTo: 'map',
  },
  {
    icon: <FiTarget size={28} />,
    title: 'Exploring Management Targets',
    description:
      'With signs of increasing woody encroachment across Munywana, we can begin to explore what happens if we try to shift the system back toward a more open landscape. Reduce the Proportion closed canopy in the Targets section and see how that affects the other ecological indicators',
    targetId: 'demo-edit-targets-btn',
    navigateTo: 'map',
    autoUiEvent: 'dt:demo-go-quad-dial',
  },
  {
    icon: <FiActivity size={28} />,
    title: 'Trade-offs and Fire',
    description:
      'Reducing the proportion of closed canopy decreases above-ground woody biomass, increases open ecosystems and grass productivity — but it also raises fuel load, potentially increasing the area burned. This is a key ecological trade-off that managers must weigh when planning interventions.',
    navigateTo: 'map',
  },
  {
    icon: <FiActivity size={28} />,
    title: 'Beyond Canopy Cover',
    description:
      'To understand this more deeply, we need to look beyond canopy cover alone and examine what is happening on the ground.',
    navigateTo: 'map',
  },
  {
    icon: <FiBarChart2 size={28} />,
    title: 'Exploring Chart View',
    description:
      'Altering the proportion of closed canopy only gives a small view into potential management options. We can move to the chart view and explore what is on the ground.',
    navigateTo: 'map',
  },
  {
    icon: <FiBarChart2 size={28} />,
    title: 'Tree Biomass Distribution',
    description:
      'The current landscape shows a shift toward larger trees compared to the reference state, consistent with woody encroachment processes observed earlier. Restoring more open conditions may involve reducing large-tree biomass — but this comes with important ecological, financial, and practical trade-offs.',
    navigateTo: 'map',
    autoUiEvent: 'dt:demo-tree-biomass-chart',
  },
  {
    icon: <FiBarChart2 size={28} />,
    title: 'Local Knowledge Matters',
    description:
      'Reserve managers report herbivore numbers higher than the model estimates. The LDD lets you incorporate local observations. Try adjusting herbivore biomass in the indicators panel to explore how greater grazing pressure influences grass productivity, methane production, and open ecosystem proportion.',
    targetId: 'tour-control-panel',
    navigateTo: 'map',
    autoUiEvent: 'dt:demo-go-quad-dial',
  },
  {
    icon: <FiActivity size={28} />,
    title: 'Herbivore Biomass Inputs',
    description:
      'The Site Indicators panel opens here. The Herbivores section (highlighted) lists the current model estimates for each herbivore group alongside the ecological reference values. Reserve managers observe numbers roughly 20–30 % higher than the model currently shows — the LDD lets you reflect that local knowledge directly.',
    targetId: 'demo-herbivore-section',
    navigateTo: 'indicators',
  },
  {
    icon: <FiBarChart2 size={28} />,
    title: 'Editing Herbivore Biomass',
    description:
      'The first editable herbivore count row is highlighted. Click the pencil icon in the Current State column to edit it — increase the value to better reflect what managers observe on the ground. As you adjust, the model recalculates downstream effects — watch how open ecosystem proportion, grass NPP, and methane production respond to greater grazing pressure.',
    targetId: 'demo-herbivore-editable-row',
    navigateTo: 'indicators',
  },
  {
    icon: <FiTarget size={28} />,
    title: 'Resetting the Target State',
    description:
      'After exploring higher herbivore scenarios, use the highlighted reset button to restore the target (ideal) values back to the ecological reference. This resets the baseline so your next scenario comparison starts from a clean reference state — an important step before running a new analysis.',
    targetId: 'demo-reset-targets',
    navigateTo: 'indicators',
  },
  {
    icon: <FiActivity size={28} />,
    title: 'Grazing Pressure Effects',
    description:
      'The six dials compare reference and current states for key ecosystem indicators. Click the highlighted "Targets" button and try increasing three of the herbivore-related targets to reflect the higher numbers reported by reserve managers — then observe how the dials shift across open ecosystem proportion, grass NPP, and methane production.',
    targetId: 'demo-edit-targets-btn',
    navigateTo: 'map',
    autoUiEvent: 'dt:demo-go-quad-dial',
  },
  {
    icon: <FiBarChart2 size={28} />,
    title: 'Trade-offs from Grazing Pressure',
    description:
      'After adjusting the herbivore targets, the dials reveal the cascading trade-offs: greater grazing pressure tends to reduce the proportion of open ecosystems and grass NPP while raising methane production from grazers. These interconnections illustrate why incorporating local knowledge is essential — observed herbivore numbers that differ from model estimates can substantially alter predicted ecosystem outcomes.',
    navigateTo: 'map',
  },
  {
    icon: <FiCheckCircle size={28} />,
    title: 'Your Turn to Explore',
    description:
      'Ecosystems are complex and management decisions involve trade-offs. The Landscape Decision Dashboard combines scientific models with local knowledge to evaluate potential outcomes of different decisions. Adjust the indicators, test management scenarios, and discover how changes in one part of the ecosystem influence the whole landscape.',
  },
];

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

export default function MunywanaDemoTour() {
  const [step, setStep] = useState(0);
  const [visible, setVisible] = useState(false);
  const [loadStatus, setLoadStatus] = useState<{ message: string; pct: number } | null>(null);
  const [isBlockedByModal, setIsBlockedByModal] = useState(false);
  const dragControls = useDragControls();

  useEffect(() => {
    const handler = () => {
      setStep(0);
      setVisible(true);
    };
    window.addEventListener('dt:start-munywana-demo', handler);
    return () => window.removeEventListener('dt:start-munywana-demo', handler);
  }, []);

  // Fire dt:demo-focus-herbivores after the indicators page has had time to
  // mount and load data. autoUiEvent would fire before the component mounts.
  useEffect(() => {
    const HERBIVORE_INPUTS_STEP = 11;
    if (step !== HERBIVORE_INPUTS_STEP || !visible) return;
    const timer = setTimeout(() => {
      window.dispatchEvent(new Event('dt:demo-focus-herbivores'));
    }, 600);
    return () => clearTimeout(timer);
  }, [step, visible]);

  useEffect(() => {
    const EXPLORING_TARGETS_STEP = 5;
    const GRAZING_EFFECTS_STEP = 14;
    const handleOpen = () => {
      setIsBlockedByModal(true);
      setStep((current) => {
        if (current === EXPLORING_TARGETS_STEP || current === GRAZING_EFFECTS_STEP) {
          return current + 1;
        }
        return current;
      });
    };
    const handleClose = () => setIsBlockedByModal(false);
    window.addEventListener('dt:targets-modal-opened', handleOpen);
    window.addEventListener('dt:targets-modal-closed', handleClose);
    return () => {
      window.removeEventListener('dt:targets-modal-opened', handleOpen);
      window.removeEventListener('dt:targets-modal-closed', handleClose);
    };
  }, []);

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
    const target = DEMO_STEPS[nextStep];
    if (target?.navigateTo) navigateTo(target.navigateTo);
    applyAutoPaneState(target);
    if (target?.autoUiEvent) window.dispatchEvent(new Event(target.autoUiEvent));
    setStep(nextStep);
  };

  const loadMunywanaSite = async (): Promise<Site> => {
    let site: Site | null = await getSite(MUNYWANA_SITE_ID);

    if (!site) {
      setLoadStatus({ message: 'Fetching site data…', pct: 40 });
      const response = await fetch(`/data/walkthroughs/${MUNYWANA_SITE_ID}.json`);
      if (!response.ok) throw new Error('Munywana site data not found');
      site = { ...await response.json() as Site, source: 'walkthrough' as const };
    }

    // Reset ideal (target) values to match reference each time the tour starts
    // so that any changes from a previous run do not carry over.
    if (site.indicators?.reference) {
      site = {
        ...site,
        indicators: { ...site.indicators, ideal: { ...site.indicators.reference } },
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

  // Automatically load and zoom to the Munywana site when step 1 is reached.
  useEffect(() => {
    if (step !== LOAD_SITE_STEP || !visible) return;
    let cancelled = false;

    const run = async () => {
      setLoadStatus({ message: 'Loading Munywana site…', pct: 20 });
      try {
        const site = await loadMunywanaSite();
        if (cancelled) return;

        setLoadStatus({ message: 'Opening on map…', pct: 75 });
        // Strip stored layout/pane state so handleOpenSite does not restore a
        // previously saved quad layout and override the single-pane reset.
        const siteForTour = { ...site, layoutMode: undefined, paneStates: undefined };
        window.dispatchEvent(new CustomEvent('dt:tour-open-site', { detail: siteForTour }));
        await new Promise<void>((resolve) => setTimeout(resolve, 600));
        if (cancelled) return;

        setLoadStatus({ message: 'Zooming to conservancy…', pct: 95 });
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
          console.error('[munywana-demo] Failed to load site:', error);
          setLoadStatus(null);
        }
      }
    };

    run();
    return () => { cancelled = true; };
  // loadMunywanaSite is defined inside the component but doesn't change — safe to omit.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, visible]);

  const next = () => {
    if (step < DEMO_STEPS.length - 1) {
      goToStep(step + 1);
    } else {
      dismiss();
    }
  };

  const prev = () => {
    if (step > 0) goToStep(step - 1);
  };

  const current = DEMO_STEPS[step];
  const isLast = step === DEMO_STEPS.length - 1;
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
              {DEMO_STEPS.map((_, index) => (
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
