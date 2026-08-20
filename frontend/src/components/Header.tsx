import {
  Box,
  Flex,
  IconButton,
  Spacer,
  Badge,
  HStack,
  Text,
  useColorModeValue,
  Tooltip,
  Modal,
  ModalOverlay,
  ModalContent,
  ModalHeader,
  ModalCloseButton,
  ModalBody,
  ModalFooter,
  Button,
  useDisclosure,
} from '@chakra-ui/react';
import { FiLayers, FiHelpCircle, FiHome, FiMapPin, FiMap, FiEdit2, FiBarChart2, FiDownload, FiSettings } from 'react-icons/fi';
import { useServerInfo } from '../hooks/useApi';
import { clearBrowserAppCache } from '../types';
import type { AppPage } from '../types';
import { getAppRuntime } from '../types/runtime';
import rewildLogo from '../assets/logo-vertical-white-3x 1.png';
import fefaLogo from '../assets/JM_FEFA_Logo_Light_LightLightText_RGB_72dpi_aw.png';
import { colors } from '../styles/colors';
import GridControls from './GridControls';
import type { RangeMode, ViewMode } from '../types';

interface HeaderProps {
  onToggleDocs: () => void;
  isDocsOpen: boolean;
  onNavigate?: (page: AppPage) => void;
  currentPage?: AppPage;
  siteTitle?: string | null;
  onEditBoundary?: () => void;
  isBoundaryEditMode?: boolean;
  onToggleTargetModal?: () => void;
  isTargetModalOpen?: boolean;

  // The grid-wide controls, previously a full-width bar above the panes. They
  // are passed rather than read from context because every piece of this state
  // already lives in App, and threading it here keeps one owner.
  gridControls?: {
    viewMode: ViewMode;
    onViewModeChange: (mode: ViewMode) => void;
    rangeMode?: RangeMode;
    onRangeModeChange?: (mode: RangeMode) => void;
    onAddPane?: () => void;
    onOpenTargets?: () => void;
    hasTargets?: boolean;
    siteId?: string | null;
    isExtracting?: boolean;
  };
}

function Header({ onToggleDocs, isDocsOpen, onNavigate, currentPage, siteTitle, onEditBoundary, isBoundaryEditMode, gridControls }: HeaderProps) {
  const { info } = useServerInfo();
  const isBrowser = getAppRuntime() === 'browser';
  const bgColor = useColorModeValue('white', colors.darkGray);
  const borderColor = useColorModeValue('gray.200', 'gray.700');
  const siteTitleColor = useColorModeValue('gray.700', 'gray.200');
  const { isOpen: isClearCacheOpen, onOpen: onOpenClearCache, onClose: onCloseClearCache } = useDisclosure();

  const handleClearCache = () => {
    clearBrowserAppCache();
    window.location.reload();
  };

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
        style={{width: "120px"}}
        src={fefaLogo} alt="FEFA Logo" />
        <img 
        style={{width: "80px"}}
        src={rewildLogo} alt="Rewild Capital Logo" />
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

      {gridControls && currentPage === 'map' && (
        <GridControls {...gridControls} />
      )}

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
            <Box id="tour-nav-sites" display="inline-flex">
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
            </Box>
            {(currentPage === 'map' || currentPage === 'indicators') && (
              <>
                <Tooltip label="Map view">
                  <IconButton
                    id="tour-nav-map"
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

        {isBrowser && onNavigate && (
          <Tooltip label="Download">
            <IconButton
              aria-label="Download"
              icon={<FiDownload />}
              onClick={() => onNavigate('download')}
              variant={currentPage === 'download' ? 'solid' : 'ghost'}
              colorScheme="brand"
              size="sm"
            />
          </Tooltip>
        )}

        {isBrowser && (
          <Tooltip label="Clear cache">
            <IconButton
              aria-label="Clear cache"
              icon={<FiSettings />}
              onClick={onOpenClearCache}
              variant="ghost"
              colorScheme="brand"
              size="sm"
            />
          </Tooltip>
        )}

        {!isBrowser && onNavigate && (
          <Tooltip label="Reinstall data pack">
            <IconButton
              aria-label="Reinstall data pack"
              icon={<FiSettings />}
              onClick={() => onNavigate('setup')}
              variant={currentPage === 'setup' ? 'solid' : 'ghost'}
              colorScheme="brand"
              size="sm"
            />
          </Tooltip>
        )}

        <Tooltip label="Documentation">
          <IconButton
            id="tour-nav-docs"
            aria-label="Toggle documentation"
            icon={<FiHelpCircle />}
            onClick={onToggleDocs}
            variant={isDocsOpen ? 'solid' : 'ghost'}
            colorScheme="brand"
            size="sm"
          />
        </Tooltip>
      </HStack>

      <Modal isOpen={isClearCacheOpen} onClose={onCloseClearCache} size="md" isCentered>
        <ModalOverlay />
        <ModalContent bg="gray.800" color="white">
          <ModalHeader>Clear cache</ModalHeader>
          <ModalCloseButton />
          <ModalBody>
            <Text fontSize="sm" color="gray.300">
              This clears display and session settings stored in this browser (layout,
              last-viewed page, tour progress) and reloads the app. Your saved sites are
              not affected.
            </Text>
          </ModalBody>
          <ModalFooter>
            <Button variant="ghost" mr={3} onClick={onCloseClearCache}>Cancel</Button>
            <Button colorScheme="red" onClick={handleClearCache}>Clear cache</Button>
          </ModalFooter>
        </ModalContent>
      </Modal>
    </Flex>
  );
}

export default Header;
