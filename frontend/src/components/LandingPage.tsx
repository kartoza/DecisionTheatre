import {
  Box,
  Button,
  type ButtonProps,
  Container,
  Flex,
  Grid,
  Heading,
  type HeadingProps,
  HStack,
  IconButton,
  Image,
  Text,
  Tooltip,
  VStack,
} from '@chakra-ui/react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { motion } from 'framer-motion';
import { SCENARIOS, type AppPage } from '../types';
import { colors } from '../styles/colors';

import partnerAfricanWildlife from '../assets/partners/africanwildlifeeconomy_logo 1.png';
import partnerApes from '../assets/partners/APES_logo_grayscale_nb 1.png';
import partnerFefa from '../assets/partners/FEFA logo[31] (1) 1.png';
import partnerGci from '../assets/partners/GCI with tagline-1000x315 1.png';
import partnerGgg from '../assets/partners/GGG-logo 1.png';
import partnerKaratina from '../assets/partners/Karatina-University 1.png';
import partnerKnust from '../assets/partners/logo-knust 1.png';
import partnerRewildBlack from '../assets/partners/logo-vertical-black-2x 1.png';
import partnerNrf from '../assets/partners/National_Research_Foundation_logo.svg 1.png';
import partnerOg from '../assets/partners/OG_LOGO 1.png';
import partnerSeosaw from '../assets/partners/SEOSAW.png';
import partnerShangani from '../assets/partners/Shangani-Holistic-Logo-1 1.png';
import partnerStockholm from '../assets/partners/stockholmuni_logo 1.png';
import partnerTafori from '../assets/partners/TAFORI_logo 1.png';
import partnerWits from '../assets/partners/witslogo_nb 1.png';
import backgroundImage1 from '../assets/CattleLubangoAngola2_1.png';
import rewildLogo from '../assets/logo-vertical-white-3x 1.png';
import fefaLogog from '../assets/JM_FEFA_Logo_Dark_RGB_72dpi_aw.png';
import dialsScreenshot from '../assets/Dials_screenshot.png';
import graphScreenshot from '../assets/Graph_screenshot.png';
import mapScreenshot from '../assets/Map_screenshot.png';
import sitesScreenshot from '../assets/sites_screenshot.png';
import landOwnerImage from '../assets/land_owner.png';
import localGovernmentImage from '../assets/local_government.png';
import futurePossibilitiesImage from '../assets/future_possibilities.png';
import ruralCommunityImage from '../assets/rural_communities.png';
import tanzaniaImage from '../assets/MorogoroTanzania_1.png';
import gettingStartedImage from '../assets/Getting_started.png';
import kartozaLogo from '../assets/Kartoza horizontal logo_white.png';

interface LandingPageProps {
  onNavigate: (page: AppPage) => void;
}

// const imageOverlayLabelStyle: React.CSSProperties = {
//   position: 'absolute',
//   top: '25px',
//   right: '25px',
//   backgroundColor: 'rgba(255, 255, 255, 0.6)',
//   padding: '8px 12px',
//   borderTopLeftRadius: '8px',
//   borderBottomRightRadius: '8px',
//   borderTopRightRadius: '8px',
//   border: '0.25px solid #2f2e2e',
//   boxShadow: '0 4px 4px 0 rgba(0, 0, 0, 0.25)',
// };

interface Partner {
  logo: string;
  name: string;
  url: string;
}

const partners: Partner[] = [
  { logo: partnerAfricanWildlife, name: 'African Wildlife Economy',      url: 'https://wildlifeeconomy.info/' },
  { logo: partnerApes,            name: 'AP-ES',                         url: 'https://www.wits.ac.za/apes/' },
  { logo: partnerFefa,            name: 'FEFA',                          url: 'https://futureecosystemsafrica.org/' },
  { logo: partnerGci,             name: 'GCI',                           url: 'https://www.wits.ac.za/gci/' },
  { logo: partnerGgg,             name: 'GGG',                           url: 'https://globalgrassygroup.github.io/' },
  { logo: partnerKaratina,        name: 'Karatina University',           url: 'https://karu.ac.ke/' },
  { logo: partnerKnust,           name: 'KNUST',                         url: 'https://www.knust.edu.gh/' },
  { logo: partnerRewildBlack,     name: 'Rewild',                        url: 'https://www.rewildcapital.com/' },
  { logo: partnerNrf,             name: 'National Research Foundation',  url: 'https://www.nrf.ac.za/' },
  { logo: partnerOg,              name: 'OG',                            url: 'https://ogresearchconservation.org/' },
  { logo: partnerSeosaw,          name: 'SEOSAW',                        url: 'https://seosaw.github.io/' },
  { logo: partnerShangani,        name: 'Shangani Holistic',             url: 'https://ogresearchconservation.org/shangani-2/' },
  { logo: partnerStockholm,       name: 'Stockholm University',          url: 'https://www.su.se/english' },
  { logo: partnerTafori,          name: 'TAFORI',                        url: 'https://tafori.or.tz/' },
  { logo: partnerWits,            name: 'Wits',                          url: 'https://www.wits.ac.za/apes/' },
];

const AUTO_PLAY_MS = 4000;

function PartnersCarousel() {
  const [offset, setOffset] = useState(0);
  const [visible, setVisible] = useState(5);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    const update = () => setVisible(window.innerWidth < 600 ? 1 : window.innerWidth < 900 ? 3 : 5);
    update();
    window.addEventListener('resize', update);
    return () => window.removeEventListener('resize', update);
  }, []);

  const advance = useCallback(() => {
    setOffset(o => (o + 1) % partners.length);
  }, []);

  const retreat = useCallback(() => {
    setOffset(o => (o - 1 + partners.length) % partners.length);
  }, []);

  useEffect(() => {
    timerRef.current = setInterval(advance, AUTO_PLAY_MS);
    return () => { if (timerRef.current) clearInterval(timerRef.current); };
  }, [advance]);

  const reset = () => {
    if (timerRef.current) clearInterval(timerRef.current);
    timerRef.current = setInterval(advance, AUTO_PLAY_MS);
  };

  const visiblePartners = Array.from({ length: visible }, (_, i) =>
    partners[(offset + i) % partners.length]
  );

  return (
    <HStack spacing={0} justify="center" align="center" gap={4}>
      <IconButton
        aria-label="Previous"
        icon={<span style={{ fontSize: '1.4rem' }}>‹</span>}
        onClick={() => { retreat(); reset(); }}
        variant="ghost"
        color="white"
        _hover={{ bg: 'whiteAlpha.200' }}
        size="lg"
      />

      {visiblePartners.map((p, i) => (
        <Box
          key={`${p.name}-${i}`}
          as="a"
          href={p.url}
          target="_blank"
          rel="noopener noreferrer"
          onClick={() => reset()}
          cursor="pointer"
          bg="white"
          borderRadius="xl"
          p={4}
          h="110px"
          w="180px"
          display="flex"
          alignItems="center"
          justifyContent="center"
          transition="transform 0.2s, box-shadow 0.2s"
          _hover={{ transform: 'translateY(-4px)', boxShadow: 'xl' }}
        >
          <Image src={p.logo} alt={p.name} maxH="80px" maxW="150px" objectFit="contain" />
        </Box>
      ))}

      <IconButton
        aria-label="Next"
        icon={<span style={{ fontSize: '1.4rem' }}>›</span>}
        onClick={() => { advance(); reset(); }}
        variant="ghost"
        color="white"
        _hover={{ bg: 'whiteAlpha.200' }}
        size="lg"
      />
    </HStack>
  );
}

interface LandscapeSlide {
  image: string;
  alt: string;
  title: string;
  description: string;
}

const landscapeSlides: LandscapeSlide[] = [
  {
    image: dialsScreenshot,
    alt: 'Dials screenshot',
    title: 'Visualise trends and trade-offs',
    description: 'Compare variables with interactive dials to support informed decision-making.',
  },
  {
    image: graphScreenshot,
    alt: 'Graph/chart screenshot',
    title: 'Compare landscape states',
    description: 'View detailed data across the reference, current and target landscape states.',
  },
  {
    image: mapScreenshot,
    alt: 'Map screenshot',
    title: 'Explore spatial patterns',
    description: 'Map ecosystem variables across your landscape and compare between the different landscape states.',
  },
  {
    image: sitesScreenshot,
    alt: 'Sites screenshot',
    title: 'Create your own sites',
    description: 'Define an area of interest and explore different possibilities for your landscape.',
  },
];

const LANDSCAPE_AUTO_PLAY_MS = 5000;

function LandscapeManagementCarousel() {
  const [index, setIndex] = useState(0);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const advance = useCallback(() => {
    setIndex(i => (i + 1) % landscapeSlides.length);
  }, []);

  useEffect(() => {
    timerRef.current = setInterval(advance, LANDSCAPE_AUTO_PLAY_MS);
    return () => { if (timerRef.current) clearInterval(timerRef.current); };
  }, [advance]);

  const reset = () => {
    if (timerRef.current) clearInterval(timerRef.current);
    timerRef.current = setInterval(advance, LANDSCAPE_AUTO_PLAY_MS);
  };

  const slide = landscapeSlides[index];

  return (
    <Box maxW="700px" mx="auto" textAlign="center">
      <Image
        src={slide.image}
        alt={slide.alt}
        w="100%"
        objectFit="contain"
        mx="auto"
        mb={6}
        borderRadius="lg"
      />
      <Heading
        {...headingProps}
        as="h3"
        fontSize={{ base: 'xl', md: '2xl' }}
        fontWeight="bold"
        color="white"
        mb={3}
      >
        {slide.title}
      </Heading>
      <Text fontSize="md" color="white" lineHeight="1.75" mb={5}>
        {slide.description}
      </Text>
      <HStack justify="center" spacing={2}>
        {landscapeSlides.map((s, i) => (
          <Box
            key={s.alt}
            as="button"
            aria-label={`Show ${s.alt}`}
            onClick={() => { setIndex(i); reset(); }}
            w="8px"
            h="8px"
            borderRadius="full"
            bg={i === index ? colors.orange : 'whiteAlpha.400'}
            transition="background-color 0.2s"
          />
        ))}
      </HStack>
    </Box>
  );
}

const buttonOverlayStyle: React.CSSProperties = {
  position: 'absolute',
  bottom: '5%',
  left: '50%',
  transform: 'translate(-50%, -5%)',
  padding: '12px 24px',
};

const headingProps: HeadingProps = {
  fontFamily: '"Source Sans 3", "Source Sans Pro", sans-serif',
};

const outlinedButtonProps: ButtonProps = {
  bg: 'white',
  color: 'black',
  borderRadius: 'full',
  border: '1px solid',
  borderColor: 'black',
  px: 8,
  h: '40px',
  fontSize: 'sm',
  fontWeight: 'semibold',
  _hover: { bg: colors.orange, color: 'white', borderColor: 'transparent' },
};

// The six things the dashboard actually lets you do, condensed from the full
// sentences into a scannable chip strip. Cycles through the app's existing
// pastel palette — six capabilities, six tokens already in the design system.
const dashboardCapabilities: { label: string; color: string }[] = [
  { label: 'Assess current conditions', color: colors.pastelLightOrange },
  { label: 'Compare with reference', color: colors.pastelLightBlue },
  { label: 'Explore future scenarios', color: colors.pastelLightGreen },
  { label: 'Adjust management variables', color: colors.pastelYellow },
  { label: 'Investigate land-use impacts', color: colors.pastelDarkOrange },
  { label: 'Visualise ecosystem connections', color: colors.pastelDarkGreen },
];

// Who each explore card speaks to — this used to be written but commented
// out and never shown; surfacing it gives every card a clear "who this is
// for" alongside the "what you can explore" button.
const dashboardAudiences: { image: string; audience: string; cta: string; event: string; tooltip?: string }[] = [
  {
    image: landOwnerImage,
    audience: 'Land owners & conservation managers',
    cta: 'Explore Conservation Futures',
    event: 'dt:start-munywana-demo',
    tooltip: 'Visualise the opportunities and challenges of conserving biodiversity while exploring carbon financing opportunities.\n\nThe dashboard can help users consider different options for financing land management activities, providing ecosystem services and conserving biodiversity within their ecological and social context.',
  },
  {
    image: ruralCommunityImage,
    audience: 'Rural communities',
    cta: 'Explore Shared Landscapes',
    event: 'dt:start-viphya-demo',
    tooltip: 'Explore how different landscape futures may affect nature’s contributions to people, including grazing, food, fuelwood, thatching grass, hunting and honey gathering.\n\nThe dashboard can support discussion about different desired ecosystem states and the priorities and tensions that may exist within communities.',
  },
  {
    image: localGovernmentImage,
    audience: 'Local government agencies and traditional leadership',
    cta: 'Explore Policy Impacts',
    event: 'dt:start-shaihills-demo',
    tooltip: 'Examine the consequences of different policies for landscapes and people.\n\nAcademics and practitioners working on carbon and biodiversity finance\n\nInvestigate the potential pitfalls and unintended outcomes of different carbon and biodiversity credit schemes, and explore mechanisms that may work in African contexts.',
  },
  {
    image: futurePossibilitiesImage,
    audience: 'School learners, artists and members of the public',
    cta: 'Explore Future Possibilities',
    event: 'dt:start-africa-demo',
    tooltip: 'Explore and reimagine African landscapes guided by different ideas about what people value and need in the future',
  },
];

// Reuse the app's own reference/current/future colour coding (the same hues
// used on every dial and chart) so the landing page teaches the legend
// visitors will actually see once they open a site.
const scenarioColors: Record<string, string> = Object.fromEntries(
  SCENARIOS.map((s) => [s.id, s.color])
);

const gettingStartedStages: { id: string; eyebrow: string; description: string }[] = [
  {
    id: 'reference',
    eyebrow: 'Reference',
    description: 'The ecological baseline — conditions in which fire, grazing and nutrient cycling operate at appropriate, healthy levels.',
  },
  {
    id: 'current',
    eyebrow: 'Current',
    description: "Today's landscape, assessed from environmental data collected over the past 20 years.",
  },
  {
    id: 'future',
    eyebrow: 'Future',
    description: 'Adjust management and environmental variables to test how interventions could reshape the landscape over time.',
  },
];

function LandingPage({ onNavigate }: LandingPageProps) {
  return (
    <Box w="100%" h="100%" overflowY="auto" bg={colors.darkGray} color="gray.900">

      {/* ── HERO ──────────────────────────────────────────── */}
      <Box position="relative">
        <Box position="relative" minH="440px">
          {/* Background image */}
          <Box
            position="absolute"
            inset={0}
            backgroundImage={`url(${backgroundImage1})`}
            backgroundSize="cover"
            backgroundPosition="center"
          />

          {/* Dark overlay */}
          <Box position="absolute" inset={0} bg="blackAlpha.700" />

          {/* Content */}
          <Flex
            position="relative"
            direction="column"
            align="center"
            justify="center"
            minH="550px"
            px={6}
            py={20}
            textAlign="center"
            zIndex={1}
          >
            <Heading
              {...headingProps}
              as="h1"
              fontSize={{ base: '3xl', md: '4xl', lg: '4xl' }}
              fontWeight="bold"
              color="white"
              mb={9}
              lineHeight="1.25"
            >
              Welcome to the Landscape Decision Dashboard
            </Heading>

            <Text
              fontSize={{ base: 'lg', md: 'lg' }}
              fontWeight="bold"
              color="whiteAlpha.900"
              mb={5}
              lineHeight="1.7"
            >
              Explore how land management choices affect biodiversity, carbon storage and ecosystem functioning across African landscapes.
            </Text>

            <Text
              fontSize={{ base: 'sm', md: 'md' }}
              color="whiteAlpha.900"
              maxW="560px"
              mb={9}
              lineHeight="1.7"
            >
               This interactive tool brings together real-world data and ecosystem response models to reveal the complex relationships between vegetation structure, biodiversity, carbon storage and vital ecological processes.
            </Text>

            <Button
              bg={colors.orange}
              color="white"
              borderRadius="full"
              px={8}
              h="46px"
              fontSize="sm"
              fontWeight="semibold"
              onClick={() => onNavigate('explore')}
              _hover={{ bg: '#D8832A', transform: 'translateY(-1px)' }}
              transition="all 0.2s"
              boxShadow="md"
            >
              Explore the Future of Ecosystem Decision-Making
            </Button>
          </Flex>
        </Box>

        {/* Orange bottom strip */}
        <Box h="25px" bg={colors.orange} />
      </Box>

      {/* ── OUR MISSION ───────────────────────────────────── */}
      <Box bg={colors.darkGray} py={16} px={6}>
        <Container maxW="1200px" textAlign="center">
          <Heading
            {...headingProps}
            as="h2"
            fontSize={{ base: '3xl', md: '4xl' }}
            fontWeight="bold"
            color="white"
            mb={10}
          >
            Supporting landscape management 
          </Heading>
          <Flex gap="10" align="center" justify="center" wrap="wrap" mb={10}>
            <Box flex="1" minW="260px">
              <LandscapeManagementCarousel />
            </Box>
            <Box flex="1" minW="260px" textAlign="left">
              <Text fontSize="md" color="white" lineHeight="1.75">
                Users can assess the current state of a landscape, compare it with ecological reference conditions and explore how different interventions may alter ecosystem functioning. This allows them to examine the consequences and trade-offs associated with different land management and conservation choices. 
              </Text>
              <br></br>
              <Text fontSize="md" color="white" lineHeight="1.75">
                The dashboard supports exploration at multiple scales, from individual catchments to the African continent as a whole
              </Text>
            </Box>
          </Flex>
          <Button
            bg="transparent"
            color="white"
            border="1px solid"
            borderColor="white"
            borderRadius="full"
            px={8}
            h="46px"
            fontSize="sm"
            fontWeight="semibold"
            _hover={{
              bg: 'whiteAlpha.100',
              color: 'white',
              borderColor: 'white',
              transform: 'translateY(-1px)',
            }}
            _active={{
              bg: 'whiteAlpha.200',
            }}
            _focus={{
              boxShadow: 'none',
            }}
            transition="all 0.2s"
            boxShadow="none"
            mt={5}
            onClick={() => onNavigate('partnership')}
          >
            The FEFA and Rewild Capital Partnership
          </Button>
        </Container>
      </Box>

      {/* ── FROM DATA TO PROGRESS ─────────────────────────────── */}
      <Box bg={colors.darkGray} py={10} pb={20} px={6}>
        <Container maxW="1000px">
          <Box textAlign="center" mb={9}>
            <Heading
              {...headingProps}
              as="h2"
              fontSize={{ base: '3xl', md: '4xl' }}
              fontWeight="bold"
              color="white"
            >
              Use the Landscape Decision Dashboard to:
            </Heading>
          </Box>

          {/* Capability strip — the six things the tool does, as a scannable
              row of tags rather than a legalistic bulleted list. */}
          <Flex wrap="wrap" gap={3} justify="center" mb={10}>
            {dashboardCapabilities.map((cap) => (
              <HStack
                key={cap.label}
                spacing={2}
                bg="whiteAlpha.100"
                border="1px solid"
                borderColor="whiteAlpha.200"
                borderRadius="full"
                px={4}
                py={2}
              >
                <Box w="8px" h="8px" borderRadius="full" bg={cap.color} flexShrink={0} />
                <Text fontSize="sm" color="white" fontWeight="medium" whiteSpace="nowrap">
                  {cap.label}
                </Text>
              </HStack>
            ))}
          </Flex>

          {/* Pull-quote — this is the tool's actual thesis, so it gets to be
              the one oversized, quiet statement in the section. */}
          <Text
            textAlign="center"
            fontSize={{ base: 'lg', md: 'xl' }}
            color="white"
            fontWeight="medium"
            fontStyle="italic"
            lineHeight="1.6"
            maxW="700px"
            mx="auto"
            mb={14}
          >
            “The dashboard doesn't prescribe a course of action — it lets you explore the consequences of different interventions across a range of environmental factors.”
          </Text>

          <Grid templateColumns={{ base: '1fr', md: '1fr 1fr' }} gap={4}>
            {dashboardAudiences.map((card) => (
              <Box key={card.cta} flexShrink={0} p={3} pos="relative">
                <Image src={card.image} objectFit="contain" w="100%" borderRadius="lg" />
                {/* <Box position="absolute" top={6} left={6} bg="blackAlpha.700" borderRadius="lg" px={3} py={1.5} maxW="calc(100% - 48px)">
                  <Text color="white" fontSize="xs" fontWeight="bold" letterSpacing="0.03em" textTransform="uppercase" lineHeight="1.4">
                    {card.audience}
                  </Text>
                </Box> */}
                <Box style={buttonOverlayStyle}>
                  <motion.div
                    style={{ display: 'inline-block' }}
                    initial={{ scale: 1 }}
                    whileInView={{ scale: [1, 1.25, 1] }}
                    viewport={{ once: true, amount: 0.8 }}
                    transition={{ duration: 1.4, times: [0, 0.5, 1], ease: 'easeInOut' }}
                  >
                    <Tooltip
                      label={card.tooltip?.split('\n\n').map((paragraph, i) => (
                        <Text key={i} mt={i > 0 ? 2 : 0}>{paragraph}</Text>
                      ))}
                      isDisabled={!card.tooltip}
                      placement="right"
                      hasArrow
                      bg="whiteAlpha.800"
                      color="gray.800"
                      borderRadius="12px 12px 12px 0"
                      px={4}
                      py={3}
                      fontSize="sm"
                      lineHeight="1.6"
                      maxW="320px"
                    >
                      <Button
                        {...outlinedButtonProps}
                        onClick={() => window.dispatchEvent(new Event(card.event))}
                      >
                        {card.cta}
                      </Button>
                    </Tooltip>
                  </motion.div>
                </Box>
              </Box>
            ))}
          </Grid>
        </Container>
      </Box>

      {/* ── GETTING STARTED ───────────────────────────────────── */}
      <Box bg={colors.darkGray} py={16} px={6}>
        <Container maxW="1200px">
          <Flex gap="12" align="flex-start" justify="center" wrap="wrap">
            <Box textAlign="center" mb={12}>
              <Heading
                {...headingProps}
                as="h2"
                fontSize={{ base: '3xl', md: '4xl' }}
                fontWeight="bold"
                color="white"
              >
                How does it work?
              </Heading>
              
            </Box>
            <motion.div
              style={{ display: 'inline-block' }}
              initial={{ scale: 1 }}
              whileInView={{ scale: [1, 1.25, 1] }}
              viewport={{ once: true, amount: 0.8 }}
              transition={{ duration: 1.4, times: [0, 0.5, 1], ease: 'easeInOut' }}
            >
              <Button
                bg={colors.orange}
                color="white"
                borderRadius="full"
                px={8}
                h="46px"
                fontSize="sm"
                fontWeight="semibold"
                onClick={() => window.dispatchEvent(new Event('dt:restart-tour'))}
                _hover={{ bg: '#D8832A', transform: 'translateY(-1px)' }}
                transition="all 0.2s"
                boxShadow="md"
              >
                Guided Tour
              </Button>
            </motion.div>
          </Flex>

          <Flex gap="12" align="flex-start" justify="center" wrap="wrap">
            <Box flex="1" minW="260px" maxW="480px" mx="auto">
              {/* Screenshot framed like a window, so it reads as "the real tool" rather than a loose image */}
              <Box
                borderRadius="xl"
                overflow="hidden"
                border="1px solid"
                borderColor="whiteAlpha.200"
                boxShadow="0 24px 60px -24px rgba(0,0,0,0.7)"
                bg="#11151c"
              >
                <HStack spacing={1.5} px={3} py={2.5} bg="whiteAlpha.100">
                  <Box w="8px" h="8px" borderRadius="full" bg="whiteAlpha.400" />
                  <Box w="8px" h="8px" borderRadius="full" bg="whiteAlpha.400" />
                  <Box w="8px" h="8px" borderRadius="full" bg="whiteAlpha.400" />
                </HStack>
                <Image src={gettingStartedImage} w="100%" objectFit="contain" />
              </Box>
            </Box>

            <Box flex="1" minW="260px" textAlign="left">
              {/* Connected timeline, colour-coded to match the reference/current/future
                  legend used throughout the dashboard's own dials and charts. */}
              <VStack align="stretch" spacing={0} mb={7}>
                {gettingStartedStages.map((stage, i) => {
                  const isLast = i === gettingStartedStages.length - 1;
                  const stageColor = scenarioColors[stage.id] ?? colors.pastelLightBlue;
                  return (
                    <HStack key={stage.id} align="stretch" spacing={4}>
                      <VStack spacing={0} flexShrink={0} w="12px">
                        <Box
                          w="12px"
                          h="12px"
                          borderRadius="full"
                          bg={stageColor}
                          boxShadow={`0 0 0 4px ${stageColor}2A`}
                          flexShrink={0}
                          mt={1}
                        />
                        {!isLast && <Box w="2px" flex="1" bg="whiteAlpha.200" my={1} />}
                      </VStack>
                      <Box pb={isLast ? 0 : 5}>
                        <Text
                          fontSize="xs"
                          fontWeight="bold"
                          letterSpacing="0.08em"
                          textTransform="uppercase"
                          color={stageColor}
                          mb={1}
                        >
                          {stage.eyebrow}
                        </Text>
                        <Text fontSize="md" color="white" lineHeight="1.7">
                          {stage.description}
                        </Text>
                      </Box>
                    </HStack>
                  );
                })}
              </VStack>

              
            </Box>
          </Flex>
          <br></br>
          <Box>

              <Box
                borderLeft="3px solid"
                borderLeftColor={colors.blue}
                bg="whiteAlpha.50"
                borderRadius="md"
                p={5}
              >
                <Text fontSize="md" color="white"  mb={1}>
                  By comparing these scenarios, users can visualise how vegetation structure, biodiversity, productivity, carbon sequestration and other ecosystem processes are connected, and examine the trade-offs associated with different land management and conservation strategies.
                </Text>
                
              </Box>
          </Box>
        </Container>
      </Box>

      {/* ── FUNDERS & PARTNERS ────────────────────────────── */}
      <Box bg={colors.darkGray} py={16} px={6}>
        <Container maxW="860px" textAlign="center">
          <Heading
            {...headingProps}
            as="h2"
            fontSize={{ base: '3xl', md: '4xl' }}
            fontWeight="bold"
            color="white"
            mb={10}
          >
            Members of Our Ecosystem
          </Heading>

          <Text fontSize="md" color="white" lineHeight="1.75" mb={5}>
            The Landscape Decision Dashboard is developed through a partnership between Future Ecosystems for Africa and ReWild Capital.
          </Text>

          <Box mb={12}>
            <PartnersCarousel />
          </Box>
        </Container>
      </Box>

      <Box h="25px" bg={colors.brightGreen} />

      {/* ── BOTTOM BANNER ─────────────────────────────────── */}
      <Box position="relative">
        <Box position="relative" minH="340px">
          {/* Background image */}
          <Box
            position="absolute"
            inset={0}
            backgroundImage={`url(${tanzaniaImage})`}
            backgroundSize="cover"
            backgroundPosition="center"
          />

          {/* Overlay */}
          <Box position="absolute" inset={0} bg="blackAlpha.700" />

          {/* Content */}
          <Flex
            position="relative"
            direction="column"
            align="center"
            justify="center"
            minH="600px"
            px={6}
            py={16}
            textAlign="center"
            zIndex={1}
          >
            <Heading
              {...headingProps}
              as="h2"
              fontSize={{ base: '2xl', md: '3xl', lg: '4xl' }}
              fontWeight="bold"
              color="white"
              maxW="800px"
              mb={8}
              lineHeight="1.25"
            >
              An Africa-led, Africa-centred program to influence thinking and action in new ways.
            </Heading>

            {/* <Button
              bg={colors.orange}
              color="white"
              borderRadius="full"
              px={8}
              h="46px"
              fontSize="sm"
              fontWeight="semibold"
              onClick={() => onNavigate('about')}
              _hover={{ bg: colors.orangeHover, transform: 'translateY(-1px)' }}
              transition="all 0.2s"
              boxShadow="md"
            >
              Explore Our Library of Resources
            </Button> */}
          </Flex>
        </Box>

        <Box h="25px" bg={colors.blue} />
      </Box>
      
      {/* ── FOOTER ─────────────────────────────────── */}
      <Box position="relative">
            <Flex
            position="relative"
            direction="row"
            align="center"
            justify="center"
            minH="300px"
            px={6}
            py={16}
            textAlign="center"
            zIndex={1}
          >
            <Box
              flexShrink={0}
              p={3}
            >
              <a href='https://futureecosystemsafrica.org/' target="_blank"><Image src={fefaLogog} w={150}  objectFit="contain" /></a>
            </Box>

            <Box
              flexShrink={0}
              p={3}
            >
              <a href='https://rewild.org/' target="_blank"><Image src={rewildLogo} w={150}  objectFit="contain" /></a>
            </Box>

            <Box
              flexShrink={0}
              p={3}
            >
              <a href='https://kartoza.com/' target="_blank"><Image src={kartozaLogo} w={280}  objectFit="contain" /></a>
            </Box>
          </Flex>
      </Box>

    </Box>
  );
}

export default LandingPage;
