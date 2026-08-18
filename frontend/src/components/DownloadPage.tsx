import {
  Box,
  Button,
  Container,
  Flex,
  Heading,
  HStack,
  Icon,
  SimpleGrid,
  Spinner,
  Text,
  VStack,
  useColorModeValue,
  Badge,
} from '@chakra-ui/react';
import { motion } from 'framer-motion';
import {
  FiArrowLeft,
  FiDownload,
  FiPackage,
  FiMonitor,
  FiAlertCircle,
} from 'react-icons/fi';
import { DiWindows, DiLinux, DiApple } from 'react-icons/di';
import type { AppPage } from '../types';
import { useServerInfo, useDatapackDownloadInfo, useExecutablesInfo, type ExecutablePlatformInfo } from '../hooks/useApi';
import mountainLake from '../assets/backgrounds/mountain-lake.webp';

const MotionBox = motion(Box);

function formatBytes(bytes: number): string {
  if (bytes >= 1_073_741_824) return `${(bytes / 1_073_741_824).toFixed(1)} GB`;
  if (bytes >= 1_048_576) return `${(bytes / 1_048_576).toFixed(0)} MB`;
  return `${(bytes / 1024).toFixed(0)} KB`;
}

interface DownloadPageProps {
  onNavigate: (page: AppPage) => void;
}

interface PlatformCardProps {
  icon: React.ElementType;
  platform: string;
  platformKey: string;
  description: string;
  badge?: string;
  delay: number;
  info: ExecutablePlatformInfo | undefined;
  loading: boolean;
}

function PlatformCard({ icon, platform, platformKey, description, badge, delay, info, loading }: PlatformCardProps) {
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
      _hover={{ transform: 'translateY(-4px)', boxShadow: '0 20px 40px -15px rgba(0,0,0,0.3)' }}
      style={{ transition: 'transform 0.2s, box-shadow 0.2s' }}
      display="flex"
      flexDirection="column"
    >
      <VStack align="start" spacing={4} flex={1}>
        <HStack spacing={3} w="100%" justify="space-between">
          <Box p={3} borderRadius="lg" bg="brand.500" color="white">
            <Icon as={icon} boxSize={6} />
          </Box>
          {badge && (
            <Badge colorScheme="teal" variant="subtle" fontSize="xs" borderRadius="full" px={2}>
              {badge}
            </Badge>
          )}
        </HStack>
        <Heading size="md" color="white">{platform}</Heading>
        <Text color="whiteAlpha.700" fontSize="sm" lineHeight="tall" flex={1}>{description}</Text>
      </VStack>

      <Box mt={5}>
        {loading ? (
          <HStack spacing={2} color="whiteAlpha.500">
            <Spinner size="xs" />
            <Text fontSize="xs">Checking…</Text>
          </HStack>
        ) : info?.available ? (
          <>
            <Button
              as="a"
              href={`/api/executables/download/${platformKey}`}
              download={info.filename}
              w="100%"
              leftIcon={<FiDownload />}
              colorScheme="brand"
              variant="solid"
              size="sm"
              mb={2}
            >
              Download for {platform}
            </Button>
            <VStack align="start" spacing={0}>
              {info.filename && (
                <Text fontSize="xs" color="whiteAlpha.400" fontFamily="mono" noOfLines={1} title={info.filename}>
                  {info.filename}
                </Text>
              )}
              {info.size_bytes != null && (
                <Text fontSize="xs" color="whiteAlpha.300">{formatBytes(info.size_bytes)}</Text>
              )}
            </VStack>
          </>
        ) : (
          <HStack spacing={2} color="whiteAlpha.400">
            <Icon as={FiAlertCircle} boxSize={4} flexShrink={0} />
            <Text fontSize="xs">Not configured on this server</Text>
          </HStack>
        )}
      </Box>
    </MotionBox>
  );
}

function DownloadPage({ onNavigate }: DownloadPageProps) {
  const { info } = useServerInfo();
  const { downloadInfo, loading: downloadInfoLoading } = useDatapackDownloadInfo();
  const { executablesInfo, loading: executablesLoading } = useExecutablesInfo();

  const overlayBg = useColorModeValue(
    'linear-gradient(180deg, rgba(17,24,39,0.95) 0%, rgba(17,24,39,0.85) 100%)',
    'linear-gradient(180deg, rgba(17,24,39,0.97) 0%, rgba(17,24,39,0.9) 100%)'
  );
  const sectionBg = useColorModeValue('whiteAlpha.50', 'blackAlpha.300');

  void info;

  const platforms: Omit<PlatformCardProps, 'info' | 'loading'>[] = [
    {
      icon: DiWindows,
      platform: 'Windows',
      platformKey: 'windows',
      description: 'Download the installer for Windows 10 or later (64-bit).',
      badge: 'x64',
      delay: 0.2,
    },
    {
      icon: DiLinux,
      platform: 'Linux',
      platformKey: 'linux',
      description: 'Download the AppImage for most Linux distributions (64-bit).',
      badge: 'x64',
      delay: 0.3,
    },
    {
      icon: DiApple,
      platform: 'macOS',
      platformKey: 'macos',
      description: 'Download the disk image for macOS 12 or later (Apple Silicon & Intel).',
      badge: 'Universal',
      delay: 0.4,
    },
  ];

  return (
    <Box position="relative" w="100%" h="100%" overflow="auto">
      {/* Background */}
      <Box
        position="fixed"
        top={0} left={0} right={0} bottom={0}
        backgroundImage={`url(${mountainLake})`}
        backgroundSize="cover"
        backgroundPosition="center"
        backgroundAttachment="fixed"
        zIndex={0}
      />
      <Box
        position="fixed"
        top={0} left={0} right={0} bottom={0}
        bg={overlayBg}
        zIndex={1}
      />

      {/* Content */}
      <Box position="relative" zIndex={2} pb={16}>
        <Container maxW="container.lg" pt={8}>
          {/* Back button */}
          <MotionBox initial={{ opacity: 0, x: -20 }} animate={{ opacity: 1, x: 0 }} transition={{ duration: 0.4 }}>
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

          {/* Hero */}
          <MotionBox
            textAlign="center"
            mb={12}
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.6 }}
          >
            <Box mb={4} display="flex" justifyContent="center">
              <Box p={4} borderRadius="2xl" bg="brand.500" color="white" display="inline-flex">
                <Icon as={FiDownload} boxSize={10} />
              </Box>
            </Box>
            <Heading as="h1" fontSize={{ base: '3xl', md: '5xl' }} color="white" mb={4} fontWeight="bold">
              Download Decision Theatre
            </Heading>
            <Text fontSize={{ base: 'md', md: 'lg' }} color="whiteAlpha.800" maxW="600px" mx="auto" lineHeight="tall">
              Run Decision Theatre as a desktop application. Download the executable for your
              platform and the data pack to get started.
            </Text>
          </MotionBox>

          {/* Platform downloads */}
          <MotionBox mb={4} initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.4, delay: 0.15 }}>
            <HStack spacing={3} mb={6}>
              <Icon as={FiMonitor} color="brand.300" boxSize={5} />
              <Heading size="md" color="white">Desktop Application</Heading>
            </HStack>
          </MotionBox>

          <SimpleGrid columns={{ base: 1, md: 3 }} spacing={5} mb={12}>
            {platforms.map((p) => (
              <PlatformCard
                key={p.platformKey}
                {...p}
                info={executablesInfo?.[p.platformKey as keyof typeof executablesInfo]}
                loading={executablesLoading}
              />
            ))}
          </SimpleGrid>

          {/* Datapack download */}
          <MotionBox
            bg={sectionBg}
            backdropFilter="blur(10px)"
            borderRadius="2xl"
            p={{ base: 8, md: 10 }}
            mb={12}
            border="1px solid"
            borderColor="whiteAlpha.200"
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.6, delay: 0.5 }}
          >
            <VStack align="start" spacing={5}>
              <HStack spacing={3}>
                <Box p={3} borderRadius="lg" bg="accent.500" color="white">
                  <Icon as={FiPackage} boxSize={6} />
                </Box>
                <VStack align="start" spacing={0}>
                  <Heading size="md" color="white">Data Pack</Heading>
                  <Text color="whiteAlpha.600" fontSize="xs">Required to run the application</Text>
                </VStack>
              </HStack>

              <Text color="whiteAlpha.800" lineHeight="tall">
                The data pack contains the spatial datasets, map tiles, and scenario data needed
                by Decision Theatre. It is a large archive that you install once via
                the in-app setup guide.
              </Text>

              <SimpleGrid columns={{ base: 1, md: 2 }} spacing={4} w="100%">
                <Box
                  bg="whiteAlpha.50"
                  borderRadius="lg"
                  p={4}
                  border="1px solid"
                  borderColor="whiteAlpha.100"
                >
                  <Text color="whiteAlpha.600" fontSize="xs" fontWeight="semibold" mb={1} textTransform="uppercase" letterSpacing="wide">
                    Contents
                  </Text>
                  <VStack align="start" spacing={1}>
                    {['Map tiles (.mbtiles)', 'Catchment boundaries (.gpkg)', 'Scenario raster data', 'Attribute metadata (.csv)'].map((item) => (
                      <HStack key={item} spacing={2}>
                        <Box w={1.5} h={1.5} borderRadius="full" bg="brand.400" flexShrink={0} />
                        <Text color="whiteAlpha.800" fontSize="sm">{item}</Text>
                      </HStack>
                    ))}
                  </VStack>
                </Box>

                <Flex direction="column" justify="center" align="start" gap={3}>
                  {downloadInfoLoading ? (
                    <HStack spacing={3} color="whiteAlpha.600">
                      <Spinner size="sm" />
                      <Text fontSize="sm">Checking availability…</Text>
                    </HStack>
                  ) : downloadInfo?.available ? (
                    <>
                      <Button
                        as="a"
                        href="/api/datapack/download"
                        download={downloadInfo.filename}
                        w="100%"
                        leftIcon={<FiDownload />}
                        colorScheme="orange"
                        size="md"
                        _hover={{ transform: 'translateY(-1px)' }}
                        transition="all 0.2s"
                      >
                        Download Data Pack
                      </Button>
                      <VStack align="start" spacing={0}>
                        <Text color="whiteAlpha.500" fontSize="xs" fontFamily="mono" noOfLines={1} title={downloadInfo.filename}>
                          {downloadInfo.filename}
                        </Text>
                        {downloadInfo.size_bytes != null && (
                          <Text color="whiteAlpha.400" fontSize="xs">
                            {formatBytes(downloadInfo.size_bytes)}
                          </Text>
                        )}
                      </VStack>
                    </>
                  ) : (
                    <HStack
                      spacing={3}
                      p={4}
                      bg="whiteAlpha.50"
                      borderRadius="lg"
                      border="1px solid"
                      borderColor="whiteAlpha.100"
                      w="100%"
                    >
                      <Icon as={FiAlertCircle} color="orange.300" boxSize={5} flexShrink={0} />
                      <Text color="whiteAlpha.600" fontSize="sm" lineHeight="tall">
                        No data pack is configured for download on this server. Contact your
                        administrator to set up the download.
                      </Text>
                    </HStack>
                  )}
                </Flex>
              </SimpleGrid>
            </VStack>
          </MotionBox>

          {/* Getting started */}
          <MotionBox
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.6, delay: 0.65 }}
          >
            <Heading size="md" color="white" mb={5}>Getting Started</Heading>
            <VStack
              align="stretch"
              spacing={3}
              bg={sectionBg}
              backdropFilter="blur(10px)"
              borderRadius="xl"
              p={6}
              border="1px solid"
              borderColor="whiteAlpha.200"
            >
              {[
                { step: '1', text: 'Download the executable for your operating system above.' },
                { step: '2', text: 'Download the data pack from this page.' },
                { step: '3', text: 'Launch the application — it will open the setup guide automatically.' },
                { step: '4', text: 'In the setup guide, select the downloaded data pack archive to install it.' },
                { step: '5', text: 'Once the data pack is installed, the application is ready to use.' },
              ].map(({ step, text }) => (
                <HStack key={step} spacing={4} align="start">
                  <Box
                    flexShrink={0}
                    w={7}
                    h={7}
                    borderRadius="full"
                    bg="brand.500"
                    color="white"
                    display="flex"
                    alignItems="center"
                    justifyContent="center"
                    fontSize="sm"
                    fontWeight="bold"
                  >
                    {step}
                  </Box>
                  <Text color="whiteAlpha.800" fontSize="sm" pt={1} lineHeight="tall">{text}</Text>
                </HStack>
              ))}
            </VStack>
          </MotionBox>
        </Container>
      </Box>
    </Box>
  );
}

export default DownloadPage;
