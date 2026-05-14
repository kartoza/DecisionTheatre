import { useEffect, useRef, useState } from 'react';
import {
  Box,
  Button,
  Flex,
  HStack,
  IconButton,
  Portal,
  Text,
  VStack,
} from '@chakra-ui/react';
import { AnimatePresence, motion } from 'framer-motion';
import { FiActivity, FiBarChart2, FiHelpCircle, FiMap, FiMapPin, FiX } from 'react-icons/fi';
import { colors } from '../styles/colors';

const TOUR_SEEN_KEY = 'dt-tour-seen';

interface TourStep {
  icon: React.ReactElement;
  title: string;
  description: string;
  targetId?: string;
  navigateTo?: string;
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
      'Click "Create New Site" to define a study area — import a shapefile or GeoJSON, or draw the boundary directly on the map. Go ahead and create one, then click Next.',
    targetId: 'tour-create-site-btn',
    navigateTo: 'sites',
  },
  {
    icon: <FiMap size={28} />,
    title: 'Map View',
    description:
      'Open a site to see its data on the choropleth map. Drag the split-screen slider to compare two scenarios side by side.',
    navigateTo: 'explore',
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
  },
  {
    icon: <FiHelpCircle size={28} />,
    title: 'Documentation',
    description:
      'Click the help icon any time to open the full documentation panel without leaving your current view.',
    targetId: 'tour-nav-docs',
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

    return () => {
      clearInterval(poll);
      observerRef.current?.disconnect();
      window.removeEventListener('scroll', update, true);
      window.removeEventListener('resize', update);
    };
  }, [targetId]);

  return rect;
}

function SpotlightRing({ rect }: { rect: DOMRect }) {
  const pad = 5;
  return (
    <Box
      position="fixed"
      pointerEvents="none"
      zIndex={1401}
      top={rect.top - pad}
      left={rect.left - pad}
      width={rect.width + pad * 2}
      height={rect.height + pad * 2}
      borderRadius="md"
      border="2px solid"
      borderColor={colors.orange}
      boxShadow={`0 0 0 4px ${colors.orange}33`}
      transition="all 0.3s ease"
    />
  );
}

export default function TourGuide() {
  const [step, setStep] = useState(0);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (!localStorage.getItem(TOUR_SEEN_KEY)) setVisible(true);
  }, []);

  useEffect(() => {
    const handler = () => {
      localStorage.removeItem(TOUR_SEEN_KEY);
      setStep(0);
      setVisible(true);
    };
    window.addEventListener('dt:restart-tour', handler);
    return () => window.removeEventListener('dt:restart-tour', handler);
  }, []);

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

  const next = () => {
    if (step < STEPS.length - 1) goToStep(step + 1);
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
            <HStack spacing={3}>
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
                  cursor="pointer"
                  onClick={() => goToStep(i)}
                />
              ))}
            </HStack>

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
          </VStack>
        </MotionBox>
      </AnimatePresence>
    </Portal>
  );
}
