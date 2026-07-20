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
} from '@chakra-ui/react';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { AppPage } from '../types';
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
import ourMissionImage from '../assets/our_mission.png';
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
              Step into a powerful decision theatre where science meets strategy.
            </Text>

            <Text
              fontSize={{ base: 'sm', md: 'md' }}
              color="whiteAlpha.900"
              maxW="560px"
              mb={9}
              lineHeight="1.7"
            >
              This interactive tool brings together real-world data and ecosystem response to reveal the complex relationships between vegetation structure, biodiversity, carbon storage and vital ecological processes.
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
            Our Mission
          </Heading>
          <Flex gap="10" align="center" justify="center" wrap="wrap">
            <Box flex="1" minW="260px">
              <Image src={ourMissionImage} w="100%" objectFit="contain" mx="auto" mb={6} />
            </Box>
            <Box flex="1" minW="260px" textAlign="left">
              <Text fontSize="md" color="white" lineHeight="1.75" mb={5}>
                To empower land owners, local communities, and society to bring together real-world data and ecosystem response models for informed decision making and conservation.
              </Text>
              <Text fontSize="md" color="white" lineHeight="1.75" mb={5}>
                Help guide our landscapes into nature-supporting paths by interacting with our tool to understand the constraints and opportunities in different landscapes across Africa.
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
        <Container maxW="860px">
          <Heading
            {...headingProps}
            as="h2"
            fontSize={{ base: '3xl', md: '4xl' }}
            fontWeight="bold"
            color="white"
            textAlign="center"
            mb={10}
          >
            From Data to Progress
          </Heading>

          <Text textAlign="center" fontSize="md" color="white" lineHeight="1.75" mb={5}>
            Use cases for the Landscape Decision Dashboard
          </Text>

          <Grid templateColumns={{ base: '1fr', md: '1fr 1fr' }} gap={4}>
            <Box
              flexShrink={0}
              p={3}
              pos="relative"
            >
              <Image src={landOwnerImage}  objectFit="contain"  w="100%"/>
              {/* <Box style={imageOverlayLabelStyle}>
                <Text 
                color='gray.900' 
                fontSize={'xs'}>
                  Land owners, conservation agencies, managers
                </Text>
              </Box> */}
              <Box style={buttonOverlayStyle}>
                <Button
                  {...outlinedButtonProps}
                  onClick={() => window.dispatchEvent(new Event('dt:start-munywana-demo'))}
                >
                  Explore Conservation Futures
                </Button>
              </Box>
            </Box>

            <Box
              flexShrink={0}
              p={3}
              pos="relative"
            >
              <Image src={ruralCommunityImage}  objectFit="contain"  w="100%"/>
              {/* <Box style={imageOverlayLabelStyle}>
                <Text 
                color='gray.900' 
                fontSize={'xs'}>
                  Rural communities
                </Text>
              </Box> */}
              <Box style={buttonOverlayStyle}>
                <Button
                  {...outlinedButtonProps}
                  onClick={() => window.dispatchEvent(new Event('dt:start-viphya-demo'))}
                >
                  Explore Shared Landscapes
                </Button>
              </Box>
            </Box>

            <Box
              flexShrink={0}
              p={3}
              pos="relative"
            >
              <Image src={localGovernmentImage}  objectFit="contain"  w="100%"/>
              {/* <Box style={imageOverlayLabelStyle}>
                <Text 
                color='gray.900' 
                fontSize={'xs'}>
                  Local government agencies and tribal leadership
                </Text>
              </Box> */}
              <Box style={buttonOverlayStyle}>
                <Button
                  {...outlinedButtonProps}
                  onClick={() => window.dispatchEvent(new Event('dt:start-shaihills-demo'))}
                >
                  Explore Policy Impacts
                </Button>
              </Box>
            </Box>

            <Box
              flexShrink={0}
              p={3}
              pos="relative"
            >
              <Image src={futurePossibilitiesImage}  objectFit="contain" w="100%"/>
              {/* <Box style={imageOverlayLabelStyle}>
                <Text 
                color='gray.900' 
                fontSize={'xs'}>
                  School children, artists, public citizens
                </Text>
              </Box> */}
              <Box style={buttonOverlayStyle}>
                <Button {...outlinedButtonProps}>
                  Explore Future Possibilities
                </Button>
              </Box>
            </Box>
          </Grid>
        </Container>
      </Box>

      {/* ── GETTING STARTED ───────────────────────────────────── */}
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
            Getting Started
          </Heading>
          <Flex gap="10" align="center" justify="center" wrap="wrap">
            <Box flex="1" minW="260px">
              <Image src={gettingStartedImage} w="100%" objectFit="contain" mx="auto" mb={6} />
            </Box>
            <Box flex="1" minW="260px" textAlign="left">
              <Text fontSize="lg" color="white" lineHeight="1.75" mb={1} fontWeight={"bold"}>
                Understand Your Results — and What to Do Next
              </Text>
              <Text fontSize="md" color="white" lineHeight="1.75" mb={5}>
                This tool is designed to give you clear, actionable insight — not just numbers. It helps you compare where you are now, where you want to be, and what “good” looks like, so you can make informed decisions with confidence.
              </Text>

              <Text fontSize="lg" color="white" lineHeight="1.75" mb={1} fontWeight={"bold"}>
                Not sure how to read your results?
              </Text>
              <Text fontSize="md" color="white" lineHeight="1.75" mb={5}>
                We've put together a simple, step-by-step guide. Read to learn more.
              </Text>

              <Button
                bg={colors.orange}
                color="white"
                borderRadius="full"
                px={8}
                h="46px"
                w="280px"
                fontSize="sm"
                fontWeight="semibold"
                _hover={{ bg: '#D8832A', transform: 'translateY(-1px)' }}
                transition="all 0.2s"
                boxShadow="md"
              >
                From A to Z
              </Button>
            </Box>
          </Flex>
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

            <Button
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
            </Button>
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

          <Flex justify="center" pb={6}>
            <Button
              variant="ghost"
              size="sm"
              color="whiteAlpha.600"
              _hover={{ color: 'white' }}
              onClick={() => window.dispatchEvent(new Event('dt:restart-tour'))}
            >
              Take the tour
            </Button>
          </Flex>
      </Box>

    </Box>
  );
}

export default LandingPage;
