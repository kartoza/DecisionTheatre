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
  Text,
  Textarea,
  VStack,
  useColorModeValue,
  useToast,
} from '@chakra-ui/react';
import { motion } from 'framer-motion';
import { useCallback, useRef, useState } from 'react';
import {
  FiArrowLeft,
  FiCheck,
  FiImage,
  FiUpload,
  FiX,
} from 'react-icons/fi';
import type { AppPage, Project } from '../types';

const MotionBox = motion(Box);

interface CreateProjectPageProps {
  onNavigate: (page: AppPage) => void;
  onProjectCreated: (project: Project) => void;
  cloneFrom?: Project | null;
}

function CreateProjectPage({ onNavigate, onProjectCreated, cloneFrom }: CreateProjectPageProps) {
  const [title, setTitle] = useState(cloneFrom ? `${cloneFrom.title} (Copy)` : '');
  const [description, setDescription] = useState(cloneFrom?.description || '');
  const [thumbnail, setThumbnail] = useState<string | null>(cloneFrom?.thumbnail || null);
  const [isDragging, setIsDragging] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const toast = useToast();

  const cardBg = useColorModeValue('whiteAlpha.100', 'whiteAlpha.50');
  const borderColor = useColorModeValue('whiteAlpha.300', 'whiteAlpha.200');
  const inputBg = useColorModeValue('whiteAlpha.100', 'blackAlpha.300');
  const overlayBg = useColorModeValue(
    'linear-gradient(180deg, rgba(17,24,39,0.95) 0%, rgba(17,24,39,0.85) 100%)',
    'linear-gradient(180deg, rgba(17,24,39,0.97) 0%, rgba(17,24,39,0.9) 100%)'
  );

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(true);
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
  }, []);

  const processImage = useCallback(async (file: File) => {
    if (!file.type.startsWith('image/')) {
      toast({
        title: 'Invalid file type',
        description: 'Please upload an image file',
        status: 'error',
        duration: 3000,
      });
      return;
    }

    // Create a canvas to crop/resize the image
    const img = new Image();
    const reader = new FileReader();

    reader.onload = (e) => {
      img.onload = () => {
        const canvas = document.createElement('canvas');
        const ctx = canvas.getContext('2d');
        if (!ctx) return;

        // Target dimensions for thumbnail (16:9 aspect ratio)
        const targetWidth = 640;
        const targetHeight = 360;

        canvas.width = targetWidth;
        canvas.height = targetHeight;

        // Calculate crop dimensions to center the image
        const sourceAspect = img.width / img.height;
        const targetAspect = targetWidth / targetHeight;

        let sourceX = 0;
        let sourceY = 0;
        let sourceWidth = img.width;
        let sourceHeight = img.height;

        if (sourceAspect > targetAspect) {
          // Image is wider, crop horizontally
          sourceWidth = img.height * targetAspect;
          sourceX = (img.width - sourceWidth) / 2;
        } else {
          // Image is taller, crop vertically
          sourceHeight = img.width / targetAspect;
          sourceY = (img.height - sourceHeight) / 2;
        }

        // Draw cropped and resized image
        ctx.drawImage(
          img,
          sourceX,
          sourceY,
          sourceWidth,
          sourceHeight,
          0,
          0,
          targetWidth,
          targetHeight
        );

        // Convert to data URL
        const dataUrl = canvas.toDataURL('image/jpeg', 0.85);
        setThumbnail(dataUrl);
      };
      img.src = e.target?.result as string;
    };

    reader.readAsDataURL(file);
  }, [toast]);

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setIsDragging(false);

      const file = e.dataTransfer.files[0];
      if (file) {
        processImage(file);
      }
    },
    [processImage]
  );

  const handleFileSelect = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (file) {
        processImage(file);
      }
    },
    [processImage]
  );

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!title.trim()) {
      toast({
        title: 'Title required',
        description: 'Please enter a project title',
        status: 'warning',
        duration: 3000,
      });
      return;
    }

    setIsSubmitting(true);

    try {
      const projectData = {
        title: title.trim(),
        description: description.trim(),
        thumbnail,
        // If cloning, copy the pane states, otherwise use defaults
        paneStates: cloneFrom?.paneStates || undefined,
        layoutMode: cloneFrom?.layoutMode || undefined,
        focusedPane: cloneFrom?.focusedPane || undefined,
      };

      const response = await fetch('/api/projects', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(projectData),
      });

      if (!response.ok) {
        throw new Error('Failed to create project');
      }

      const project = await response.json();

      toast({
        title: 'Project created',
        description: 'Your new project is ready',
        status: 'success',
        duration: 3000,
      });

      onProjectCreated(project);
    } catch (error) {
      toast({
        title: 'Error creating project',
        description: error instanceof Error ? error.message : 'Unknown error',
        status: 'error',
        duration: 3000,
      });
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <Box position="relative" w="100%" h="100%" overflow="auto">
      {/* Background */}
      <Box
        position="fixed"
        top={0}
        left={0}
        right={0}
        bottom={0}
        backgroundImage="url('https://images.unsplash.com/photo-1464822759023-fed622ff2c3b?auto=format&fit=crop&w=2000&q=80')"
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
        <Container maxW="container.md" pt={8}>
          {/* Header */}
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
              onClick={() => onNavigate('projects')}
              mb={8}
              _hover={{ bg: 'whiteAlpha.200' }}
            >
              Back to Projects
            </Button>
          </MotionBox>

          {/* Title */}
          <MotionBox
            textAlign="center"
            mb={10}
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.6 }}
          >
            <Heading
              as="h1"
              fontSize={{ base: '2xl', md: '4xl' }}
              color="white"
              mb={4}
            >
              {cloneFrom ? 'Clone' : 'Create New'}{' '}
              <Text as="span" bgGradient="linear(to-r, brand.300, accent.300)" bgClip="text">
                Project
              </Text>
            </Heading>
            {cloneFrom && (
              <Text color="whiteAlpha.700">
                Creating a copy of "{cloneFrom.title}"
              </Text>
            )}
          </MotionBox>

          {/* Form */}
          <MotionBox
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.5, delay: 0.2 }}
          >
            <Box
              as="form"
              onSubmit={handleSubmit}
              bg={cardBg}
              backdropFilter="blur(20px)"
              borderRadius="2xl"
              p={{ base: 6, md: 10 }}
              border="1px solid"
              borderColor={borderColor}
            >
              <VStack spacing={8} align="stretch">
                {/* Thumbnail upload */}
                <FormControl>
                  <FormLabel color="white" fontSize="lg" mb={4}>
                    Project Thumbnail
                  </FormLabel>
                  <Box
                    position="relative"
                    borderRadius="xl"
                    overflow="hidden"
                    border="2px dashed"
                    borderColor={isDragging ? 'brand.400' : borderColor}
                    bg={isDragging ? 'whiteAlpha.100' : 'transparent'}
                    transition="all 0.2s"
                    cursor="pointer"
                    onClick={() => fileInputRef.current?.click()}
                    onDragOver={handleDragOver}
                    onDragLeave={handleDragLeave}
                    onDrop={handleDrop}
                    _hover={{
                      borderColor: 'brand.400',
                      bg: 'whiteAlpha.50',
                    }}
                  >
                    <input
                      ref={fileInputRef}
                      type="file"
                      accept="image/*"
                      onChange={handleFileSelect}
                      style={{ display: 'none' }}
                    />

                    {thumbnail ? (
                      <Box position="relative">
                        <Box
                          as="img"
                          src={thumbnail}
                          alt="Project thumbnail"
                          w="100%"
                          h="200px"
                          objectFit="cover"
                        />
                        <Flex
                          position="absolute"
                          top={0}
                          left={0}
                          right={0}
                          bottom={0}
                          align="center"
                          justify="center"
                          bg="blackAlpha.600"
                          opacity={0}
                          transition="opacity 0.2s"
                          _hover={{ opacity: 1 }}
                        >
                          <VStack spacing={2}>
                            <Icon as={FiUpload} boxSize={8} color="white" />
                            <Text color="white" fontWeight="medium">
                              Click or drop to replace
                            </Text>
                          </VStack>
                        </Flex>
                        <Button
                          position="absolute"
                          top={2}
                          right={2}
                          size="sm"
                          colorScheme="red"
                          leftIcon={<FiX />}
                          onClick={(e) => {
                            e.stopPropagation();
                            setThumbnail(null);
                          }}
                        >
                          Remove
                        </Button>
                      </Box>
                    ) : (
                      <Flex
                        direction="column"
                        align="center"
                        justify="center"
                        py={12}
                        px={6}
                      >
                        <Icon
                          as={FiImage}
                          boxSize={12}
                          color="whiteAlpha.400"
                          mb={4}
                        />
                        <Text color="whiteAlpha.800" fontWeight="medium" mb={2}>
                          Drop an image here
                        </Text>
                        <Text color="whiteAlpha.600" fontSize="sm">
                          or click to browse
                        </Text>
                        <Text color="whiteAlpha.500" fontSize="xs" mt={2}>
                          Images will be automatically cropped to 16:9
                        </Text>
                      </Flex>
                    )}
                  </Box>
                </FormControl>

                {/* Title */}
                <FormControl isRequired>
                  <FormLabel color="white" fontSize="lg">
                    Project Title
                  </FormLabel>
                  <Input
                    value={title}
                    onChange={(e) => setTitle(e.target.value)}
                    placeholder="Enter a title for your project"
                    size="lg"
                    bg={inputBg}
                    border="1px solid"
                    borderColor={borderColor}
                    color="white"
                    _placeholder={{ color: 'whiteAlpha.500' }}
                    _hover={{ borderColor: 'whiteAlpha.400' }}
                    _focus={{
                      borderColor: 'brand.400',
                      boxShadow: '0 0 0 1px var(--chakra-colors-brand-400)',
                    }}
                  />
                </FormControl>

                {/* Description */}
                <FormControl>
                  <FormLabel color="white" fontSize="lg">
                    Description
                  </FormLabel>
                  <Textarea
                    value={description}
                    onChange={(e) => setDescription(e.target.value)}
                    placeholder="Describe your project (optional)"
                    size="lg"
                    bg={inputBg}
                    border="1px solid"
                    borderColor={borderColor}
                    color="white"
                    _placeholder={{ color: 'whiteAlpha.500' }}
                    _hover={{ borderColor: 'whiteAlpha.400' }}
                    _focus={{
                      borderColor: 'brand.400',
                      boxShadow: '0 0 0 1px var(--chakra-colors-brand-400)',
                    }}
                    rows={4}
                    resize="vertical"
                  />
                </FormControl>

                {/* Submit button */}
                <Button
                  type="submit"
                  size="lg"
                  colorScheme="brand"
                  leftIcon={<FiCheck />}
                  isLoading={isSubmitting}
                  loadingText="Creating..."
                  _hover={{
                    transform: 'translateY(-2px)',
                    boxShadow: '0 10px 30px -10px rgba(43, 176, 237, 0.5)',
                  }}
                  transition="all 0.2s"
                >
                  Create Project
                </Button>
              </VStack>
            </Box>
          </MotionBox>
        </Container>
      </Box>
    </Box>
  );
}

export default CreateProjectPage;
