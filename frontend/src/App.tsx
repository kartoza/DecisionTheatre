import { useState, useCallback, useEffect, useRef } from 'react';
import { Box, Flex, useDisclosure } from '@chakra-ui/react';
import ContentArea from './components/ContentArea';
import ControlPanel from './components/ControlPanel';
import Header from './components/Header';
import DocsPanel from './components/DocsPanel';
import SetupGuide from './components/SetupGuide';
import LandingPage from './components/LandingPage';
import AboutPage from './components/AboutPage';
import SitesPage from './components/SitesPage';
import SiteCreationPage from './components/SiteCreationPage';
import IndicatorEditorPage from './components/IndicatorEditorPage';
import { patchSite, useServerInfo } from './hooks/useApi';
import type { Scenario, LayoutMode, PaneStates, ComparisonState, AppPage, Site, IdentifyResult, MapExtent, MapStatistics } from './types';
import {
  loadPaneStates,
  savePaneStates,
  loadLayoutMode,
  saveLayoutMode,
  loadFocusedPane,
  saveFocusedPane,
  loadCurrentPage,
  saveCurrentPage,
  loadCurrentSite,
  saveCurrentSite,
} from './types';

function App() {
  const { isOpen: isDocsOpen, onToggle: onToggleDocs, onClose: onCloseDocs } = useDisclosure({ defaultIsOpen: false });
  const [layoutMode, setLayoutMode] = useState<LayoutMode>(loadLayoutMode);
  const [focusedPane, setFocusedPane] = useState<number>(loadFocusedPane);
  const [paneStates, setPaneStates] = useState<PaneStates>(loadPaneStates);
  const [indicatorPaneIndex, setIndicatorPaneIndex] = useState<number | null>(() => {
    // Auto-open filter panel for the focused pane when starting in single mode
    const mode = loadLayoutMode();
    return mode === 'single' ? loadFocusedPane() : null;
  });
  const [currentPage, setCurrentPage] = useState<AppPage>(loadCurrentPage);
  const [currentSiteId, setCurrentSiteId] = useState<string | null>(loadCurrentSite);
  const [currentSite, setCurrentSite] = useState<Site | null>(null);
  const [editSite, setEditSite] = useState<Site | null>(null);
  const [identifyResult, setIdentifyResult] = useState<IdentifyResult>(null);
  const [mapExtent, setMapExtent] = useState<MapExtent | null>(null);
  const [isExploreMode, setIsExploreMode] = useState(() => loadCurrentPage() === 'explore');
  const [mapStatistics, setMapStatistics] = useState<MapStatistics | null>(null);
  const [isBoundaryEditMode, setIsBoundaryEditMode] = useState(false);
  const [isSwiperEnabled, setIsSwiperEnabled] = useState(true);
  const { info } = useServerInfo();

  // Persist state changes to local storage
  useEffect(() => { savePaneStates(paneStates); }, [paneStates]);
  useEffect(() => { saveLayoutMode(layoutMode); }, [layoutMode]);
  useEffect(() => { saveFocusedPane(focusedPane); }, [focusedPane]);
  useEffect(() => { saveCurrentPage(currentPage); }, [currentPage]);
  useEffect(() => { saveCurrentSite(currentSiteId); }, [currentSiteId]);

  // Auto-save site state when user interacts with the map (debounced)
  const siteAutoSaveTimerRef = useRef<number | null>(null);
  const isLoadingSiteRef = useRef(false); // Prevent saving while loading

  useEffect(() => {
    // Don't save if no site is open, we're loading a site, or on create-site page
    if (!currentSiteId || isLoadingSiteRef.current || currentPage === 'create-site') {
      return;
    }

    // Clear any existing timer
    if (siteAutoSaveTimerRef.current) {
      clearTimeout(siteAutoSaveTimerRef.current);
    }

    // Debounce the save by 1 second to avoid spamming the API
    siteAutoSaveTimerRef.current = window.setTimeout(() => {
      // Save current state to the site via API
      patchSite(currentSiteId, {
          paneStates,
          layoutMode,
          focusedPane,
      }).catch((err) => {
        console.error('Failed to auto-save site state:', err);
      });
    }, 1000);

    return () => {
      if (siteAutoSaveTimerRef.current) {
        clearTimeout(siteAutoSaveTimerRef.current);
      }
    };
  }, [currentSiteId, paneStates, layoutMode, focusedPane, currentPage]);

  // Navigate to a page
  const handleNavigate = useCallback((page: AppPage) => {
    if (page === 'explore') {
      // Explore mode: go to map with side panel open, no site context
      setCurrentSiteId(null);
      setCurrentSite(null);
      setIsExploreMode(true);
      setLayoutMode('single');
      setFocusedPane(0);
      setIndicatorPaneIndex(0); // Open side panel
      setCurrentPage('explore'); // Save as 'explore' so we can restore isExploreMode
    } else if (page === 'map') {
      // Regular map mode (from opening a site)
      setCurrentPage('map');
    } else {
      // Non-map pages
      setCurrentPage(page);
      setIsExploreMode(false);
      if (page !== 'create-site') {
        setEditSite(null);
      }
    }
  }, []);

  // Open a site and go to map view
  const handleOpenSite = useCallback(async (site: Site) => {
    // Prevent auto-save while loading site state
    isLoadingSiteRef.current = true;

    setCurrentSiteId(site.id);
    setCurrentSite(site); // Store full site for title and bounds
    setIsExploreMode(false); // Exit explore mode when opening a site

    // Load site state - restore pane states including indicator selections
    if (site.paneStates) {
      setPaneStates(site.paneStates);
    }
    if (site.layoutMode) {
      setLayoutMode(site.layoutMode);
    }
    // Set focused pane and always open the side panel to show indicators
    const paneIdx = typeof site.focusedPane === 'number' ? site.focusedPane : 0;
    setFocusedPane(paneIdx);
    setIndicatorPaneIndex(paneIdx); // Always open side panel when opening a site
    setCurrentPage('map');

    // Re-enable auto-save after a short delay to allow state to settle
    setTimeout(() => {
      isLoadingSiteRef.current = false;
    }, 500);
  }, []);

  // Clone a site - navigates to create-site with site data pre-filled
  const handleCloneSite = useCallback((site: Site) => {
    // Set editSite to pre-fill the form, but it will create a new site
    // since we're going to the create-site page without an existing ID
    setEditSite({ ...site, id: '', title: `${site.title} (Copy)` });
    setCurrentPage('create-site');
  }, []);

  // Edit a site
  const handleEditSite = useCallback((site: Site) => {
    setEditSite(site);
    setCurrentPage('create-site');
  }, []);

  // Handle site created (or updated)
  const handleSiteCreated = useCallback((site: Site) => {
    setEditSite(null); // Clear edit state
    handleOpenSite(site);
  }, [handleOpenSite]);

  // Switch to single pane (focus a specific pane) and show its filter panel
  const handleFocusPane = useCallback((paneIndex: number) => {
    setFocusedPane(paneIndex);
    setLayoutMode('single');
    setIndicatorPaneIndex(paneIndex);
  }, []);

  // Switch to quad mode and hide filter panel
  const handleGoQuad = useCallback(() => {
    setLayoutMode('quad');
    setIndicatorPaneIndex(null);
  }, []);

  // Update a specific pane's comparison state
  const handlePaneStateChange = useCallback((paneIndex: number, partial: Partial<ComparisonState>) => {
    setPaneStates((prev) => {
      const next = [...prev] as PaneStates;
      next[paneIndex] = { ...next[paneIndex], ...partial };
      return next;
    });
  }, []);

  const handleLeftChange = useCallback((scenario: Scenario) => {
    if (indicatorPaneIndex !== null)
      handlePaneStateChange(indicatorPaneIndex, { leftScenario: scenario });
  }, [indicatorPaneIndex, handlePaneStateChange]);

  const handleRightChange = useCallback((scenario: Scenario) => {
    if (indicatorPaneIndex !== null)
      handlePaneStateChange(indicatorPaneIndex, { rightScenario: scenario });
  }, [indicatorPaneIndex, handlePaneStateChange]);

  const handleAttributeChange = useCallback((attribute: string) => {
    if (indicatorPaneIndex !== null)
      handlePaneStateChange(indicatorPaneIndex, { attribute });
  }, [indicatorPaneIndex, handlePaneStateChange]);

  const handleIdentify = useCallback((result: IdentifyResult) => {
    setIdentifyResult(result);
    // Open the side panel if not already open
    if (indicatorPaneIndex === null) {
      setIndicatorPaneIndex(focusedPane);
    }
  }, [indicatorPaneIndex, focusedPane]);

  // Track map extent changes
  const handleMapExtentChange = useCallback((extent: MapExtent) => {
    setMapExtent(extent);
  }, []);

  // Track map statistics changes
  const handleStatisticsChange = useCallback((stats: MapStatistics) => {
    setMapStatistics(stats);
  }, []);

  // Navigate to create site page from explore mode
  const handleNavigateToCreateSite = useCallback(() => {
    setCurrentPage('create-site');
  }, []);

  // Toggle boundary edit mode
  const handleToggleBoundaryEdit = useCallback(() => {
    setIsBoundaryEditMode(prev => !prev);
  }, []);

  // Handle geometry update from boundary editing
  const handleBoundaryUpdate = useCallback(async (newGeometry: GeoJSON.Geometry) => {
    if (!currentSiteId) return;

    try {
      const updatedSite = await patchSite(currentSiteId, { geometry: newGeometry });
      setCurrentSite(updatedSite);
    } catch (err) {
      console.error('Failed to update site boundary:', err);
    }
  }, [currentSiteId]);

  const isIndicatorOpen = indicatorPaneIndex !== null;

  // Show setup guide when tiles aren't loaded (on map/explore pages)
  if ((currentPage === 'map' || currentPage === 'explore') && info && !info.tiles_loaded) {
    return <SetupGuide info={info} />;
  }

  // Render landing/about/sites/create-site pages
  if (currentPage === 'landing') {
    return (
      <Flex direction="column" h="100vh" overflow="hidden">
        <Header
          onToggleDocs={onToggleDocs}
          isDocsOpen={isDocsOpen}
          onNavigate={handleNavigate}
          currentPage={currentPage}
        />
        <Box flex={1} overflow="hidden">
          <LandingPage onNavigate={handleNavigate} />
        </Box>
        <DocsPanel isOpen={isDocsOpen} onClose={onCloseDocs} />
      </Flex>
    );
  }

  if (currentPage === 'about') {
    return (
      <Flex direction="column" h="100vh" overflow="hidden">
        <Header
          onToggleDocs={onToggleDocs}
          isDocsOpen={isDocsOpen}
          onNavigate={handleNavigate}
          currentPage={currentPage}
        />
        <Box flex={1} overflow="auto">
          <AboutPage onNavigate={handleNavigate} />
        </Box>
        <DocsPanel isOpen={isDocsOpen} onClose={onCloseDocs} />
      </Flex>
    );
  }

  if (currentPage === 'sites') {
    return (
      <Flex direction="column" h="100vh" overflow="hidden">
        <Header
          onToggleDocs={onToggleDocs}
          isDocsOpen={isDocsOpen}
          onNavigate={handleNavigate}
          currentPage={currentPage}
        />
        <Box flex={1} overflow="auto">
          <SitesPage
            onNavigate={handleNavigate}
            onOpenSite={handleOpenSite}
            onCloneSite={handleCloneSite}
            onEditSite={handleEditSite}
          />
        </Box>
        <DocsPanel isOpen={isDocsOpen} onClose={onCloseDocs} />
      </Flex>
    );
  }

  if (currentPage === 'create-site') {
    return (
      <Flex direction="column" h="100vh" overflow="hidden">
        <Header
          onToggleDocs={onToggleDocs}
          isDocsOpen={isDocsOpen}
          onNavigate={handleNavigate}
          currentPage={currentPage}
        />
        <Box flex={1} overflow="hidden">
          <SiteCreationPage
            onNavigate={handleNavigate}
            onSiteCreated={handleSiteCreated}
            initialExtent={mapExtent || undefined}
            editSite={editSite}
          />
        </Box>
        <DocsPanel isOpen={isDocsOpen} onClose={onCloseDocs} />
      </Flex>
    );
  }

  if (currentPage === 'indicators' && currentSite) {
    return (
      <Flex direction="column" h="100vh" overflow="hidden">
        <Header
          onToggleDocs={onToggleDocs}
          isDocsOpen={isDocsOpen}
          onNavigate={handleNavigate}
          currentPage={currentPage}
          siteTitle={currentSite.title}
        />
        <Box flex={1} overflow="hidden">
          <IndicatorEditorPage
            site={currentSite}
            onNavigate={handleNavigate}
            onSiteUpdated={(updatedSite: Site) => setCurrentSite(updatedSite)}
          />
        </Box>
        <DocsPanel isOpen={isDocsOpen} onClose={onCloseDocs} />
      </Flex>
    );
  }

  // Map view (default)
  return (
    <Flex direction="column" h="100vh" overflow="hidden">
      <Header
        onToggleDocs={onToggleDocs}
        isDocsOpen={isDocsOpen}
        onNavigate={handleNavigate}
        currentPage={currentPage}
        siteTitle={currentSite?.title}
        onEditBoundary={currentSite ? handleToggleBoundaryEdit : undefined}
        isBoundaryEditMode={isBoundaryEditMode}
      />

      <Flex flex={1} overflow="hidden" position="relative">
        {/* Main content area - shrinks when panel opens */}
        <Box
          flex={1}
          transition="margin-right 0.3s cubic-bezier(0.4, 0, 0.2, 1)"
          mr={isIndicatorOpen ? { base: 0, md: '400px', lg: '440px' } : 0}
          position="relative"
        >
          <ContentArea
            mode={layoutMode}
            paneStates={paneStates}
            focusedPane={focusedPane}
            onFocusPane={handleFocusPane}
            onGoQuad={handleGoQuad}
            onIdentify={handleIdentify}
            identifyResult={identifyResult}
            onMapExtentChange={handleMapExtentChange}
            onStatisticsChange={handleStatisticsChange}
            isPanelOpen={isIndicatorOpen}
            siteId={currentSiteId}
            siteBounds={currentSite?.boundingBox}
            isBoundaryEditMode={isBoundaryEditMode}
            siteGeometry={currentSite?.geometry}
            onBoundaryUpdate={handleBoundaryUpdate}
            isSwiperEnabled={isSwiperEnabled}
            onSwiperEnabledChange={setIsSwiperEnabled}
          />
        </Box>

        {/* Slide-out control panel — scoped to the active pane */}
        <ControlPanel
          isOpen={isIndicatorOpen}
          comparison={indicatorPaneIndex !== null ? paneStates[indicatorPaneIndex] : paneStates[0]}
          onLeftChange={handleLeftChange}
          onRightChange={handleRightChange}
          onAttributeChange={handleAttributeChange}
          paneIndex={indicatorPaneIndex}
          identifyResult={identifyResult}
          onClearIdentify={() => setIdentifyResult(null)}
          isExploreMode={isExploreMode}
          onNavigateToCreateSite={handleNavigateToCreateSite}
          mapStatistics={mapStatistics ?? undefined}
          isSwiperEnabled={isSwiperEnabled}
        />
      </Flex>

      {/* Docs panel - always mounted to preserve iframe navigation state */}
      <DocsPanel isOpen={isDocsOpen} onClose={onCloseDocs} />
    </Flex>
  );
}

export default App;
