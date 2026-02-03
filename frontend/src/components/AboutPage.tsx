import {
  Box,
  Button,
  Container,
  Divider,
  Flex,
  Heading,
  HStack,
  Icon,
  Link,
  SimpleGrid,
  Text,
  VStack,
  useColorModeValue,
} from '@chakra-ui/react';
import { motion } from 'framer-motion';
import {
  FiArrowLeft,
  FiBook,
  FiCode,
  FiExternalLink,
  FiGithub,
  FiHeart,
  FiMapPin,
  FiUsers,
} from 'react-icons/fi';
import type { AppPage } from '../types';

const MotionBox = motion(Box);

interface AboutPageProps {
  onNavigate: (page: AppPage) => void;
}

interface FeatureCardProps {
  icon: React.ElementType;
  title: string;
  description: string;
  delay: number;
}

function FeatureCard({ icon, title, description, delay }: FeatureCardProps) {
  const cardBg = useColorModeValue('whiteAlpha.100', 'whiteAlpha.50');
  const borderColor = useColorModeValue('whiteAlpha.300', 'whiteAlpha.200');

  return (
    <MotionBox
      bg={cardBg}
      backdropFilter="blur(10px)"
      borderRadius="xl"
      p={6}
      border="1px solid"
      borderColor={borderColor}
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.5, delay }}
      _hover={{
        transform: 'translateY(-4px)',
        boxShadow: '0 20px 40px -15px rgba(0,0,0,0.3)',
      }}
      style={{ transition: 'transform 0.2s, box-shadow 0.2s' }}
    >
      <VStack align="start" spacing={4}>
        <Box
          p={3}
          borderRadius="lg"
          bg="brand.500"
          color="white"
        >
          <Icon as={icon} boxSize={6} />
        </Box>
        <Heading size="md" color="white">
          {title}
        </Heading>
        <Text color="whiteAlpha.800" fontSize="sm" lineHeight="tall">
          {description}
        </Text>
      </VStack>
    </MotionBox>
  );
}

function AboutPage({ onNavigate }: AboutPageProps) {
  const overlayBg = useColorModeValue(
    'linear-gradient(180deg, rgba(17,24,39,0.95) 0%, rgba(17,24,39,0.85) 100%)',
    'linear-gradient(180deg, rgba(17,24,39,0.97) 0%, rgba(17,24,39,0.9) 100%)'
  );
  const sectionBg = useColorModeValue('whiteAlpha.50', 'blackAlpha.300');

  const features = [
    {
      icon: FiMapPin,
      title: 'Spatial Analysis',
      description:
        'Lorem ipsum dolor sit amet, consectetur adipiscing elit. Visualize and analyze geographic data with interactive maps and advanced spatial tools.',
    },
    {
      icon: FiUsers,
      title: 'Collaborative Decision Making',
      description:
        'Sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. Facilitate stakeholder engagement and collaborative planning processes.',
    },
    {
      icon: FiBook,
      title: 'Scenario Modeling',
      description:
        'Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris. Compare reference, current, and future scenarios side by side.',
    },
    {
      icon: FiCode,
      title: 'Open Source',
      description:
        'Duis aute irure dolor in reprehenderit in voluptate velit esse cillum dolore. Built with transparency and community collaboration in mind.',
    },
  ];

  const citations = [
    {
      authors: 'Lorem I., Ipsum D., Dolor S.',
      year: 2024,
      title: 'Landscape Decision Support Systems: A Comprehensive Review',
      journal: 'Journal of Environmental Planning, 45(3), 234-256',
    },
    {
      authors: 'Amet C., Consectetur A.',
      year: 2023,
      title: 'Participatory Approaches to Sustainable Land Use Planning',
      journal: 'Ecological Economics, 189, 107-123',
    },
    {
      authors: 'Adipiscing E., Elit S., Tempor I.',
      year: 2023,
      title: 'GIS-Based Multi-Criteria Analysis for Environmental Assessment',
      journal: 'Computers, Environment and Urban Systems, 98, 101-118',
    },
  ];

  return (
    <Box
      position="relative"
      w="100%"
      h="100%"
      overflow="auto"
    >
      {/* Background */}
      <Box
        position="fixed"
        top={0}
        left={0}
        right={0}
        bottom={0}
        backgroundImage="url('https://images.unsplash.com/photo-1470071459604-3b5ec3a7fe05?auto=format&fit=crop&w=2000&q=80')"
        backgroundSize="cover"
        backgroundPosition="center"
        backgroundAttachment="fixed"
        zIndex={0}
      />
      <Box
        position="fixed"
        top={0}
        left={0}
        right={0}
        bottom={0}
        bg={overlayBg}
        zIndex={1}
      />

      {/* Content */}
      <Box position="relative" zIndex={2} pb={16}>
        <Container maxW="container.lg" pt={8}>
          {/* Back button */}
          <MotionBox
            initial={{ opacity: 0, x: -20 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ duration: 0.4 }}
          >
            <Button
              variant="ghost"
              colorScheme="whiteAlpha"
              color="white"
              leftIcon={<FiArrowLeft />}
              onClick={() => onNavigate('landing')}
              mb={8}
              _hover={{ bg: 'whiteAlpha.200' }}
            >
              Back to Home
            </Button>
          </MotionBox>

          {/* Hero section */}
          <MotionBox
            textAlign="center"
            mb={16}
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.6 }}
          >
            <Heading
              as="h1"
              fontSize={{ base: '3xl', md: '5xl' }}
              color="white"
              mb={6}
              fontWeight="bold"
            >
              About the{' '}
              <Text as="span" bgGradient="linear(to-r, brand.300, accent.300)" bgClip="text">
                Project
              </Text>
            </Heading>
            <Text
              fontSize={{ base: 'lg', md: 'xl' }}
              color="whiteAlpha.800"
              maxW="700px"
              mx="auto"
              lineHeight="tall"
            >
              Lorem ipsum dolor sit amet, consectetur adipiscing elit. The Landscape Decision
              Theatre is an innovative platform designed to support sustainable land use planning
              through interactive visualization and collaborative analysis tools.
            </Text>
          </MotionBox>

          {/* Feature cards */}
          <SimpleGrid columns={{ base: 1, md: 2 }} spacing={6} mb={16}>
            {features.map((feature, index) => (
              <FeatureCard
                key={feature.title}
                icon={feature.icon}
                title={feature.title}
                description={feature.description}
                delay={0.2 + index * 0.1}
              />
            ))}
          </SimpleGrid>

          {/* Mission section */}
          <MotionBox
            bg={sectionBg}
            backdropFilter="blur(10px)"
            borderRadius="2xl"
            p={{ base: 8, md: 12 }}
            mb={16}
            border="1px solid"
            borderColor="whiteAlpha.200"
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.6, delay: 0.6 }}
          >
            <VStack spacing={6} align="start">
              <HStack spacing={3}>
                <Icon as={FiHeart} color="accent.400" boxSize={6} />
                <Heading size="lg" color="white">
                  Our Mission
                </Heading>
              </HStack>
              <Text color="whiteAlpha.800" fontSize="lg" lineHeight="tall">
                Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor
                incididunt ut labore et dolore magna aliqua. Ut enim ad minim veniam, quis nostrud
                exercitation ullamco laboris nisi ut aliquip ex ea commodo consequat. Duis aute
                irure dolor in reprehenderit in voluptate velit esse cillum dolore eu fugiat nulla
                pariatur.
              </Text>
              <Text color="whiteAlpha.700" lineHeight="tall">
                Excepteur sint occaecat cupidatat non proident, sunt in culpa qui officia deserunt
                mollit anim id est laborum. Sed ut perspiciatis unde omnis iste natus error sit
                voluptatem accusantium doloremque laudantium, totam rem aperiam, eaque ipsa quae
                ab illo inventore veritatis et quasi architecto beatae vitae dicta sunt explicabo.
              </Text>
            </VStack>
          </MotionBox>

          {/* Funders section */}
          <MotionBox
            mb={16}
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.6, delay: 0.7 }}
          >
            <Heading size="lg" color="white" mb={6} textAlign="center">
              Funders & Partners
            </Heading>
            <Flex
              justify="center"
              align="center"
              gap={8}
              flexWrap="wrap"
              p={8}
              bg={sectionBg}
              backdropFilter="blur(10px)"
              borderRadius="xl"
              border="1px solid"
              borderColor="whiteAlpha.200"
            >
              {['Organization A', 'Foundation B', 'Institute C', 'University D'].map((org) => (
                <Box
                  key={org}
                  px={6}
                  py={4}
                  bg="whiteAlpha.100"
                  borderRadius="lg"
                  color="whiteAlpha.800"
                  fontWeight="medium"
                  _hover={{ bg: 'whiteAlpha.200' }}
                  transition="all 0.2s"
                >
                  {org}
                </Box>
              ))}
            </Flex>
          </MotionBox>

          {/* Citations section */}
          <MotionBox
            mb={16}
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.6, delay: 0.8 }}
          >
            <Heading size="lg" color="white" mb={6}>
              Citations & References
            </Heading>
            <VStack
              spacing={4}
              align="stretch"
              bg={sectionBg}
              backdropFilter="blur(10px)"
              borderRadius="xl"
              p={6}
              border="1px solid"
              borderColor="whiteAlpha.200"
            >
              {citations.map((citation, index) => (
                <Box key={index}>
                  <Text color="whiteAlpha.900" fontSize="sm">
                    {citation.authors} ({citation.year}).{' '}
                    <Text as="span" fontStyle="italic">
                      {citation.title}
                    </Text>
                    . {citation.journal}.
                  </Text>
                  {index < citations.length - 1 && (
                    <Divider borderColor="whiteAlpha.200" mt={4} />
                  )}
                </Box>
              ))}
            </VStack>
          </MotionBox>

          {/* Open source section */}
          <MotionBox
            textAlign="center"
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.6, delay: 0.9 }}
          >
            <Box
              bg="linear-gradient(135deg, rgba(43,176,237,0.2) 0%, rgba(255,152,0,0.2) 100%)"
              backdropFilter="blur(10px)"
              borderRadius="2xl"
              p={{ base: 8, md: 12 }}
              border="1px solid"
              borderColor="whiteAlpha.300"
            >
              <Icon as={FiGithub} boxSize={12} color="white" mb={4} />
              <Heading size="lg" color="white" mb={4}>
                Open Source
              </Heading>
              <Text color="whiteAlpha.800" fontSize="lg" mb={6} maxW="600px" mx="auto">
                Lorem ipsum dolor sit amet, consectetur adipiscing elit. This project is
                open source and available under the MIT License. We welcome contributions
                from the community.
              </Text>
              <HStack justify="center" spacing={4}>
                <Link
                  href="https://github.com/kartoza/decision-theatre"
                  isExternal
                  _hover={{ textDecoration: 'none' }}
                >
                  <Button
                    size="lg"
                    leftIcon={<FiGithub />}
                    rightIcon={<FiExternalLink />}
                    colorScheme="whiteAlpha"
                    variant="outline"
                    color="white"
                    _hover={{ bg: 'whiteAlpha.200' }}
                  >
                    View on GitHub
                  </Button>
                </Link>
              </HStack>
            </Box>
          </MotionBox>
        </Container>
      </Box>
    </Box>
  );
}

export default AboutPage;
