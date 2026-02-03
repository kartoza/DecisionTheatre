import {
  Box,
  Button,
  Container,
  Flex,
  Grid,
  Heading,
  HStack,
  Icon,
  IconButton,
  Image,
  Skeleton,
  Text,
  Tooltip,
  VStack,
  useColorModeValue,
  useToast,
} from '@chakra-ui/react';
import { motion } from 'framer-motion';
import { useCallback, useEffect, useState } from 'react';
import {
  FiArrowLeft,
  FiCopy,
  FiFolder,
  FiFolderPlus,
  FiPlus,
  FiTrash2,
} from 'react-icons/fi';
import type { AppPage, Project } from '../types';

const MotionBox = motion(Box);

interface ProjectsPageProps {
  onNavigate: (page: AppPage) => void;
  onOpenProject: (project: Project) => void;
  onCloneProject: (project: Project) => void;
}

function ProjectsPage({ onNavigate, onOpenProject, onCloneProject }: ProjectsPageProps) {
  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);
  const toast = useToast();

  const cardBg = useColorModeValue('whiteAlpha.100', 'whiteAlpha.50');
  const borderColor = useColorModeValue('whiteAlpha.300', 'whiteAlpha.200');
  const hoverBg = useColorModeValue('whiteAlpha.200', 'whiteAlpha.100');
  const overlayBg = useColorModeValue(
    'linear-gradient(180deg, rgba(17,24,39,0.95) 0%, rgba(17,24,39,0.85) 100%)',
    'linear-gradient(180deg, rgba(17,24,39,0.97) 0%, rgba(17,24,39,0.9) 100%)'
  );

  const fetchProjects = useCallback(async () => {
    try {
      const response = await fetch('/api/projects');
      if (response.ok) {
        const data = await response.json();
        setProjects(data || []);
      }
    } catch (error) {
      console.error('Failed to fetch projects:', error);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchProjects();
  }, [fetchProjects]);

  const handleDelete = async (project: Project, e: React.MouseEvent) => {
    e.stopPropagation();
    if (!confirm(`Are you sure you want to delete "${project.title}"?`)) return;

    try {
      const response = await fetch(`/api/projects/${project.id}`, {
        method: 'DELETE',
      });
      if (response.ok) {
        setProjects((prev) => prev.filter((p) => p.id !== project.id));
        toast({
          title: 'Project deleted',
          status: 'success',
          duration: 3000,
        });
      }
    } catch (error) {
      toast({
        title: 'Failed to delete project',
        status: 'error',
        duration: 3000,
      });
    }
  };

  const handleClone = (project: Project, e: React.MouseEvent) => {
    e.stopPropagation();
    onCloneProject(project);
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
        backgroundImage="url('https://images.unsplash.com/photo-1501854140801-50d01698950b?auto=format&fit=crop&w=2000&q=80')"
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
        <Container maxW="container.xl" pt={8}>
          {/* Header */}
          <Flex justify="space-between" align="center" mb={8}>
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
                _hover={{ bg: 'whiteAlpha.200' }}
              >
                Back to Home
              </Button>
            </MotionBox>
          </Flex>

          {/* Title section */}
          <MotionBox
            textAlign="center"
            mb={12}
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.6 }}
          >
            <Heading
              as="h1"
              fontSize={{ base: '3xl', md: '4xl' }}
              color="white"
              mb={4}
            >
              <Icon as={FiFolder} mr={4} verticalAlign="middle" />
              Your{' '}
              <Text as="span" bgGradient="linear(to-r, brand.300, accent.300)" bgClip="text">
                Projects
              </Text>
            </Heading>
            <Text fontSize="lg" color="whiteAlpha.800">
              Open an existing project or create a new one
            </Text>
          </MotionBox>

          {/* Action buttons */}
          <Flex justify="center" mb={12}>
            <MotionBox
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.5, delay: 0.2 }}
            >
              <Button
                size="lg"
                colorScheme="brand"
                leftIcon={<FiFolderPlus />}
                onClick={() => onNavigate('create')}
                _hover={{
                  transform: 'translateY(-2px)',
                  boxShadow: '0 10px 30px -10px rgba(43, 176, 237, 0.5)',
                }}
                transition="all 0.2s"
                px={8}
              >
                Create New Project
              </Button>
            </MotionBox>
          </Flex>

          {/* Projects grid */}
          {loading ? (
            <Grid
              templateColumns={{ base: '1fr', md: 'repeat(2, 1fr)', lg: 'repeat(3, 1fr)' }}
              gap={6}
            >
              {[1, 2, 3].map((i) => (
                <Skeleton key={i} height="280px" borderRadius="xl" />
              ))}
            </Grid>
          ) : projects.length === 0 ? (
            <MotionBox
              textAlign="center"
              py={16}
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ duration: 0.5, delay: 0.3 }}
            >
              <Box
                bg={cardBg}
                backdropFilter="blur(10px)"
                borderRadius="2xl"
                p={12}
                border="1px solid"
                borderColor={borderColor}
                maxW="500px"
                mx="auto"
              >
                <Icon as={FiFolder} boxSize={16} color="whiteAlpha.400" mb={6} />
                <Heading size="md" color="white" mb={4}>
                  No Projects Yet
                </Heading>
                <Text color="whiteAlpha.700" mb={8}>
                  Create your first project to start exploring landscape scenarios
                </Text>
                <Button
                  colorScheme="brand"
                  leftIcon={<FiPlus />}
                  onClick={() => onNavigate('create')}
                >
                  Create Your First Project
                </Button>
              </Box>
            </MotionBox>
          ) : (
            <Grid
              templateColumns={{ base: '1fr', md: 'repeat(2, 1fr)', lg: 'repeat(3, 1fr)' }}
              gap={6}
            >
              {projects.map((project, index) => (
                <MotionBox
                  key={project.id}
                  initial={{ opacity: 0, y: 20 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ duration: 0.4, delay: 0.1 * index }}
                >
                  <Box
                    bg={cardBg}
                    backdropFilter="blur(10px)"
                    borderRadius="xl"
                    overflow="hidden"
                    border="1px solid"
                    borderColor={borderColor}
                    cursor="pointer"
                    onClick={() => onOpenProject(project)}
                    _hover={{
                      bg: hoverBg,
                      transform: 'translateY(-4px)',
                      boxShadow: '0 20px 40px -15px rgba(0,0,0,0.4)',
                    }}
                    transition="all 0.2s"
                  >
                    {/* Thumbnail */}
                    <Box
                      h="160px"
                      overflow="hidden"
                      position="relative"
                      bg="gray.800"
                    >
                      {project.thumbnail ? (
                        <Image
                          src={project.thumbnail}
                          alt={project.title}
                          objectFit="cover"
                          w="100%"
                          h="100%"
                        />
                      ) : (
                        <Flex
                          align="center"
                          justify="center"
                          h="100%"
                          bg="linear-gradient(135deg, rgba(43,176,237,0.3) 0%, rgba(255,152,0,0.3) 100%)"
                        >
                          <Icon as={FiFolder} boxSize={12} color="whiteAlpha.400" />
                        </Flex>
                      )}
                      {/* Action buttons overlay */}
                      <HStack
                        position="absolute"
                        top={2}
                        right={2}
                        spacing={1}
                        opacity={0}
                        _groupHover={{ opacity: 1 }}
                        sx={{
                          'div:hover &': { opacity: 1 },
                        }}
                      >
                        <Tooltip label="Clone project">
                          <IconButton
                            aria-label="Clone project"
                            icon={<FiCopy />}
                            size="sm"
                            variant="solid"
                            bg="blackAlpha.600"
                            color="white"
                            _hover={{ bg: 'brand.500' }}
                            onClick={(e) => handleClone(project, e)}
                          />
                        </Tooltip>
                        <Tooltip label="Delete project">
                          <IconButton
                            aria-label="Delete project"
                            icon={<FiTrash2 />}
                            size="sm"
                            variant="solid"
                            bg="blackAlpha.600"
                            color="white"
                            _hover={{ bg: 'red.500' }}
                            onClick={(e) => handleDelete(project, e)}
                          />
                        </Tooltip>
                      </HStack>
                    </Box>

                    {/* Content */}
                    <VStack align="start" p={5} spacing={2}>
                      <Heading size="sm" color="white" noOfLines={1}>
                        {project.title}
                      </Heading>
                      <Text color="whiteAlpha.700" fontSize="sm" noOfLines={2} minH="40px">
                        {project.description || 'No description'}
                      </Text>
                      <Text color="whiteAlpha.500" fontSize="xs">
                        Created {new Date(project.createdAt).toLocaleDateString()}
                      </Text>
                    </VStack>
                  </Box>
                </MotionBox>
              ))}
            </Grid>
          )}
        </Container>
      </Box>
    </Box>
  );
}

export default ProjectsPage;
