import {
  Box,
  Button,
  Container,
  Flex,
  FormControl,
  FormLabel,
  Heading,
  Icon,
  IconButton,
  Image,
  Input,
  Text,
  Textarea,
  VStack,
  useColorModeValue,
  useToast,
  HStack,
} from '@chakra-ui/react';
import { keyframes } from '@emotion/react';
import { motion, AnimatePresence } from 'framer-motion';
import { useCallback, useRef, useState } from 'react';
import {
  FiArrowLeft,
  FiCheck,
  FiUpload,
  FiEdit3,
  FiLayers,
  FiFile,
  FiImage,
  FiX,
  FiChevronRight,
  FiZap,
} from 'react-icons/fi';
import type { AppPage, Site, SiteCreationMethod, BoundingBox } from '../types';
import SiteCreationMap from './SiteCreationMap';
import { SITE_COLORS } from '../hooks/usePhysicsPolygon';
import { getAppRuntime } from '../types/runtime';
import { createSite, updateSite } from '../hooks/useApi';

const MotionBox = motion(Box);
const MotionFlex = motion(Flex);
const MotionVStack = motion(VStack);

// Glow animation keyframes
const glowPulse = keyframes`
  0%, 100% { box-shadow: 0 0 20px rgba(0, 255, 255, 0.3), 0 0 40px rgba(0, 255, 255, 0.1); }
  50% { box-shadow: 0 0 40px rgba(0, 255, 255, 0.5), 0 0 80px rgba(0, 255, 255, 0.2); }
`;

const floatAnimation = keyframes`
  0%, 100% { transform: translateY(0px); }
  50% { transform: translateY(-10px); }
`;

interface SiteCreationPageProps {
  onNavigate: (page: AppPage) => void;
  onSiteCreated: (site: Site) => void;
  initialExtent?: { center: [number, number]; zoom: number };
  editSite?: Site | null;
}

interface CreationMethodOption {
  id: SiteCreationMethod;
  icon: typeof FiUpload;
  title: string;
  description: string;
  color: string;
  gradient: string;
  emoji: string;
}

const creationMethods: CreationMethodOption[] = [
  {
    id: 'shapefile',
    icon: FiFile,
    title: 'Shapefile',
    description: 'Upload a ZIP with .shp, .shx, .dbf',
    color: SITE_COLORS.primary,
    gradient: 'linear(135deg, #00D4FF 0%, #0066FF 100%)',
    emoji: '📦',
  },
  {
    id: 'geojson',
    icon: FiUpload,
    title: 'GeoJSON',
    description: 'Drop a .geojson or .json file',
    color: SITE_COLORS.secondary,
    gradient: 'linear(135deg, #FF00FF 0%, #8B00FF 100%)',
    emoji: '🗺️',
  },
  {
    id: 'drawn',
    icon: FiEdit3,
    title: 'Draw',
    description: 'Click to draw your boundary',
    color: SITE_COLORS.accent,
    gradient: 'linear(135deg, #FFD700 0%, #FF8C00 100%)',
    emoji: '✏️',
  },
  {
    id: 'catchments',
    icon: FiLayers,
    title: 'Catchments',
    description: 'Select & merge catchments',
    color: SITE_COLORS.glow,
    gradient: 'linear(135deg, #00FF88 0%, #00CC66 100%)',
    emoji: '🧩',
  },
];

type Step = 'method' | 'geometry' | 'details';

// Physics spring configs
const bounceConfig = { type: 'spring' as const, stiffness: 400, damping: 25 };

function SiteCreationPage({ onNavigate, onSiteCreated, initialExtent, editSite }: SiteCreationPageProps) {
  const isEditMode = !!editSite;
  const [step, setStep] = useState<Step>(() => isEditMode ? 'details' : 'method');
  const [selectedMethod, setSelectedMethod] = useState<SiteCreationMethod | null>(() =>
    editSite?.creationMethod || null
  );
  const [geometry, setGeometry] = useState<GeoJSON.Geometry | null>(() =>
    editSite?.geometry || null
  );
  const [boundingBox, setBoundingBox] = useState<BoundingBox | null>(() =>
    editSite?.boundingBox || null
  );
  const [selectedCatchmentIds, setSelectedCatchmentIds] = useState<string[]>(() =>
    editSite?.catchmentIds || []
  );
  const [siteTitle, setSiteTitle] = useState(() => editSite?.title || '');
  const [siteDescription, setSiteDescription] = useState(() => editSite?.description || '');
  const [thumbnail, setThumbnail] = useState<string | null>(() => editSite?.thumbnail || null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const [hoveredMethod, setHoveredMethod] = useState<SiteCreationMethod | null>(null);
  const [isDraggingThumbnail, setIsDraggingThumbnail] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const thumbnailInputRef = useRef<HTMLInputElement>(null);
  const toast = useToast();

  const cardBg = useColorModeValue('rgba(255,255,255,0.05)', 'rgba(0,0,0,0.3)');
  const inputBg = useColorModeValue('rgba(255,255,255,0.08)', 'rgba(0,0,0,0.4)');

  // Process thumbnail file
  const processThumbnailFile = useCallback((file: File) => {
    if (!file.type.startsWith('image/')) {
      toast({ title: 'Invalid file type', status: 'warning', duration: 3000 });
      return;
    }
    if (file.size > 5 * 1024 * 1024) {
      toast({ title: 'File too large (max 5MB)', status: 'warning', duration: 3000 });
      return;
    }
    const reader = new FileReader();
    reader.onload = () => setThumbnail(reader.result as string);
    reader.readAsDataURL(file);
  }, [toast]);

  const handleThumbnailUpload = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) processThumbnailFile(file);
    if (thumbnailInputRef.current) thumbnailInputRef.current.value = '';
  }, [processThumbnailFile]);

  const handleThumbnailDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDraggingThumbnail(false);
    const file = e.dataTransfer.files?.[0];
    if (file) processThumbnailFile(file);
  }, [processThumbnailFile]);

  const handleMethodSelect = useCallback((method: SiteCreationMethod) => {
    setSelectedMethod(method);
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

    try {
      let geojson: GeoJSON.FeatureCollection | GeoJSON.Feature | GeoJSON.Geometry;

      if (selectedMethod === 'shapefile') {
        const shp = await import('shpjs');
        const buffer = await file.arrayBuffer();
        geojson = await shp.default(buffer) as GeoJSON.FeatureCollection;
      } else {
        const text = await file.text();
        geojson = JSON.parse(text);
      }

      let extractedGeometry: GeoJSON.Geometry;
      if ('features' in geojson && geojson.features.length > 0) {
        extractedGeometry = geojson.features.length === 1
          ? geojson.features[0].geometry
          : { type: 'GeometryCollection', geometries: geojson.features.map(f => f.geometry) };
      } else if ('geometry' in geojson) {
        extractedGeometry = (geojson as GeoJSON.Feature).geometry;
      } else if ('coordinates' in geojson) {
        extractedGeometry = geojson as GeoJSON.Geometry;
      } else {
        throw new Error('Could not extract geometry');
      }

      setGeometry(extractedGeometry);
      setBoundingBox(computeBoundingBox(extractedGeometry));
      setStep('geometry');

      toast({ title: 'Boundary loaded!', status: 'success', duration: 2000 });
    } catch (error) {
      toast({
        title: 'Failed to process file',
        description: error instanceof Error ? error.message : 'Unknown error',
        status: 'error',
        duration: 5000,
      });
      setSelectedMethod(null);
    } finally {
      setIsProcessing(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  }, [selectedMethod, toast]);

  const handleGeometryComplete = useCallback((
    newGeometry: GeoJSON.Geometry,
    catchmentIds?: string[],
    mapThumbnail?: string
  ) => {
    setGeometry(newGeometry);
    setBoundingBox(computeBoundingBox(newGeometry));
    if (catchmentIds) setSelectedCatchmentIds(catchmentIds);
    if (mapThumbnail && !thumbnail) setThumbnail(mapThumbnail);
    setStep('details');
  }, [thumbnail]);

  const handleSubmitSite = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!siteTitle.trim()) {
      toast({ title: 'Please enter a title', status: 'warning', duration: 3000 });
      return;
    }
    if (!isEditMode && !geometry) {
      toast({ title: 'Please complete the boundary', status: 'warning', duration: 3000 });
      return;
    }

    setIsSubmitting(true);

    try {
      const siteData: Record<string, unknown> = {
        title: siteTitle.trim(),
        description: siteDescription.trim(),
        appRuntime: getAppRuntime(),
      };

      if (thumbnail !== editSite?.thumbnail) siteData.thumbnail = thumbnail;
      if (!isEditMode) {
        siteData.geometry = geometry;
        siteData.creationMethod = selectedMethod;
        siteData.catchmentIds = selectedCatchmentIds;
      }

      const site = isEditMode
        ? await updateSite(editSite.id, siteData as Partial<Site>)
        : await createSite(siteData as Partial<Site>);

      toast({
        title: isEditMode ? 'Site updated!' : 'Site created!',
        status: 'success',
        duration: 2000,
      });
      onSiteCreated(site);
    } catch (error) {
      toast({
        title: 'Error',
        description: error instanceof Error ? error.message : 'Unknown error',
        status: 'error',
        duration: 5000,
      });
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleBack = useCallback(() => {
    if (step === 'details') {
      if (isEditMode) onNavigate('sites');
      else setStep('geometry');
    } else if (step === 'geometry') {
      setStep('method');
      setSelectedMethod(null);
      setGeometry(null);
      setBoundingBox(null);
      setSelectedCatchmentIds([]);
    } else {
      onNavigate('sites');
    }
  }, [step, onNavigate, isEditMode]);

  // Step indicator with physics bounce
  const stepIndicators = [
    { id: 'method', num: 1, label: 'Method' },
    { id: 'geometry', num: 2, label: 'Boundary' },
    { id: 'details', num: 3, label: 'Details' },
  ];

  return (
    <Box position="relative" w="100%" h="100%" overflow="hidden">
      {/* Animated gradient background */}
      <Box
        position="fixed"
        inset={0}
        bg="linear-gradient(135deg, #0a0a1a 0%, #1a1a2e 25%, #0f0f23 50%, #1a1a2e 75%, #0a0a1a 100%)"
        backgroundSize="400% 400%"
        animation="gradientShift 15s ease infinite"
        sx={{
          '@keyframes gradientShift': {
            '0%': { backgroundPosition: '0% 50%' },
            '50%': { backgroundPosition: '100% 50%' },
            '100%': { backgroundPosition: '0% 50%' },
          },
        }}
      />

      {/* Floating particles */}
      <Box position="fixed" inset={0} overflow="hidden" pointerEvents="none">
        {[...Array(8)].map((_, i) => (
          <Box
            key={i}
            position="absolute"
            w={`${20 + Math.random() * 40}px`}
            h={`${20 + Math.random() * 40}px`}
            borderRadius="full"
            bg={`rgba(0, 255, 255, ${0.05 + Math.random() * 0.1})`}
            left={`${Math.random() * 100}%`}
            top={`${Math.random() * 100}%`}
            animation={`${floatAnimation} ${5 + Math.random() * 5}s ease-in-out infinite`}
            style={{ animationDelay: `${i * 0.5}s` }}
          />
        ))}
      </Box>

      {/* Hidden file inputs */}
      <input
        ref={fileInputRef}
        type="file"
        accept={selectedMethod === 'shapefile' ? '.zip' : '.geojson,.json'}
        onChange={handleFileUpload}
        style={{ display: 'none' }}
      />
      <input
        ref={thumbnailInputRef}
        type="file"
        accept="image/*"
        onChange={handleThumbnailUpload}
        style={{ display: 'none' }}
      />

      {/* Processing overlay with physics animation */}
      <AnimatePresence>
        {isProcessing && (
          <MotionBox
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            position="fixed"
            inset={0}
            bg="rgba(0,0,0,0.9)"
            zIndex={100}
            display="flex"
            alignItems="center"
            justifyContent="center"
          >
            <MotionVStack
              spacing={8}
              initial={{ scale: 0.5, y: 50 }}
              animate={{ scale: 1, y: 0 }}
              transition={bounceConfig}
            >
              <MotionBox
                animate={{
                  rotate: [0, 360],
                  scale: [1, 1.2, 1],
                }}
                transition={{
                  rotate: { duration: 2, repeat: Infinity, ease: 'linear' },
                  scale: { duration: 1, repeat: Infinity, ease: 'easeInOut' },
                }}
              >
                <Icon as={FiZap} boxSize={24} color={SITE_COLORS.primary} />
              </MotionBox>
              <Heading
                size="2xl"
                bgGradient="linear(to-r, cyan.300, purple.400, pink.400)"
                bgClip="text"
                fontWeight="black"
              >
                Processing...
              </Heading>
            </MotionVStack>
          </MotionBox>
        )}
      </AnimatePresence>

      {/* Main content */}
      <Box position="relative" zIndex={2} h="100%" overflow="auto">
        <Container maxW="container.xl" pt={6} pb={8} h="100%">
          {/* Header */}
          <MotionFlex
            initial={{ opacity: 0, y: -30 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ ...bounceConfig, delay: 0.1 }}
            align="center"
            justify="space-between"
            mb={8}
          >
            <Button
              variant="ghost"
              color="white"
              leftIcon={<FiArrowLeft />}
              onClick={handleBack}
              size="lg"
              fontWeight="bold"
              _hover={{ bg: 'whiteAlpha.100', transform: 'translateX(-4px)' }}
              transition="all 0.2s"
            >
              {isEditMode || step === 'method' ? 'Back to Sites' : 'Back'}
            </Button>

            {/* Step indicator - physics bouncing badges */}
            {!isEditMode && (
              <HStack spacing={3}>
                {stepIndicators.map((s, i) => {
                  const isActive = step === s.id;
                  const isPast = stepIndicators.findIndex(st => st.id === step) > i;
                  return (
                    <MotionBox
                      key={s.id}
                      initial={{ scale: 0, y: -20 }}
                      animate={{ scale: 1, y: 0 }}
                      transition={{ ...bounceConfig, delay: 0.2 + i * 0.1 }}
                    >
                      <HStack
                        px={4}
                        py={2}
                        borderRadius="full"
                        bg={isActive ? 'cyan.500' : isPast ? 'green.500' : 'whiteAlpha.100'}
                        color="white"
                        fontWeight="bold"
                        fontSize="sm"
                        spacing={2}
                        transition="all 0.3s"
                        boxShadow={isActive ? `0 0 30px ${SITE_COLORS.primary}66` : 'none'}
                      >
                        <Box
                          w={6}
                          h={6}
                          borderRadius="full"
                          bg={isActive || isPast ? 'white' : 'whiteAlpha.300'}
                          color={isActive ? 'cyan.500' : isPast ? 'green.500' : 'white'}
                          display="flex"
                          alignItems="center"
                          justifyContent="center"
                          fontSize="xs"
                          fontWeight="black"
                        >
                          {isPast ? <FiCheck /> : s.num}
                        </Box>
                        <Text display={{ base: 'none', md: 'block' }}>{s.label}</Text>
                      </HStack>
                    </MotionBox>
                  );
                })}
              </HStack>
            )}
          </MotionFlex>

          {/* Title */}
          <MotionBox
            textAlign="center"
            mb={10}
            initial={{ opacity: 0, y: 30 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ ...bounceConfig, delay: 0.3 }}
          >
            <Heading
              as="h1"
              fontSize={{ base: '4xl', md: '6xl', lg: '7xl' }}
              fontWeight="black"
              letterSpacing="tight"
              mb={4}
            >
              <Text as="span" color="white">
                {isEditMode ? 'Edit ' : step === 'method' ? 'Create ' : step === 'geometry' ? 'Define ' : 'Name '}
              </Text>
              <Text
                as="span"
                bgGradient="linear(to-r, #00FFFF, #FF00FF, #FFFF00)"
                bgClip="text"
              >
                {step === 'method' ? 'Your Site' : step === 'geometry' ? 'Boundary' : 'Your Site'}
              </Text>
            </Heading>
            <Text
              fontSize={{ base: 'lg', md: 'xl' }}
              color="whiteAlpha.700"
              maxW="600px"
              mx="auto"
              fontWeight="medium"
            >
              {step === 'method' && 'Choose how you want to define your site boundary'}
              {step === 'geometry' && (
                selectedMethod === 'drawn' ? 'Click on the map to draw your boundary' :
                selectedMethod === 'catchments' ? 'Click catchments to select them' :
                'Review and confirm your boundary'
              )}
              {step === 'details' && 'Give your site a memorable name and description'}
            </Text>
          </MotionBox>

          {/* Step content */}
          <AnimatePresence mode="wait">
            {/* STEP 1: Method Selection */}
            {step === 'method' && (
              <MotionBox
                key="method"
                initial={{ opacity: 0, scale: 0.9 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 0.9, x: -100 }}
                transition={bounceConfig}
              >
                <Flex
                  flexWrap="wrap"
                  gap={6}
                  justify="center"
                  maxW="1000px"
                  mx="auto"
                >
                  {creationMethods.map((method, i) => (
                    <MotionBox
                      key={method.id}
                      initial={{ opacity: 0, y: 50, rotateX: -15 }}
                      animate={{ opacity: 1, y: 0, rotateX: 0 }}
                      transition={{ ...bounceConfig, delay: 0.4 + i * 0.1 }}
                      onHoverStart={() => setHoveredMethod(method.id)}
                      onHoverEnd={() => setHoveredMethod(null)}
                      onClick={() => handleMethodSelect(method.id)}
                      cursor="pointer"
                      style={{ perspective: '1000px' }}
                    >
                      <MotionBox
                        w={{ base: '160px', md: '200px' }}
                        h={{ base: '200px', md: '240px' }}
                        bg={cardBg}
                        borderRadius="3xl"
                        border="2px solid"
                        borderColor={hoveredMethod === method.id ? method.color : 'whiteAlpha.200'}
                        backdropFilter="blur(20px)"
                        p={6}
                        display="flex"
                        flexDirection="column"
                        alignItems="center"
                        justifyContent="center"
                        textAlign="center"
                        position="relative"
                        overflow="hidden"
                        whileHover={{
                          scale: 1.05,
                          y: -10,
                          rotateY: 5,
                          rotateX: -5,
                        }}
                        whileTap={{ scale: 0.98 }}
                        animate={{
                          boxShadow: hoveredMethod === method.id
                            ? `0 20px 60px -20px ${method.color}99, 0 0 80px -20px ${method.color}66`
                            : '0 10px 30px -10px rgba(0,0,0,0.5)',
                        }}
                        transition={{ duration: 0.3 }}
                      >
                        {/* Glow background on hover */}
                        <Box
                          position="absolute"
                          inset={0}
                          bgGradient={method.gradient}
                          opacity={hoveredMethod === method.id ? 0.15 : 0}
                          transition="opacity 0.3s"
                        />

                        {/* Big emoji */}
                        <MotionBox
                          fontSize={{ base: '4xl', md: '5xl' }}
                          mb={4}
                          animate={hoveredMethod === method.id ? {
                            scale: [1, 1.2, 1],
                            rotate: [0, 10, -10, 0],
                          } : {}}
                          transition={{ duration: 0.5 }}
                        >
                          {method.emoji}
                        </MotionBox>

                        {/* Title */}
                        <Heading
                          size={{ base: 'md', md: 'lg' }}
                          color="white"
                          fontWeight="black"
                          mb={2}
                        >
                          {method.title}
                        </Heading>

                        {/* Description */}
                        <Text
                          fontSize={{ base: 'xs', md: 'sm' }}
                          color="whiteAlpha.700"
                          noOfLines={2}
                        >
                          {method.description}
                        </Text>

                        {/* Arrow indicator */}
                        <MotionBox
                          position="absolute"
                          bottom={4}
                          right={4}
                          initial={{ opacity: 0, x: -10 }}
                          animate={{
                            opacity: hoveredMethod === method.id ? 1 : 0,
                            x: hoveredMethod === method.id ? 0 : -10,
                          }}
                        >
                          <Icon as={FiChevronRight} color={method.color} boxSize={6} />
                        </MotionBox>
                      </MotionBox>
                    </MotionBox>
                  ))}
                </Flex>
              </MotionBox>
            )}

            {/* STEP 2: Geometry */}
            {step === 'geometry' && selectedMethod && (
              <MotionBox
                key="geometry"
                initial={{ opacity: 0, x: 100 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: -100 }}
                transition={bounceConfig}
                h="calc(100vh - 320px)"
                minH="500px"
              >
                <Box
                  h="100%"
                  borderRadius="3xl"
                  overflow="hidden"
                  border="3px solid"
                  borderColor="whiteAlpha.200"
                  boxShadow={`0 0 60px ${SITE_COLORS.primary}22`}
                >
                  <SiteCreationMap
                    mode={selectedMethod}
                    initialGeometry={geometry}
                    initialExtent={initialExtent}
                    boundingBox={boundingBox}
                    onGeometryComplete={handleGeometryComplete}
                    onCancel={handleBack}
                  />
                </Box>
              </MotionBox>
            )}

            {/* STEP 3: Details Form */}
            {step === 'details' && (
              <MotionBox
                key="details"
                initial={{ opacity: 0, x: 100, scale: 0.95 }}
                animate={{ opacity: 1, x: 0, scale: 1 }}
                exit={{ opacity: 0, x: -100, scale: 0.95 }}
                transition={bounceConfig}
                maxW="700px"
                mx="auto"
              >
                <MotionBox
                  as="form"
                  onSubmit={handleSubmitSite}
                  bg={cardBg}
                  backdropFilter="blur(30px)"
                  borderRadius="3xl"
                  p={{ base: 8, md: 12 }}
                  border="2px solid"
                  borderColor="whiteAlpha.200"
                  boxShadow={`0 30px 80px -30px rgba(0,0,0,0.5)`}
                  initial={{ y: 30 }}
                  animate={{ y: 0 }}
                  transition={{ ...bounceConfig, delay: 0.2 }}
                >
                  <VStack spacing={8} align="stretch">
                    {/* Boundary info badge */}
                    {!isEditMode && (
                      <MotionBox
                        initial={{ scale: 0.9, opacity: 0 }}
                        animate={{ scale: 1, opacity: 1 }}
                        transition={{ ...bounceConfig, delay: 0.3 }}
                      >
                        <Flex
                          p={5}
                          borderRadius="2xl"
                          bg="whiteAlpha.100"
                          align="center"
                          justify="space-between"
                          border="1px solid"
                          borderColor="whiteAlpha.200"
                        >
                          <HStack spacing={4}>
                            <Box
                              w={12}
                              h={12}
                              borderRadius="xl"
                              bg={creationMethods.find(m => m.id === selectedMethod)?.color}
                              display="flex"
                              alignItems="center"
                              justifyContent="center"
                              fontSize="2xl"
                            >
                              {creationMethods.find(m => m.id === selectedMethod)?.emoji}
                            </Box>
                            <Box>
                              <Text color="white" fontWeight="bold" fontSize="lg">
                                Boundary Ready
                              </Text>
                              <Text color="whiteAlpha.600" fontSize="sm">
                                {selectedMethod === 'catchments'
                                  ? `${selectedCatchmentIds.length} catchments selected`
                                  : `Via ${selectedMethod}`}
                              </Text>
                            </Box>
                          </HStack>
                          <Button
                            size="sm"
                            variant="ghost"
                            color="cyan.300"
                            onClick={() => setStep('geometry')}
                            _hover={{ bg: 'whiteAlpha.100' }}
                          >
                            Edit
                          </Button>
                        </Flex>
                      </MotionBox>
                    )}

                    {/* Title input - CHUNKY */}
                    <FormControl isRequired>
                      <FormLabel
                        color="white"
                        fontSize="xl"
                        fontWeight="bold"
                        mb={3}
                      >
                        Site Title
                      </FormLabel>
                      <Input
                        value={siteTitle}
                        onChange={(e) => setSiteTitle(e.target.value)}
                        placeholder="Give your site a memorable name..."
                        size="lg"
                        h={16}
                        fontSize="xl"
                        fontWeight="semibold"
                        bg={inputBg}
                        border="2px solid"
                        borderColor="whiteAlpha.200"
                        borderRadius="2xl"
                        color="white"
                        _placeholder={{ color: 'whiteAlpha.400' }}
                        _hover={{ borderColor: 'whiteAlpha.400' }}
                        _focus={{
                          borderColor: 'cyan.400',
                          boxShadow: `0 0 0 3px ${SITE_COLORS.primary}33`,
                        }}
                      />
                    </FormControl>

                    {/* Description - CHUNKY */}
                    <FormControl>
                      <FormLabel
                        color="white"
                        fontSize="xl"
                        fontWeight="bold"
                        mb={3}
                      >
                        Description
                      </FormLabel>
                      <Textarea
                        value={siteDescription}
                        onChange={(e) => setSiteDescription(e.target.value)}
                        placeholder="Describe what this site represents..."
                        size="lg"
                        fontSize="lg"
                        bg={inputBg}
                        border="2px solid"
                        borderColor="whiteAlpha.200"
                        borderRadius="2xl"
                        color="white"
                        _placeholder={{ color: 'whiteAlpha.400' }}
                        _hover={{ borderColor: 'whiteAlpha.400' }}
                        _focus={{
                          borderColor: 'cyan.400',
                          boxShadow: `0 0 0 3px ${SITE_COLORS.primary}33`,
                        }}
                        rows={4}
                        resize="vertical"
                      />
                    </FormControl>

                    {/* Thumbnail - BIG and VISUAL */}
                    <FormControl>
                      <FormLabel
                        color="white"
                        fontSize="xl"
                        fontWeight="bold"
                        mb={3}
                      >
                        Thumbnail
                      </FormLabel>
                      {thumbnail ? (
                        <MotionBox
                          initial={{ scale: 0.9, opacity: 0 }}
                          animate={{ scale: 1, opacity: 1 }}
                          transition={bounceConfig}
                          position="relative"
                          borderRadius="2xl"
                          overflow="hidden"
                          boxShadow={`0 20px 60px -20px ${SITE_COLORS.primary}44`}
                          border="3px solid"
                          borderColor="whiteAlpha.300"
                        >
                          <Image
                            src={thumbnail}
                            alt="Site thumbnail"
                            w="100%"
                            h="200px"
                            objectFit="cover"
                          />
                          <Box
                            position="absolute"
                            inset={0}
                            bg="blackAlpha.500"
                            opacity={0}
                            _hover={{ opacity: 1 }}
                            transition="opacity 0.2s"
                            display="flex"
                            alignItems="center"
                            justifyContent="center"
                          >
                            <HStack spacing={4}>
                              <IconButton
                                aria-label="Change"
                                icon={<FiImage />}
                                size="lg"
                                colorScheme="whiteAlpha"
                                borderRadius="xl"
                                onClick={() => thumbnailInputRef.current?.click()}
                              />
                              <IconButton
                                aria-label="Remove"
                                icon={<FiX />}
                                size="lg"
                                colorScheme="red"
                                borderRadius="xl"
                                onClick={() => setThumbnail(null)}
                              />
                            </HStack>
                          </Box>
                        </MotionBox>
                      ) : (
                        <MotionBox
                          onDragOver={(e: React.DragEvent) => { e.preventDefault(); setIsDraggingThumbnail(true); }}
                          onDragLeave={() => setIsDraggingThumbnail(false)}
                          onDrop={handleThumbnailDrop}
                          onClick={() => thumbnailInputRef.current?.click()}
                          cursor="pointer"
                          borderWidth="3px"
                          borderStyle="dashed"
                          borderColor={isDraggingThumbnail ? 'cyan.400' : 'whiteAlpha.300'}
                          borderRadius="2xl"
                          p={10}
                          textAlign="center"
                          bg={isDraggingThumbnail ? 'whiteAlpha.100' : 'transparent'}
                          sx={{ transition: 'all 0.3s' }}
                          _hover={{
                            borderColor: 'cyan.400',
                            bg: 'whiteAlpha.50',
                          }}
                          whileHover={{ scale: 1.02 }}
                          whileTap={{ scale: 0.98 }}
                        >
                          <VStack spacing={4}>
                            <Box
                              w={20}
                              h={20}
                              borderRadius="2xl"
                              bg={isDraggingThumbnail ? 'cyan.500' : 'whiteAlpha.100'}
                              display="flex"
                              alignItems="center"
                              justifyContent="center"
                              transition="all 0.3s"
                            >
                              <Icon
                                as={FiImage}
                                boxSize={10}
                                color={isDraggingThumbnail ? 'white' : 'whiteAlpha.600'}
                              />
                            </Box>
                            <Box>
                              <Text color="white" fontWeight="bold" fontSize="lg">
                                {isDraggingThumbnail ? 'Drop it!' : 'Add a thumbnail'}
                              </Text>
                              <Text color="whiteAlpha.500" fontSize="sm">
                                Drag & drop or click to browse
                              </Text>
                            </Box>
                          </VStack>
                        </MotionBox>
                      )}
                    </FormControl>

                    {/* Submit button - MEGA CHUNKY */}
                    <MotionBox
                      initial={{ y: 20, opacity: 0 }}
                      animate={{ y: 0, opacity: 1 }}
                      transition={{ ...bounceConfig, delay: 0.4 }}
                    >
                      <Button
                        type="submit"
                        size="lg"
                        h={16}
                        w="100%"
                        fontSize="xl"
                        fontWeight="black"
                        bgGradient="linear(135deg, #00FFFF 0%, #FF00FF 50%, #FFFF00 100%)"
                        backgroundSize="200% 200%"
                        color="black"
                        borderRadius="2xl"
                        leftIcon={<FiCheck />}
                        isLoading={isSubmitting}
                        loadingText={isEditMode ? 'Saving...' : 'Creating...'}
                        _hover={{
                          transform: 'translateY(-4px) scale(1.02)',
                          boxShadow: '0 20px 60px -20px rgba(0, 255, 255, 0.6), 0 0 100px -20px rgba(255, 0, 255, 0.4)',
                        }}
                        _active={{
                          transform: 'translateY(0) scale(0.98)',
                        }}
                        transition="all 0.3s cubic-bezier(0.4, 0, 0.2, 1)"
                        sx={{
                          animation: `${glowPulse} 3s ease-in-out infinite`,
                        }}
                      >
                        {isEditMode ? 'Save Changes' : 'Create Site'}
                      </Button>
                    </MotionBox>
                  </VStack>
                </MotionBox>
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
  const bbox: BoundingBox = { minX: 180, minY: 90, maxX: -180, maxY: -90 };

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
        for (const c of coords) processCoords(c);
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
