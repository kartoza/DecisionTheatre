import {
  Box,
  Button,
  Container,
  Flex,
  Grid,
  Heading,
  HStack,
  Image,
  Text,
  VStack,
} from '@chakra-ui/react';
import type { AppPage } from '../types';
import { colors } from '../styles/colors';

import witsLogo from '../assets/wits_logo.png';
import apEsLogo from '../assets/ap_es_logo.png';
import gciLogo from '../assets/gci_logo.png';
import rcoLogo from '../assets/rco_logo.png';
import backgroundImage1 from '../assets/image_1.png';
import backgroundImage2 from '../assets/image_2.png';
import spatialAnalysisImage from '../assets/AiOutlineFundView.png';
import collaborativeDecisionImage from '../assets/GoOrganization.png';
import scenarioModellingImage from '../assets/GoGraph.png';
import openSourceImage from '../assets/HiCode.png';


const FEATURES = [
  {
    img: spatialAnalysisImage,
    title: 'Spatial Analysis',
    desc: 'Location-based data is analysed to reveal patterns, relationships, and trends within complex systems.',
  },
  {
    img: collaborativeDecisionImage,
    title: 'Collaborative Decision Making',
    desc: 'Teams use shared data and insights to make informed decisions together across departments and disciplines.',
  },
  {
    img: scenarioModellingImage,
    title: 'Scenario Modelling',
    desc: 'Different future outcomes are explored by simulating how variables may change under specific conditions.',
  },
  {
    img: openSourceImage,
    title: 'Open Source',
    desc: 'Open-source tools provide flexible, transparent solutions that can be adapted to meet changing project needs.',
  },
];

interface LandingPageProps {
  onNavigate: (page: AppPage) => void;
}


function LandingPage({ onNavigate }: LandingPageProps) {
  return (
    <Box w="100%" h="100%" overflowY="auto" bg="white" color="gray.900">
      <Box h="25px" bg={colors.pastelGray} />

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
          <Box position="absolute" inset={0} bg="blackAlpha.500" />

          {/* Content */}
          <Flex
            position="relative"
            direction="column"
            align="center"
            justify="center"
            minH="440px"
            px={6}
            py={20}
            textAlign="center"
            zIndex={1}
          >
            <Heading
              as="h1"
              fontSize={{ base: '2xl', md: '3xl', lg: '4xl' }}
              fontWeight="bold"
              color="white"
              mb={5}
              maxW="680px"
              lineHeight="1.25"
            >
              Welcome to the Landscape Decision Tool
            </Heading>

            <Text
              fontSize={{ base: 'sm', md: 'md' }}
              color="whiteAlpha.900"
              maxW="560px"
              mb={9}
              lineHeight="1.7"
            >
              Step into a powerful decision theatre where science meets strategy.
              This interactive tool brings together real-world data and ecosystem
              response models to reveal the complex relationships between vegetation
              structure, productivity, carbon storage, and vital ecological processes.
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
        <Box h="25px" bg={colors.pastelLightOrange} />
      </Box>

      {/* ── OUR MISSION ───────────────────────────────────── */}
      <Box bg="white" py={16} px={6}>
        <Container maxW="660px" textAlign="center">
          <Heading
            as="h2"
            fontSize={{ base: '2xl', md: '3xl' }}
            fontWeight="bold"
            color="gray.900"
            mb={6}
          >
            Our Mission
          </Heading>
          <Text fontSize="md" color="gray.700" lineHeight="1.75">
            To empower land owners, local communities, and society as a whole with
            tools that bring together real-world data and ecosystem response models,
            for informed decision making and assisting in conservation efforts.
          </Text>
        </Container>
      </Box>

      {/* ── ANALYSE SCENARIOS ─────────────────────────────── */}
      <Box bg="white" py={10} pb={20} px={6}>
        <Container maxW="860px">
          <Heading
            as="h2"
            fontSize={{ base: '2xl', md: '3xl' }}
            fontWeight="bold"
            color="gray.900"
            textAlign="center"
            mb={10}
          >
            Analyse Scenarios
          </Heading>

          <Grid templateColumns={{ base: '1fr', md: '1fr 1fr' }} gap={4}>
            {FEATURES.map((item, i) => (
              <Box
                key={i}
                bg={colors.pastelLightGreen}
                borderRadius="lg"
                p={6}
              >
                <HStack spacing={4} align="start">
                  <Box
                    flexShrink={0}
                    p={3}
                  >
                    <Image src={item.img} boxSize={10} objectFit="contain" />
                  </Box>
                  <VStack align="start" spacing={1}>
                    <Text fontWeight="bold" fontSize="md" color="gray.900">
                      {item.title}
                    </Text>
                    <Text fontSize="sm" color="gray.700" lineHeight="1.65">
                      {item.desc}
                    </Text>
                  </VStack>
                </HStack>
              </Box>
            ))}
          </Grid>
        </Container>
      </Box>

      {/* ── FUNDERS & PARTNERS ────────────────────────────── */}
      <Box bg="white" py={16} px={6}>
        <Container maxW="860px" textAlign="center">
          <Heading
            as="h2"
            fontSize={{ base: '2xl', md: '3xl' }}
            fontWeight="bold"
            color="gray.900"
            mb={4}
          >
            Funders &amp; Partners
          </Heading>
          <Text fontSize="md" color="gray.600" mb={12}>
            Our funders and partners help make the impossible possible.
          </Text>

          <HStack
            spacing={0}
            justify="center"
            flexWrap="wrap"
            gap={{ base: 8, md: 14 }}
            mb={12}
          >
            <Image src={rcoLogo}  h="100px" objectFit="contain" />
            <Image src={gciLogo}  h="100px" objectFit="contain" />
            <Image src={apEsLogo} h="100px" objectFit="contain" />
            <Image src={witsLogo} h="100px" objectFit="contain" />
          </HStack>

          <Button
            variant="outline"
            borderColor="gray.400"
            color="gray.700"
            borderRadius="full"
            px={8}
            h="44px"
            fontSize="sm"
            onClick={() => onNavigate('about')}
            _hover={{ bg: 'gray.50', borderColor: 'gray.600' }}
          >
            Read More About How We Work
          </Button>
        </Container>
      </Box>

      <Box h="25px" bg={colors.pastelLightGreen} />

      {/* ── BOTTOM BANNER ─────────────────────────────────── */}
      <Box position="relative">
        <Box position="relative" minH="340px">
          {/* Background image */}
          <Box
            position="absolute"
            inset={0}
            backgroundImage={`url(${backgroundImage2})`}
            backgroundSize="cover"
            backgroundPosition="center"
          />

          {/* Overlay */}
          <Box position="absolute" inset={0} bg="blackAlpha.500" />

          {/* Content */}
          <Flex
            position="relative"
            direction="column"
            align="center"
            justify="center"
            minH="340px"
            px={6}
            py={16}
            textAlign="center"
            zIndex={1}
          >
            <Heading
              as="h2"
              fontSize={{ base: '2xl', md: '3xl', lg: '4xl' }}
              fontWeight="bold"
              color="white"
              maxW="680px"
              mb={8}
              lineHeight="1.25"
            >
              An Africa-led, Africa-centred program to influence thinking and
              action in new ways.
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

        <Box h="25px" bg={colors.pastelLightBlue} />
      </Box>

    </Box>
  );
}

export default LandingPage;
