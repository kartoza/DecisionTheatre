import {
  Box,
  Button,
  Container,
  Flex,
  FormControl,
  FormLabel,
  Heading,
  Icon,
  Input,
  SimpleGrid,
  Text,
  Textarea,
  VStack,
  useColorModeValue,
  useToast,
  HStack,
  Badge,
  Progress,
} from '@chakra-ui/react';
import { motion, AnimatePresence } from 'framer-motion';
import { useCallback, useRef, useState } from 'react';
import {
  FiArrowLeft,
  FiArrowRight,
  FiUpload,
  FiEdit3,
  FiLayers,
  FiMapPin,
  FiFile,
  FiFolderPlus,
} from 'react-icons/fi';
import type { AppPage, Site, SiteCreationMethod, BoundingBox } from '../types';
import SiteCreationMap from './SiteCreationMap';
import { SITE_COLORS } from '../hooks/usePhysicsPolygon';

const MotionBox = motion(Box);
const MotionFlex = motion(Flex);

interface SiteCreationPageProps {
  onNavigate: (page: AppPage) => void;
  onSiteCreated: (site: Site) => void;
  initialExtent?: { center: [number, number]; zoom: number };
}

interface CreationMethodOption {
  id: SiteCreationMethod;
  icon: typeof FiUpload;
  title: string;
  description: string;
  color: string;
  gradient: string;
}

const creationMethods: CreationMethodOption[] = [
  {
    id: 'shapefile',
    icon: FiFile,
    title: 'Upload Shapefile',
    description: 'Import a .zip containing .shp, .shx, .dbf files',
    color: SITE_COLORS.primary,
    gradient: 'linear(to-br, cyan.400, blue.500)',
  },
  {
    id: 'geojson',
    icon: FiUpload,
    title: 'Upload GeoJSON',
    description: 'Import a .geojson or .json boundary file',
    color: SITE_COLORS.secondary,
    gradient: 'linear(to-br, purple.400, pink.500)',
  },
  {
    id: 'drawn',
    icon: FiEdit3,
    title: 'Draw Polygon',
    description: 'Interactively draw your site boundary on the map',
    color: SITE_COLORS.accent,
    gradient: 'linear(to-br, yellow.400, orange.500)',
  },
  {
    id: 'catchments',
    icon: FiLayers,
    title: 'Select Catchments',
    description: 'Click to select catchments, we\'ll dissolve the boundary',
    color: SITE_COLORS.glow,
    gradient: 'linear(to-br, green.400, teal.500)',
  },
];

type Step = 'method' | 'geometry' | 'details' | 'project';

function SiteCreationPage({ onNavigate, onSiteCreated, initialExtent }: SiteCreationPageProps) {
  const [step, setStep] = useState<Step>('method');
  const [selectedMethod, setSelectedMethod] = useState<SiteCreationMethod | null>(null);
  const [geometry, setGeometry] = useState<GeoJSON.Geometry | null>(null);
  const [boundingBox, setBoundingBox] = useState<BoundingBox | null>(null);
  const [selectedCatchmentIds, setSelectedCatchmentIds] = useState<string[]>([]);
  const [siteName, setSiteName] = useState('');
  const [siteDescription, setSiteDescription] = useState('');
  const [createdSite, setCreatedSite] = useState<Site | null>(null);
  const [projectTitle, setProjectTitle] = useState('');
  const [projectDescription, setProjectDescription] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [isProcessing, setIsProcessing] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const toast = useToast();

  const cardBg = useColorModeValue('whiteAlpha.100', 'whiteAlpha.50');
  const borderColor = useColorModeValue('whiteAlpha.300', 'whiteAlpha.200');
  const inputBg = useColorModeValue('whiteAlpha.100', 'blackAlpha.300');

  const handleMethodSelect = useCallback((method: SiteCreationMethod) => {
    setSelectedMethod(method);

    // For file uploads, trigger file input immediately
    if (method === 'shapefile' || method === 'geojson') {
      setTimeout(() => fileInputRef.current?.click(), 100);
    } else {
      setStep('geometry');
    }
  }, []);

  const handleFileUpload = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setIsProcessing(true);
    setUploadProgress(0);

    try {
      // Simulate upload progress
      const progressInterval = setInterval(() => {
        setUploadProgress(prev => Math.min(prev + 10, 90));
      }, 100);

      let geojson: GeoJSON.FeatureCollection | GeoJSON.Feature | GeoJSON.Geometry;

      if (selectedMethod === 'shapefile') {
        // Parse shapefile using shpjs
        const shp = await import('shpjs');
        const buffer = await file.arrayBuffer();
        geojson = await shp.default(buffer) as GeoJSON.FeatureCollection;
      } else {
        // Parse GeoJSON
        const text = await file.text();
        geojson = JSON.parse(text);
      }

      clearInterval(progressInterval);
      setUploadProgress(100);

      // Extract geometry
      let extractedGeometry: GeoJSON.Geometry;
      if ('features' in geojson && geojson.features.length > 0) {
        // FeatureCollection - merge all geometries
        if (geojson.features.length === 1) {
          extractedGeometry = geojson.features[0].geometry;
        } else {
          // Create a GeometryCollection
          extractedGeometry = {
            type: 'GeometryCollection',
            geometries: geojson.features.map(f => f.geometry),
          };
        }
      } else if ('geometry' in geojson) {
        extractedGeometry = (geojson as GeoJSON.Feature).geometry;
      } else if ('coordinates' in geojson) {
        // It's a raw geometry
        extractedGeometry = geojson as GeoJSON.Geometry;
      } else {
        throw new Error('Could not extract geometry from file');
      }

      // Compute bounding box
      const bbox = computeBoundingBox(extractedGeometry);

      setGeometry(extractedGeometry);
      setBoundingBox(bbox);
      setStep('geometry');

      toast({
        title: 'File loaded successfully',
        description: 'Your boundary has been imported',
        status: 'success',
        duration: 3000,
      });
    } catch (error) {
      console.error('File processing error:', error);
      toast({
        title: 'Failed to process file',
        description: error instanceof Error ? error.message : 'Unknown error',
        status: 'error',
        duration: 5000,
      });
      setSelectedMethod(null);
    } finally {
      setIsProcessing(false);
      setUploadProgress(0);
      // Reset file input
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  }, [selectedMethod, toast]);

  const handleGeometryComplete = useCallback((
    newGeometry: GeoJSON.Geometry,
    catchmentIds?: string[]
  ) => {
    setGeometry(newGeometry);
    setBoundingBox(computeBoundingBox(newGeometry));
    if (catchmentIds) {
      setSelectedCatchmentIds(catchmentIds);
    }
    setStep('details');
  }, []);

  const handleSubmitSite = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!siteName.trim()) {
      toast({
        title: 'Name required',
        description: 'Please enter a name for your site',
        status: 'warning',
        duration: 3000,
      });
      return;
    }

    if (!geometry) {
      toast({
        title: 'Geometry required',
        description: 'Please complete the site boundary',
        status: 'warning',
        duration: 3000,
      });
      return;
    }

    setIsSubmitting(true);

    try {
      const siteData = {
        name: siteName.trim(),
        description: siteDescription.trim(),
        geometry,
        creationMethod: selectedMethod,
        catchmentIds: selectedCatchmentIds,
      };

      const response = await fetch('/api/sites', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(siteData),
      });

      if (!response.ok) {
        throw new Error('Failed to create site');
      }

      const site = await response.json();
      setCreatedSite(site);
      // Pre-fill project title based on site name
      setProjectTitle(`${site.name} Project`);

      toast({
        title: 'Site created!',
        description: 'Now let\'s create a project',
        status: 'success',
        duration: 3000,
      });

      setStep('project');
    } catch (error) {
      toast({
        title: 'Error creating site',
        description: error instanceof Error ? error.message : 'Unknown error',
        status: 'error',
        duration: 5000,
      });
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleSubmitProject = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!projectTitle.trim()) {
      toast({
        title: 'Title required',
        description: 'Please enter a title for your project',
        status: 'warning',
        duration: 3000,
      });
      return;
    }

    if (!createdSite) {
      toast({
        title: 'Site required',
        description: 'Please create a site first',
        status: 'warning',
        duration: 3000,
      });
      return;
    }

    setIsSubmitting(true);

    try {
      const projectData = {
        title: projectTitle.trim(),
        description: projectDescription.trim(),
        siteId: createdSite.id,
      };

      const response = await fetch('/api/projects', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(projectData),
      });

      if (!response.ok) {
        throw new Error('Failed to create project');
      }

      const project = await response.json();

      toast({
        title: 'Project created!',
        description: `"${project.title}" is ready`,
        status: 'success',
        duration: 3000,
      });

      // Navigate to the projects page or open the project
      onSiteCreated(createdSite);
    } catch (error) {
      toast({
        title: 'Error creating project',
        description: error instanceof Error ? error.message : 'Unknown error',
        status: 'error',
        duration: 5000,
      });
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleBack = useCallback(() => {
    if (step === 'project') {
      // Can't go back from project - site is already created
      // Navigate to explore mode to start fresh
      onNavigate('explore');
    } else if (step === 'details') {
      setStep('geometry');
    } else if (step === 'geometry') {
      setStep('method');
      setSelectedMethod(null);
      setGeometry(null);
      setBoundingBox(null);
      setSelectedCatchmentIds([]);
    } else {
      onNavigate('explore');
    }
  }, [step, onNavigate]);

  const getStepTitle = () => {
    switch (step) {
      case 'method':
        return 'Choose Your Method';
      case 'geometry':
        return selectedMethod === 'drawn' ? 'Draw Your Site' :
               selectedMethod === 'catchments' ? 'Select Catchments' :
               'Review Your Boundary';
      case 'details':
        return 'Name Your Site';
      case 'project':
        return 'Create Your Project';
    }
  };

  return (
    <Box position="relative" w="100%" h="100%" overflow="hidden">
      {/* Background - subtle animated gradient */}
      <Box
        position="fixed"
        top={0}
        left={0}
        right={0}
        bottom={0}
        bg="linear-gradient(135deg, #0a0a1a 0%, #1a1a2e 50%, #0d0d1f 100%)"
        zIndex={0}
      />
      <Box
        position="fixed"
        top={0}
        left={0}
        right={0}
        bottom={0}
        opacity={0.1}
        bgImage={`url("data:image/svg+xml,%3Csvg width='60' height='60' viewBox='0 0 60 60' xmlns='http://www.w3.org/2000/svg'%3E%3Cg fill='none' fill-rule='evenodd'%3E%3Cg fill='%2300ffff' fill-opacity='0.15'%3E%3Ccircle cx='2' cy='2' r='1'/%3E%3C/g%3E%3C/g%3E%3C/svg%3E")`}
        zIndex={0}
      />

      {/* Hidden file input */}
      <input
        ref={fileInputRef}
        type="file"
        accept={selectedMethod === 'shapefile' ? '.zip' : '.geojson,.json'}
        onChange={handleFileUpload}
        style={{ display: 'none' }}
      />

      {/* Processing overlay */}
      <AnimatePresence>
        {isProcessing && (
          <MotionBox
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            position="fixed"
            top={0}
            left={0}
            right={0}
            bottom={0}
            bg="blackAlpha.800"
            zIndex={100}
            display="flex"
            alignItems="center"
            justifyContent="center"
          >
            <VStack spacing={6}>
              <MotionBox
                animate={{
                  scale: [1, 1.2, 1],
                  rotate: [0, 180, 360],
                }}
                transition={{
                  duration: 2,
                  repeat: Infinity,
                  ease: 'easeInOut',
                }}
              >
                <Icon as={FiMapPin} boxSize={16} color={SITE_COLORS.primary} />
              </MotionBox>
              <Text color="white" fontSize="xl" fontWeight="bold">
                Processing your file...
              </Text>
              <Box w="300px">
                <Progress
                  value={uploadProgress}
                  colorScheme="cyan"
                  borderRadius="full"
                  bg="whiteAlpha.200"
                  size="lg"
                />
              </Box>
            </VStack>
          </MotionBox>
        )}
      </AnimatePresence>

      {/* Main content */}
      <Box position="relative" zIndex={2} h="100%" overflow="auto">
        <Container maxW="container.xl" pt={6} pb={8} h="100%">
          {/* Header */}
          <MotionFlex
            initial={{ opacity: 0, y: -20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.4 }}
            align="center"
            justify="space-between"
            mb={6}
          >
            <Button
              variant="ghost"
              colorScheme="whiteAlpha"
              color="white"
              leftIcon={<FiArrowLeft />}
              onClick={handleBack}
              _hover={{ bg: 'whiteAlpha.200' }}
            >
              {step === 'method' ? 'Back to Projects' : 'Back'}
            </Button>

            {/* Step indicator */}
            <HStack spacing={2}>
              {[
                { id: 'method', label: 'Method' },
                { id: 'geometry', label: 'Boundary' },
                { id: 'details', label: 'Site' },
                { id: 'project', label: 'Project' },
              ].map((s, i) => (
                <Badge
                  key={s.id}
                  px={3}
                  py={1}
                  borderRadius="full"
                  bg={step === s.id ? 'cyan.500' : 'whiteAlpha.200'}
                  color={step === s.id ? 'white' : 'whiteAlpha.600'}
                >
                  {i + 1}. {s.label}
                </Badge>
              ))}
            </HStack>
          </MotionFlex>

          {/* Title */}
          <MotionBox
            textAlign="center"
            mb={8}
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.6 }}
          >
            <Heading
              as="h1"
              fontSize={{ base: '2xl', md: '4xl' }}
              color="white"
              mb={2}
            >
              Create{' '}
              <Text
                as="span"
                bgGradient="linear(to-r, cyan.300, purple.400)"
                bgClip="text"
              >
                Site
              </Text>
            </Heading>
            <Text color="whiteAlpha.700" fontSize="lg">
              {getStepTitle()}
            </Text>
          </MotionBox>

          {/* Step content */}
          <AnimatePresence mode="wait">
            {step === 'method' && (
              <MotionBox
                key="method"
                initial={{ opacity: 0, x: -50 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: 50 }}
                transition={{ duration: 0.4 }}
              >
                <SimpleGrid columns={{ base: 1, md: 2 }} spacing={6} maxW="900px" mx="auto">
                  {creationMethods.map((method, i) => (
                    <MotionBox
                      key={method.id}
                      initial={{ opacity: 0, y: 30 }}
                      animate={{ opacity: 1, y: 0 }}
                      transition={{ duration: 0.5, delay: i * 0.1 }}
                      cursor="pointer"
                      onClick={() => handleMethodSelect(method.id)}
                    >
                      <Box
                        p={8}
                        borderRadius="2xl"
                        bg={cardBg}
                        border="2px solid"
                        borderColor={borderColor}
                        backdropFilter="blur(10px)"
                        transition="all 0.3s cubic-bezier(0.4, 0, 0.2, 1)"
                        _hover={{
                          transform: 'translateY(-8px) scale(1.02)',
                          borderColor: method.color,
                          boxShadow: `0 20px 40px -20px ${method.color}66`,
                        }}
                      >
                        <VStack spacing={4} align="start">
                          <Flex
                            w={14}
                            h={14}
                            borderRadius="xl"
                            bgGradient={method.gradient}
                            align="center"
                            justify="center"
                            boxShadow={`0 8px 20px -8px ${method.color}66`}
                          >
                            <Icon as={method.icon} boxSize={7} color="white" />
                          </Flex>
                          <Box>
                            <Text
                              fontSize="xl"
                              fontWeight="bold"
                              color="white"
                              mb={1}
                            >
                              {method.title}
                            </Text>
                            <Text color="whiteAlpha.700" fontSize="sm">
                              {method.description}
                            </Text>
                          </Box>
                        </VStack>
                      </Box>
                    </MotionBox>
                  ))}
                </SimpleGrid>
              </MotionBox>
            )}

            {step === 'geometry' && selectedMethod && (
              <MotionBox
                key="geometry"
                initial={{ opacity: 0, x: 50 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: -50 }}
                transition={{ duration: 0.4 }}
                h="calc(100vh - 280px)"
                minH="500px"
              >
                <SiteCreationMap
                  mode={selectedMethod}
                  initialGeometry={geometry}
                  initialExtent={initialExtent}
                  boundingBox={boundingBox}
                  onGeometryComplete={handleGeometryComplete}
                  onCancel={handleBack}
                />
              </MotionBox>
            )}

            {step === 'details' && (
              <MotionBox
                key="details"
                initial={{ opacity: 0, x: 50 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: -50 }}
                transition={{ duration: 0.4 }}
                maxW="600px"
                mx="auto"
              >
                <Box
                  as="form"
                  onSubmit={handleSubmitSite}
                  bg={cardBg}
                  backdropFilter="blur(20px)"
                  borderRadius="2xl"
                  p={{ base: 6, md: 10 }}
                  border="1px solid"
                  borderColor={borderColor}
                >
                  <VStack spacing={6} align="stretch">
                    {/* Preview info */}
                    <Flex
                      p={4}
                      borderRadius="xl"
                      bg="whiteAlpha.100"
                      align="center"
                      justify="space-between"
                    >
                      <HStack>
                        <Icon
                          as={creationMethods.find(m => m.id === selectedMethod)?.icon || FiMapPin}
                          color={creationMethods.find(m => m.id === selectedMethod)?.color}
                          boxSize={6}
                        />
                        <Text color="white" fontWeight="medium">
                          {selectedMethod === 'catchments'
                            ? `${selectedCatchmentIds.length} catchments selected`
                            : 'Boundary defined'}
                        </Text>
                      </HStack>
                      <Button
                        size="sm"
                        variant="ghost"
                        colorScheme="cyan"
                        onClick={() => setStep('geometry')}
                      >
                        Edit
                      </Button>
                    </Flex>

                    {/* Name input */}
                    <FormControl isRequired>
                      <FormLabel color="white" fontSize="lg">
                        Site Name
                      </FormLabel>
                      <Input
                        value={siteName}
                        onChange={(e) => setSiteName(e.target.value)}
                        placeholder="e.g., Upper Nile Basin"
                        size="lg"
                        bg={inputBg}
                        border="1px solid"
                        borderColor={borderColor}
                        color="white"
                        _placeholder={{ color: 'whiteAlpha.500' }}
                        _hover={{ borderColor: 'whiteAlpha.400' }}
                        _focus={{
                          borderColor: 'cyan.400',
                          boxShadow: '0 0 0 1px var(--chakra-colors-cyan-400)',
                        }}
                      />
                    </FormControl>

                    {/* Description input */}
                    <FormControl>
                      <FormLabel color="white" fontSize="lg">
                        Description
                      </FormLabel>
                      <Textarea
                        value={siteDescription}
                        onChange={(e) => setSiteDescription(e.target.value)}
                        placeholder="Optional description of this site..."
                        size="lg"
                        bg={inputBg}
                        border="1px solid"
                        borderColor={borderColor}
                        color="white"
                        _placeholder={{ color: 'whiteAlpha.500' }}
                        _hover={{ borderColor: 'whiteAlpha.400' }}
                        _focus={{
                          borderColor: 'cyan.400',
                          boxShadow: '0 0 0 1px var(--chakra-colors-cyan-400)',
                        }}
                        rows={3}
                        resize="vertical"
                      />
                    </FormControl>

                    {/* Submit button */}
                    <Button
                      type="submit"
                      size="lg"
                      bgGradient="linear(to-r, cyan.400, purple.500)"
                      color="white"
                      rightIcon={<FiArrowRight />}
                      isLoading={isSubmitting}
                      loadingText="Creating..."
                      _hover={{
                        bgGradient: 'linear(to-r, cyan.300, purple.400)',
                        transform: 'translateY(-2px)',
                        boxShadow: '0 10px 30px -10px rgba(0, 255, 255, 0.5)',
                      }}
                      transition="all 0.2s"
                    >
                      Create Site & Continue
                    </Button>
                  </VStack>
                </Box>
              </MotionBox>
            )}

            {step === 'project' && createdSite && (
              <MotionBox
                key="project"
                initial={{ opacity: 0, x: 50 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: -50 }}
                transition={{ duration: 0.4 }}
                maxW="600px"
                mx="auto"
              >
                <Box
                  as="form"
                  onSubmit={handleSubmitProject}
                  bg={cardBg}
                  backdropFilter="blur(20px)"
                  borderRadius="2xl"
                  p={{ base: 6, md: 10 }}
                  border="1px solid"
                  borderColor={borderColor}
                >
                  <VStack spacing={6} align="stretch">
                    {/* Site info */}
                    <Flex
                      p={4}
                      borderRadius="xl"
                      bg="rgba(0, 68, 0, 0.3)"
                      align="center"
                      justify="space-between"
                      border="1px solid"
                      borderColor="green.500"
                    >
                      <HStack>
                        <Icon as={FiMapPin} color="green.400" boxSize={6} />
                        <VStack align="start" spacing={0}>
                          <Text color="white" fontWeight="medium">
                            {createdSite.name}
                          </Text>
                          <Text color="green.300" fontSize="sm">
                            Site created successfully
                          </Text>
                        </VStack>
                      </HStack>
                    </Flex>

                    {/* Project Title input */}
                    <FormControl isRequired>
                      <FormLabel color="white" fontSize="lg">
                        Project Title
                      </FormLabel>
                      <Input
                        value={projectTitle}
                        onChange={(e) => setProjectTitle(e.target.value)}
                        placeholder="e.g., Water Resource Analysis 2024"
                        size="lg"
                        bg={inputBg}
                        border="1px solid"
                        borderColor={borderColor}
                        color="white"
                        _placeholder={{ color: 'whiteAlpha.500' }}
                        _hover={{ borderColor: 'whiteAlpha.400' }}
                        _focus={{
                          borderColor: 'cyan.400',
                          boxShadow: '0 0 0 1px var(--chakra-colors-cyan-400)',
                        }}
                      />
                    </FormControl>

                    {/* Project Description input */}
                    <FormControl>
                      <FormLabel color="white" fontSize="lg">
                        Project Description
                      </FormLabel>
                      <Textarea
                        value={projectDescription}
                        onChange={(e) => setProjectDescription(e.target.value)}
                        placeholder="Optional description of your project..."
                        size="lg"
                        bg={inputBg}
                        border="1px solid"
                        borderColor={borderColor}
                        color="white"
                        _placeholder={{ color: 'whiteAlpha.500' }}
                        _hover={{ borderColor: 'whiteAlpha.400' }}
                        _focus={{
                          borderColor: 'cyan.400',
                          boxShadow: '0 0 0 1px var(--chakra-colors-cyan-400)',
                        }}
                        rows={3}
                        resize="vertical"
                      />
                    </FormControl>

                    {/* Submit button */}
                    <Button
                      type="submit"
                      size="lg"
                      bgGradient="linear(to-r, green.400, teal.500)"
                      color="white"
                      leftIcon={<FiFolderPlus />}
                      isLoading={isSubmitting}
                      loadingText="Creating Project..."
                      _hover={{
                        bgGradient: 'linear(to-r, green.300, teal.400)',
                        transform: 'translateY(-2px)',
                        boxShadow: '0 10px 30px -10px rgba(0, 255, 128, 0.5)',
                      }}
                      transition="all 0.2s"
                    >
                      Create Project
                    </Button>
                  </VStack>
                </Box>
              </MotionBox>
            )}
          </AnimatePresence>
        </Container>
      </Box>
    </Box>
  );
}

/**
 * Compute bounding box from GeoJSON geometry
 */
function computeBoundingBox(geometry: GeoJSON.Geometry): BoundingBox {
  const bbox: BoundingBox = {
    minX: 180,
    minY: 90,
    maxX: -180,
    maxY: -90,
  };

  const updateBBox = (coord: number[]) => {
    if (coord.length >= 2) {
      bbox.minX = Math.min(bbox.minX, coord[0]);
      bbox.maxX = Math.max(bbox.maxX, coord[0]);
      bbox.minY = Math.min(bbox.minY, coord[1]);
      bbox.maxY = Math.max(bbox.maxY, coord[1]);
    }
  };

  const processCoords = (coords: unknown): void => {
    if (!coords) return;
    if (Array.isArray(coords)) {
      if (typeof coords[0] === 'number') {
        updateBBox(coords as number[]);
      } else {
        for (const c of coords) {
          processCoords(c);
        }
      }
    }
  };

  if ('coordinates' in geometry) {
    processCoords(geometry.coordinates);
  } else if ('geometries' in geometry) {
    for (const g of geometry.geometries) {
      const childBBox = computeBoundingBox(g);
      bbox.minX = Math.min(bbox.minX, childBBox.minX);
      bbox.maxX = Math.max(bbox.maxX, childBBox.maxX);
      bbox.minY = Math.min(bbox.minY, childBBox.minY);
      bbox.maxY = Math.max(bbox.maxY, childBBox.maxY);
    }
  }

  return bbox;
}

export default SiteCreationPage;
