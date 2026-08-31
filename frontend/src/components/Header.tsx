import {
  Box,
  Flex,
  IconButton,
  Spacer,
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
import { FiHelpCircle, FiHome, FiMapPin, FiMap, FiEdit2, FiTable, FiDownload, FiSettings } from 'react-icons/fi';
import { clearBrowserAppCache } from '../types';
import type { AppPage } from '../types';
import { getAppRuntime } from '../types/runtime';
import rewildLogo from '../assets/logo-vertical-white-3x 1.png';
import fefaLogo from '../assets/JM_FEFA_Logo_Light_LightLightText_RGB_72dpi_aw.png';
import { colors } from '../styles/colors';
import GridControls from './GridControls';
import type { RangeMode, ViewMode } from '../types';

/** Compact area for the header, where there is no room for six digits. */
function formatArea(km2: number): string {
  if (!Number.isFinite(km2)) return '—';
  if (km2 >= 1000) return `${(km2 / 1000).toFixed(1)}K`;
  if (km2 >= 100) return km2.toFixed(0);
  return km2.toFixed(1);
}

interface HeaderProps {
  onToggleDocs: () => void;
  isDocsOpen: boolean;
  onNavigate?: (page: AppPage) => void;
  currentPage?: AppPage;
  siteTitle?: string | null;
  /**
   * Facts about the open site, shown once here rather than repeated in every
   * pane. The area is the site's own total — not any factor's valid area, which
   * is a smaller and per-factor number and stays with the factor.
   */
  siteAreaKm2?: number | null;
  siteCatchmentCount?: number | null;
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
    is3DMode?: boolean;
    onIs3DModeChange?: (enabled: boolean) => void;
    isChoroplethEnabled?: boolean;
    onChoroplethEnabledChange?: (enabled: boolean) => void;
    isIdentifyMode?: boolean;
    onIdentifyModeChange?: (enabled: boolean) => void;
    isGoogleBasemap?: boolean;
    onGoogleBasemapChange?: (enabled: boolean) => void;
    isSwiperEnabled?: boolean;
    onSwiperEnabledChange?: (enabled: boolean) => void;
  };
}

function Header({ onToggleDocs, isDocsOpen, onNavigate, currentPage, siteTitle, siteAreaKm2, siteCatchmentCount, onEditBoundary, isBoundaryEditMode, gridControls }: HeaderProps) {
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

      {/*
        Gated on the props being supplied, not on the page name. The pane grid
        renders on 'map' and on 'explore' — exploring without a site selected is
        the same screen — and only that render passes gridControls at all, so
        the props are the signal. Naming a page here hid the whole cluster in
        explore mode.
      */}
      {gridControls && <GridControls {...gridControls} />}

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
                      // The same table glyph the Table view mode uses, because
                      // that is what the page is: every indicator listed with
                      // its reference, current and target. A bar chart suggested
                      // a chart view, which is a different thing and already has
                      // its own control.
                      icon={<FiTable />}
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

        {/*
          Facts about the open site. Every table pane used to carry its own copy
          of both, so a six-pane grid stated the same area and the same catchment
          count six times over. They belong to the site, so they are stated once.

          The Tiles badge that used to sit here is gone: it reported a condition
          the application already refuses to start without.
        */}
        {currentPage === 'map' && (siteAreaKm2 != null || siteCatchmentCount != null) && (
          <HStack spacing={3} display={{ base: 'none', md: 'flex' }} pr={1}>
            {siteAreaKm2 != null && (
              <Tooltip label="Total area of the open site">
                <HStack spacing={1} color="gray.400">
                  <Text fontSize="xs" fontWeight="600" color="gray.200">
                    {formatArea(siteAreaKm2)}
                  </Text>
                  <Text fontSize="xs">km²</Text>
                </HStack>
              </Tooltip>
            )}
            {siteCatchmentCount != null && (
              <Tooltip label="Catchments in the site boundary">
                <HStack spacing={1} color="gray.400">
                  <Text fontSize="xs" fontWeight="600" color="gray.200">
                    {siteCatchmentCount.toLocaleString()}
                  </Text>
                  <Text fontSize="xs">{siteCatchmentCount === 1 ? 'catchment' : 'catchments'}</Text>
                </HStack>
              </Tooltip>
            )}
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
