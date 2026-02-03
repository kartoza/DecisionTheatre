import {
  Flex,
  Heading,
  IconButton,
  Spacer,
  Badge,
  HStack,
  Text,
  useColorModeValue,
  Tooltip,
} from '@chakra-ui/react';
import { FiLayers, FiHelpCircle, FiHome, FiFolder, FiMap } from 'react-icons/fi';
import { useServerInfo } from '../hooks/useApi';
import type { AppPage } from '../types';

interface HeaderProps {
  onToggleDocs: () => void;
  isDocsOpen: boolean;
  onNavigate?: (page: AppPage) => void;
  currentPage?: AppPage;
}

function Header({ onToggleDocs, isDocsOpen, onNavigate, currentPage }: HeaderProps) {
  const { info } = useServerInfo();
  const bgColor = useColorModeValue('white', 'gray.800');
  const borderColor = useColorModeValue('gray.200', 'gray.700');

  return (
    <Flex
      as="header"
      align="center"
      px={4}
      py={2}
      bg={bgColor}
      borderBottom="1px"
      borderColor={borderColor}
      zIndex={20}
      flexShrink={0}
      boxShadow="sm"
    >
      <HStack spacing={3}>
        <Heading
          size="md"
          bgGradient="linear(to-r, brand.400, accent.400)"
          bgClip="text"
          fontWeight="bold"
          letterSpacing="tight"
          cursor={onNavigate ? 'pointer' : 'default'}
          onClick={() => onNavigate?.('landing')}
          _hover={onNavigate ? { opacity: 0.8 } : undefined}
          transition="opacity 0.2s"
        >
          Landscape Decision Theatre
        </Heading>
        {info?.version && (
          <Badge
            colorScheme="brand"
            variant="subtle"
            fontSize="xs"
            borderRadius="full"
          >
            v{info.version}
          </Badge>
        )}
      </HStack>

      <Spacer />

      <HStack spacing={2}>
        {/* Navigation buttons - show on all pages except landing */}
        {onNavigate && currentPage && currentPage !== 'landing' && (
          <HStack spacing={1} display={{ base: 'none', md: 'flex' }}>
            <Tooltip label="Home">
              <IconButton
                aria-label="Go to home"
                icon={<FiHome />}
                onClick={() => onNavigate('landing')}
                variant="ghost"
                colorScheme="brand"
                size="sm"
              />
            </Tooltip>
            <Tooltip label="Projects">
              <IconButton
                aria-label="Go to projects"
                icon={<FiFolder />}
                onClick={() => onNavigate('projects')}
                variant={currentPage === 'projects' ? 'solid' : 'ghost'}
                colorScheme="brand"
                size="sm"
              />
            </Tooltip>
            {currentPage === 'map' && (
              <Tooltip label="Current project map">
                <IconButton
                  aria-label="Map view"
                  icon={<FiMap />}
                  variant="solid"
                  colorScheme="brand"
                  size="sm"
                  isDisabled
                />
              </Tooltip>
            )}
          </HStack>
        )}

        {/* Status indicators - only show on map page */}
        {currentPage === 'map' && (
          <HStack spacing={1} display={{ base: 'none', md: 'flex' }}>
            <Tooltip label={info?.tiles_loaded ? 'Tiles loaded' : 'No tiles'}>
              <Badge
                colorScheme={info?.tiles_loaded ? 'green' : 'gray'}
                variant="subtle"
                display="flex"
                alignItems="center"
                gap={1}
                px={2}
              >
                <FiLayers size={12} />
                <Text fontSize="xs">Tiles</Text>
              </Badge>
            </Tooltip>
          </HStack>
        )}

        <Tooltip label="Documentation">
          <IconButton
            aria-label="Toggle documentation"
            icon={<FiHelpCircle />}
            onClick={onToggleDocs}
            variant={isDocsOpen ? 'solid' : 'ghost'}
            colorScheme="brand"
            size="sm"
          />
        </Tooltip>
      </HStack>
    </Flex>
  );
}

export default Header;
