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
import { FiLayers, FiHelpCircle, FiHome, FiMapPin, FiMap, FiEdit2, FiBarChart2 } from 'react-icons/fi';
import { useServerInfo } from '../hooks/useApi';
import type { AppPage } from '../types';
import rewildLogo from '../assets/rewild_logo_white.png';
import { colors } from '../styles/colors';

interface HeaderProps {
  onToggleDocs: () => void;
  isDocsOpen: boolean;
  onNavigate?: (page: AppPage) => void;
  currentPage?: AppPage;
  siteTitle?: string | null;
  onEditBoundary?: () => void;
  isBoundaryEditMode?: boolean;
}

function Header({ onToggleDocs, isDocsOpen, onNavigate, currentPage, siteTitle, onEditBoundary, isBoundaryEditMode }: HeaderProps) {
  const { info } = useServerInfo();
  const bgColor = useColorModeValue('white', 'gray.800');
  const borderColor = useColorModeValue('gray.200', 'gray.700');
  const siteTitleColor = useColorModeValue('gray.700', 'gray.200');

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
        <img 
        style={{width: "150px"}}
        src={rewildLogo} alt="Rewild Capital Logo" />
        {info?.version && (
          <Badge
            bg={colors.darkGreen}
            color={colors.dark}
            variant="subtle"
            fontSize="xs"
            borderRadius="full"
          >
            v{info.version}
          </Badge>
        )}
        {/* Site title - show when viewing a site */}
        {siteTitle && (currentPage === 'map' || currentPage === 'indicators') && (
          <>
            <Text color="gray.400" fontSize="lg" fontWeight="light" mx={2}>
              /
            </Text>
            <Text
              fontSize="md"
              fontWeight="semibold"
              color={siteTitleColor}
              maxW="300px"
              isTruncated
            >
              {siteTitle}
            </Text>
            {onEditBoundary && currentPage === 'map' && (
              <Tooltip label={isBoundaryEditMode ? "Exit edit mode" : "Edit site boundary"}>
                <IconButton
                  aria-label="Edit site boundary"
                  icon={<FiEdit2 />}
                  size="xs"
                  ml={2}
                  variant={isBoundaryEditMode ? "solid" : "ghost"}
                  colorScheme={isBoundaryEditMode ? "cyan" : "gray"}
                  onClick={onEditBoundary}
                  _hover={{
                    bg: isBoundaryEditMode ? "cyan.600" : "gray.100",
                  }}
                />
              </Tooltip>
            )}
          </>
        )}
      </HStack>

      <Spacer />

      <HStack spacing={2}>
        {/* Navigation buttons - always show Sites, show Home on non-landing pages */}
        {onNavigate && (
          <HStack spacing={1} display={{ base: 'none', md: 'flex' }}>
            {currentPage && currentPage !== 'landing' && (
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
            )}
            <Tooltip label="My Sites">
              <IconButton
                aria-label="Go to sites"
                icon={<FiMapPin />}
                onClick={() => onNavigate('sites')}
                variant={currentPage === 'sites' ? 'solid' : 'ghost'}
                colorScheme="brand"
                size="sm"
              />
            </Tooltip>
            {(currentPage === 'map' || currentPage === 'indicators') && (
              <>
                <Tooltip label="Map view">
                  <IconButton
                    aria-label="Map view"
                    icon={<FiMap />}
                    onClick={() => onNavigate('map')}
                    variant={currentPage === 'map' ? 'solid' : 'ghost'}
                    colorScheme="brand"
                    size="sm"
                  />
                </Tooltip>
                {siteTitle && (
                  <Tooltip label="Site indicators">
                    <IconButton
                      aria-label="Indicators"
                      icon={<FiBarChart2 />}
                      onClick={() => onNavigate('indicators')}
                      variant={currentPage === 'indicators' ? 'solid' : 'ghost'}
                      colorScheme="brand"
                      size="sm"
                    />
                  </Tooltip>
                )}
              </>
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
