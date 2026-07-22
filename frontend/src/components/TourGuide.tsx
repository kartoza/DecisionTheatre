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
import { FiActivity, FiBarChart2, FiHelpCircle, FiMap, FiMapPin, FiX } from 'react-icons/fi';
import { colors } from '../styles/colors';
import { createSite, listSites } from '../hooks/useApi';
import { getAppRuntime } from '../types/runtime';
import type { Site } from '../types';
import tourViewModesImg from '../assets/tour-view-modes.png';

const TOUR_SEEN_KEY = 'dt-tour-seen';
const DEFINE_BOUNDARY_STEP = 3;

interface TourStep {
  icon: React.ReactElement;
  title: string;
  description: string;
  targetId?: string;
  navigateTo?: string;
  image?: string;
}

const STEPS: TourStep[] = [
  {
    icon: <FiMap size={28} />,
    title: 'Welcome to Decision Theatre',
    description:
      'This quick tour walks you through the key features. You can interact with the app at any point — click Next when you\'re ready to continue.',
  },
  {
    icon: <FiMapPin size={28} />,
    title: 'My Sites',
    description:
      'Your study areas are managed here. Each site defines a geographic boundary used for data analysis and scenario comparison.',
    targetId: 'tour-nav-sites',
    navigateTo: 'sites',
  },
  {
    icon: <FiMapPin size={28} />,
    title: 'Create a Site',
    description:
      'Click "Create New Site" to open the site creation wizard. You can upload a Shapefile or GeoJSON, draw a boundary on the map, or select catchments.',
    targetId: 'tour-create-site-btn',
    navigateTo: 'sites',
  },
  {
    icon: <FiMapPin size={28} />,
    title: 'Define Your Boundary',
    description:
      'Choose a method to define your study area. After drawing or uploading your boundary, fill in a name and description, then click "Create Site" to save it and open it on the map.',
    targetId: 'tour-creation-methods',
    navigateTo: 'create-site',
  },
  {
    icon: <FiMap size={28} />,
    title: 'Your Site on the Map',
    description:
      'Your site is now visible on the choropleth map. Drag the highlighted slider to compare two scenarios side by side.',
    targetId: 'tour-map-swiper',
    navigateTo: 'map',
  },
  {
    icon: <FiBarChart2 size={28} />,
    title: 'Indicators & Scenarios',
    description:
      'This panel lets you pick an indicator and choose which scenarios appear on the left and right of the map. Statistics update as you pan and zoom.',
    targetId: 'tour-control-panel',
    navigateTo: 'explore',
  },
  {
    icon: <FiActivity size={28} />,
    title: 'View Modes',
    description:
      'Use these buttons to switch the pane between Map, Chart, Dial, and Table. In quad-pane mode all four views are shown at once.',
    targetId: 'tour-view-modes',
    navigateTo: 'explore',
    image: tourViewModesImg,
  },
  {
    icon: <FiHelpCircle size={28} />,
    title: 'Documentation',
    description:
      'Click the help icon any time to open the full documentation panel without leaving your current view.',
    targetId: 'tour-nav-docs',
  },
];

function geoBBox(geometry: GeoJSON.Geometry): { minX: number; minY: number; maxX: number; maxY: number } {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const u = (x: number, y: number) => {
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  };
  const scan = (g: GeoJSON.Geometry) => {
    if (g.type === 'Point') { u(g.coordinates[0], g.coordinates[1]); }
    else if (g.type === 'MultiPoint' || g.type === 'LineString') { g.coordinates.forEach(c => u(c[0], c[1])); }
    else if (g.type === 'MultiLineString' || g.type === 'Polygon') { g.coordinates.forEach(r => r.forEach(c => u(c[0], c[1]))); }
    else if (g.type === 'MultiPolygon') { g.coordinates.forEach(p => p.forEach(r => r.forEach(c => u(c[0], c[1])))); }
    else if (g.type === 'GeometryCollection') { g.geometries.forEach(scan); }
  };
  scan(geometry);
  return { minX, minY, maxX, maxY };
}

const MotionBox = motion(Box);

function useSpotlightRect(targetId: string | undefined) {
  const [rect, setRect] = useState<DOMRect | null>(null);
  const observerRef = useRef<ResizeObserver | null>(null);

  useEffect(() => {
    setRect(null);
    if (!targetId) return;

    const update = () => {
      const el = document.getElementById(targetId);
      setRect(el ? el.getBoundingClientRect() : null);
    };

    // Poll briefly on step change to wait for navigation/animation to settle
    let polls = 0;
    const poll = setInterval(() => {
      update();
      if (++polls >= 20) clearInterval(poll);
    }, 100);

    observerRef.current?.disconnect();
    const el = document.getElementById(targetId);
    if (el) {
      observerRef.current = new ResizeObserver(update);
      observerRef.current.observe(el);
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
  const pad = 6;
  return (
    <Box
      position="fixed"
      pointerEvents="none"
      zIndex={1401}
      style={{
        top: `${rect.top - pad}px`,
        left: `${rect.left - pad}px`,
        width: `${rect.width + pad * 2}px`,
        height: `${rect.height + pad * 2}px`,
      }}
      borderRadius="md"
      border="4px solid"
      borderColor={colors.orange}
      boxShadow={`0 0 0 4px ${colors.orange}`}
      transition="all 0.3s ease"
    />
  );
}

export default function TourGuide() {
  const [step, setStep] = useState(0);
  const [visible, setVisible] = useState(false);
  const [demoStatus, setDemoStatus] = useState<{ message: string; pct: number } | null>(null);
  const dragControls = useDragControls();
  const siteCountAtBoundaryStepRef = useRef<number | null>(null);

  useEffect(() => {
    if (!localStorage.getItem(TOUR_SEEN_KEY)) setVisible(true);
  }, []);

  // Snapshot how many sites exist as the user arrives at the "Define Your
  // Boundary" step, so we can tell on Next whether they actually created one.
  useEffect(() => {
    if (step !== DEFINE_BOUNDARY_STEP || !visible) return;
    siteCountAtBoundaryStepRef.current = null;
    listSites()
      .then((sites) => { siteCountAtBoundaryStepRef.current = sites.length; })
      .catch(() => { siteCountAtBoundaryStepRef.current = null; });
  }, [step, visible]);

  useEffect(() => {
    const handler = () => {
      localStorage.removeItem(TOUR_SEEN_KEY);
      setStep(0);
      setVisible(true);
    };
    window.addEventListener('dt:restart-tour', handler);
    return () => window.removeEventListener('dt:restart-tour', handler);
  }, []);

  // When step 4 ("Your Site on the Map") becomes active, zoom the map to the site
  useEffect(() => {
    if (step !== 4 || !visible) return;
    const timer = setTimeout(() => {
      window.dispatchEvent(new Event('dt:tour-zoom-to-site'));
    }, 1500);
    return () => clearTimeout(timer);
  }, [step, visible]);

  const navigate = (page: string) => {
    window.dispatchEvent(new CustomEvent('dt:navigate', { detail: page }));
  };

  const dismiss = () => {
    localStorage.setItem(TOUR_SEEN_KEY, '1');
    setVisible(false);
  };

  const goToStep = (nextStep: number) => {
    const target = STEPS[nextStep];
    if (target?.navigateTo) navigate(target.navigateTo);
    setStep(nextStep);
  };

  const next = async () => {
    const currentStep = step;

    if (currentStep === DEFINE_BOUNDARY_STEP) {
      try {
        const sites = await listSites();
        const baseline = siteCountAtBoundaryStepRef.current;
        const siteWasCreated = baseline !== null && sites.length > baseline;
        if (!siteWasCreated) {
          setDemoStatus({ message: 'Fetching demo shapefile…', pct: 15 });

          const resp = await fetch('/data/demo/Munywana_dissolved_fixed.zip');
          if (!resp.ok) throw new Error('Failed to fetch demo shapefile');
          const buffer = await resp.arrayBuffer();

          setDemoStatus({ message: 'Processing boundary geometry…', pct: 45 });
          const shp = await import('shpjs');
          const raw = await shp.default(buffer);
          const fc = Array.isArray(raw) ? raw[0] : raw;

          let geometry: GeoJSON.Geometry;
          if ('features' in fc && Array.isArray(fc.features) && fc.features.length > 0) {
            geometry = fc.features.length === 1
              ? fc.features[0].geometry
              : {
                  type: 'GeometryCollection' as const,
                  geometries: fc.features.map((f: GeoJSON.Feature) => f.geometry),
                };
          } else {
            throw new Error('No features found in shapefile');
          }

          setDemoStatus({ message: 'Creating site…', pct: 75 });
          const site = await createSite({
            title: 'Munywana',
            geometry,
            boundingBox: geoBBox(geometry),
            creationMethod: 'shapefile',
            appRuntime: getAppRuntime(),
          } as Partial<Site>);

          setDemoStatus({ message: 'Opening on map…', pct: 95 });
          window.dispatchEvent(new CustomEvent('dt:tour-open-site', { detail: site }));
          await new Promise<void>(r => setTimeout(r, 600));

          setDemoStatus(null);
          goToStep(currentStep + 1);
          return;
        }
      } catch (err) {
        console.error('[tour] Demo site creation failed:', err);
        setDemoStatus(null);
        // fall through to normal next
      }
    }

    if (currentStep < STEPS.length - 1) goToStep(currentStep + 1);
    else dismiss();
  };

  const prev = () => goToStep(Math.max(0, step - 1));

  const current = STEPS[step];
  const isLast = step === STEPS.length - 1;
  const rect = useSpotlightRect(visible ? current.targetId : undefined);

  if (!visible) return null;

  return (
    <Portal>
      {rect && <SpotlightRing rect={rect} />}

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
          w={{ base: 'calc(100vw - 24px)', sm: '400px' }}
          maxW="400px"
        >
          <IconButton
            aria-label="Close tour"
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
                color={colors.orange}
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

            {current.image && (
              <Box
                borderRadius="md"
                overflow="hidden"
                border="1px solid"
                borderColor="whiteAlpha.200"
                bg="whiteAlpha.50"
                p={2}
                w="full"
                display="flex"
                justifyContent="center"
              >
                <img
                  src={current.image}
                  alt={current.title}
                  style={{ maxWidth: '100%', height: 'auto', imageRendering: 'crisp-edges' }}
                />
              </Box>
            )}

            {/* Progress dots */}
            <HStack spacing={1.5}>
              {STEPS.map((_, i) => (
                <Box
                  key={i}
                  w={i === step ? 4 : 2}
                  h={2}
                  borderRadius="full"
                  bg={i === step ? colors.orange : 'whiteAlpha.300'}
                  transition="all 0.2s"
                  cursor={demoStatus ? 'default' : 'pointer'}
                  onClick={() => { if (!demoStatus) goToStep(i); }}
                />
              ))}
            </HStack>

            {demoStatus ? (
              <VStack spacing={2} w="full" pt={1}>
                <HStack spacing={2} w="full">
                  <Spinner size="xs" color={colors.orange} flexShrink={0} />
                  <Text fontSize="xs" color="whiteAlpha.700" flex={1}>{demoStatus.message}</Text>
                  <Text fontSize="xs" color={colors.orange} fontWeight="bold">{demoStatus.pct}%</Text>
                </HStack>
                <Box w="full" bg="whiteAlpha.100" borderRadius="full" h="6px" overflow="hidden">
                  <Box
                    w={`${demoStatus.pct}%`}
                    bg={colors.orange}
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
                  Skip tour
                </Button>
                <HStack spacing={2}>
                  {step > 0 && (
                    <Button size="xs" variant="ghost" color="whiteAlpha.700" onClick={prev} _hover={{ color: 'white' }}>
                      Back
                    </Button>
                  )}
                  <Button
                    size="xs"
                    bg={colors.orange}
                    color="white"
                    _hover={{ opacity: 0.85 }}
                    onClick={next}
                  >
                    {isLast ? 'Get started' : 'Next'}
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
