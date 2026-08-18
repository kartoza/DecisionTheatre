
import { useState, useCallback, useEffect, useRef } from 'react';
import { Box, Flex, useDisclosure, useToast } from '@chakra-ui/react';
import ContentArea from './components/ContentArea';
import ControlPanel from './components/ControlPanel';
import Header from './components/Header';
import DocsPanel from './components/DocsPanel';
import SetupGuide from './components/SetupGuide';
import LandingPage from './components/LandingPage';
import AboutPage from './components/AboutPage';
import PartnershipPage from './components/PartnershipPage';
import SitesPage from './components/SitesPage';
import SiteCreationPage from './components/SiteCreationPage';
import IndicatorEditorPage from './components/IndicatorEditorPage';
import DownloadPage from './components/DownloadPage';
import FeedbackLink from './components/FeedbackLink';
import ResumeSessionModal from './components/ResumeSessionModal';
import { patchSite, patchSiteIndicators, useServerInfo, getSite, useFullDomainPrecalculated, primeSiteCatchmentsFromEmbedded, saveLocalSite } from './hooks/useApi';
import { getAppRuntime } from './types/runtime';
import { showTargetWarningsPopup } from './utils/warnings';
import type { Scenario, LayoutMode, QuadColumns, PaneStates, ComparisonState, AppPage, Site, IdentifyResult, MapExtent, MapStatistics, ColorScaleMode, ColorScaleType, RangeMode, ViewMode } from './types';
import {
  DEFAULT_PANE_STATES,
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
  loadRangeMode,
  saveRangeMode,
  loadQuadColumns,
  saveQuadColumns,
  markSessionActive,
  shouldPromptResumeSession,
} from './types';
import { checkStorageHealth, onStorageFailure } from './lib/storage';

function App() {
  const toast = useToast();
  const { isOpen: isDocsOpen, onToggle: onToggleDocs, onClose: onCloseDocs } = useDisclosure({ defaultIsOpen: false });
  const [layoutMode, setLayoutMode] = useState<LayoutMode>(loadLayoutMode);
  const [quadColumns, setQuadColumns] = useState<QuadColumns>(loadQuadColumns);
  const [focusedPane, setFocusedPane] = useState<number>(loadFocusedPane);
  const [paneStates, setPaneStates] = useState<PaneStates>(loadPaneStates);
  const [viewModes, setViewModes] = useState<ViewMode[]>(() => loadPaneStates().map(() => 'map'));
  const [indicatorPaneIndex, setIndicatorPaneIndex] = useState<number | null>(() => {
    // Auto-open filter panel for the focused pane when starting in single mode
    const mode = loadLayoutMode();
    return mode === 'single' ? loadFocusedPane() : null;
  });
  const [currentPage, setCurrentPage] = useState<AppPage>(loadCurrentPage);
  const [currentSiteId, setCurrentSiteId] = useState<string | null>(loadCurrentSite);
  // If this is a brand-new tab (not a same-tab refresh) and there's saved
  // state worth resuming, hold off applying it until the user picks
  // "resume" or "start fresh" in ResumeSessionModal below.
  const [resumeChoice, setResumeChoice] = useState<'resume' | 'fresh' | null>(
    () => (shouldPromptResumeSession() ? null : 'resume')
  );
  const sessionDecided = resumeChoice !== null;
  const [savedPageForPrompt] = useState<AppPage>(currentPage);
  const [hadSiteForPrompt] = useState<boolean>(currentSiteId !== null);
  const currentSiteIdRef = useRef(currentSiteId);
  useEffect(() => { currentSiteIdRef.current = currentSiteId; }, [currentSiteId]);
  const [currentSite, setCurrentSite] = useState<Site | null>(null);
  const currentSiteRef = useRef(currentSite);
  useEffect(() => { currentSiteRef.current = currentSite; }, [currentSite]);
  // Tracks whether the boundary was actually edited during the current
  // edit-mode session, so exiting triggers a re-extract only when needed.
  const boundaryEditedDuringSessionRef = useRef(false);
  const [editSite, setEditSite] = useState<Site | null>(null);
  const [identifyResult, setIdentifyResult] = useState<IdentifyResult>(null);
  const [mapExtent, setMapExtent] = useState<MapExtent | null>(null);
  const [isExploreMode, setIsExploreMode] = useState(() => loadCurrentPage() === 'explore');
  const [mapStatistics, setMapStatistics] = useState<MapStatistics | null>(null);
  const [isBoundaryEditMode, setIsBoundaryEditMode] = useState(false);
  const [isSwiperEnabled, setIsSwiperEnabled] = useState(true);
  const [mapRefreshSeq, setMapRefreshSeq] = useState(0);
  const [is3DMode, setIs3DMode] = useState(false);
  const colorScaleMode: ColorScaleMode = 'metadata';
  const [colorScaleType, setColorScaleType] = useState<ColorScaleType>('linear');
  const [rangeMode, setRangeMode] = useState<RangeMode>(loadRangeMode);
  const [swiperPosition, setSwiperPosition] = useState<number>(50); // Synchronized slider position
  const [chartGroups, setChartGroups] = useState<(string | null)[]>(() => loadPaneStates().map(() => null));
  const [chartAxisLabelFilters, setChartAxisLabelFilters] = useState<(string | null)[]>(() => loadPaneStates().map(() => null));
  const [chartGraphModes, setChartGraphModes] = useState<('line' | 'boxplot' | null)[]>(() => loadPaneStates().map(() => null));
  const [isExtractingIndicators, setIsExtractingIndicators] = useState(false);
  const { info } = useServerInfo();

  // Storage failures used to be discarded, so a full quota looked like a working
  // application that quietly forgot things. Two things happen here, once each:
  //
  //   - a check on startup, so a user close to the ceiling is warned before the
  //     next thing they save is the one that fails, rather than after
  //   - a subscription to write failures, which fires once per kind of failure
  //     per session; per-write would be several toasts a minute about a pane
  //     layout, which is noise rather than information
  useEffect(() => {
    const health = checkStorageHealth();

    if (!health.available) {
      toast({
        title: 'Browser storage is unavailable',
        description:
          'Your sites and layout cannot be saved in this browser — private browsing '
          + 'or a privacy setting is blocking storage. Work will be lost when you '
          + 'close the tab.',
        status: 'warning',
        duration: null,
        isClosable: true,
      });
    } else if (health.nearLimit) {
      toast({
        title: 'Browser storage is nearly full',
        description:
          `About ${Math.round(health.usedRatio * 100)}% of the space this browser `
          + 'allows is in use. Delete a site you no longer need, or the next one you '
          + 'save may not be stored.',
        status: 'warning',
        duration: 12000,
        isClosable: true,
      });
    }

    return onStorageFailure((failure) => {
      toast({
        title: failure.kind === 'quota'
          ? 'Browser storage is full'
          : 'Browser storage is not working',
        description: failure.kind === 'quota'
          ? 'Some changes could not be saved. Delete a site you no longer need to '
            + 'free up space, then try again.'
          : 'Some changes could not be saved in this browser, so they will be lost '
            + 'when you close the tab.',
        status: 'error',
        duration: null,
        isClosable: true,
      });
    });
  }, [toast]);
  const { data: fullDomainData } = useFullDomainPrecalculated();
  const minimumQuadPaneCount = DEFAULT_PANE_STATES.length;
  const extractingIndicatorsRef = useRef(false);
  const extractingSiteIdRef = useRef<string | null>(null);
  const extractionPollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    setViewModes((prev) => {
      if (prev.length === paneStates.length) return prev;
      if (paneStates.length < prev.length) return prev.slice(0, paneStates.length);
      return [...prev, ...Array.from({ length: paneStates.length - prev.length }, () => prev[Math.min(focusedPane, prev.length - 1)] ?? 'map')];
    });

    setChartGroups((prev) => {
      if (prev.length === paneStates.length) return prev;
      if (paneStates.length < prev.length) return prev.slice(0, paneStates.length);
      return [...prev, ...Array.from({ length: paneStates.length - prev.length }, () => null)];
    });

    setChartAxisLabelFilters((prev) => {
      if (prev.length === paneStates.length) return prev;
      if (paneStates.length < prev.length) return prev.slice(0, paneStates.length);
      return [...prev, ...Array.from({ length: paneStates.length - prev.length }, () => null)];
    });

    setChartGraphModes((prev) => {
      if (prev.length === paneStates.length) return prev;
      if (paneStates.length < prev.length) return prev.slice(0, paneStates.length);
      return [...prev, ...Array.from({ length: paneStates.length - prev.length }, () => null)];
    });

    setFocusedPane((prev) => Math.min(prev, Math.max(0, paneStates.length - 1)));
    setIndicatorPaneIndex((prev) => {
      if (prev === null) return prev;
      return Math.min(prev, Math.max(0, paneStates.length - 1));
    });
  }, [focusedPane, paneStates.length]);

  // Persist state changes to local storage
  useEffect(() => { savePaneStates(paneStates); }, [paneStates]);
  useEffect(() => { saveLayoutMode(layoutMode); }, [layoutMode]);
  useEffect(() => { saveQuadColumns(quadColumns); }, [quadColumns]);
  useEffect(() => { saveFocusedPane(focusedPane); }, [focusedPane]);
  useEffect(() => { saveCurrentPage(currentPage); }, [currentPage]);
  useEffect(() => { saveCurrentSite(currentSiteId); }, [currentSiteId]);
  useEffect(() => { saveRangeMode(rangeMode); }, [rangeMode]);

  // Zone range should reflect the current viewing context rather than a
  // stale cached value: Explore mode has no site to scope to, so it always
  // defaults to the full domain, while viewing a site — including via a
  // guided tour, which opens a site under the hood — always defaults to
  // that site's own range.
  useEffect(() => {
    if (!sessionDecided) return;
    if (currentSiteId) {
      setRangeMode('site');
    } else if (isExploreMode) {
      setRangeMode('domain');
    }
  }, [sessionDecided, currentSiteId, isExploreMode]);

  // Mark this tab as having an active session, so a same-tab refresh won't
  // re-trigger the resume-session prompt (only a brand-new tab should ask).
  useEffect(() => { markSessionActive(); }, []);

  // On startup: if a site was open when the app last closed, fetch it from the API
  // so the map has access to geometry/bounds/indicators. Layout/pane state is already
  // restored from localStorage above, so we only need the site object itself.
  // Waits on the resume-session decision so a "start fresh" choice (which
  // clears currentSiteId) can pre-empt this fetch.
  const siteFetchStartedRef = useRef(false);
  useEffect(() => {
    if (!sessionDecided || siteFetchStartedRef.current) return;
    siteFetchStartedRef.current = true;
    if (!currentSiteId) return;
    const requestedSiteId = currentSiteId;
    isLoadingSiteRef.current = true;
    getSite(requestedSiteId)
      .then((site) => {
        // Bail if something else (e.g. a demo tour) already opened a different
        // site while this fetch was in flight — applying it now would silently
        // overwrite the newer site's bounds/geometry.
        if (currentSiteIdRef.current !== requestedSiteId) return;
        if (site) {
          setCurrentSite(site);
        } else {
          setCurrentSiteId(null);
          setCurrentPage('sites');
        }
      })
      .catch(() => {
        if (currentSiteIdRef.current !== requestedSiteId) return;
        setCurrentSiteId(null);
        setCurrentPage('sites');
      })
      .finally(() => {
        isLoadingSiteRef.current = false;
      });
  }, [sessionDecided, currentSiteId]);

  const stopExtractionPolling = useCallback(() => {
    if (extractionPollRef.current !== null) {
      clearInterval(extractionPollRef.current);
      extractionPollRef.current = null;
    }
    extractingIndicatorsRef.current = false;
    extractingSiteIdRef.current = null;
    setIsExtractingIndicators(false);
  }, []);

  const startBackgroundIndicatorExtraction = useCallback((site: Site | null, options?: { force?: boolean }) => {
    const force = options?.force ?? false;
    if (!site || (!force && site.indicators) || !site.catchmentIds?.length) return;
    // Already extracting this exact site — don't double-start.
    if (extractingIndicatorsRef.current && extractingSiteIdRef.current === site.id) return;

    // Cancel any in-flight poll for a different site.
    if (extractionPollRef.current !== null) {
      clearInterval(extractionPollRef.current);
      extractionPollRef.current = null;
    }

    extractingIndicatorsRef.current = true;
    extractingSiteIdRef.current = site.id;
    setIsExtractingIndicators(true);

    const runtime = getAppRuntime();
    const siteId = site.id;
    const thumbnail = site.thumbnail;

    if (runtime === 'browser') {
      // Browser: synchronous path — backend returns extracted site in response body.
      const { thumbnail: _t, ...siteWithoutThumbnail } = site;
      fetch(`/api/sites/${siteId}/indicators`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ runtime: 'browser', site: siteWithoutThumbnail }),
      })
        .then(async (response) => {
          if (!response.ok) throw new Error('Failed to extract indicators');
          const updatedSiteFromApi: Site = await response.json();
          const updatedSite: Site = { ...updatedSiteFromApi, thumbnail };
          // One site changed, so one record is written.
          if (!saveLocalSite(updatedSite)) {
            toast({
              title: 'Storage full',
              description: 'Extracted indicators could not be saved — delete some existing sites to free up space.',
              status: 'error',
              duration: 8000,
              isClosable: true,
              position: 'top',
            });
          }
          setCurrentSite((prev) => (prev?.id === siteId ? updatedSite : prev));
        })
        .catch((err) => console.error('Browser indicator extraction failed:', err))
        .finally(stopExtractionPolling);
      return;
    }

    // Webview: fire-and-forget POST, then poll GET /sites/{id}/indicators every second.
    fetch(`/api/sites/${siteId}/indicators`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ runtime: 'webview', site: {} }),
    }).catch((err) => console.error('Failed to start extraction:', err));

    let attempts = 0;
    extractionPollRef.current = setInterval(async () => {
      attempts += 1;
      if (attempts > 120) { // 2-minute safety cap
        stopExtractionPolling();
        return;
      }
      try {
        const r = await fetch(`/api/sites/${siteId}/indicators`);
        if (r.status === 202) return; // still running
        if (!r.ok) { stopExtractionPolling(); return; }
        const updatedSite = await r.json() as Site;
        if (updatedSite.indicators) {
          stopExtractionPolling();
          setCurrentSite((prev) => (prev?.id === siteId ? { ...updatedSite, thumbnail } : prev));
        }
      } catch {
        // network hiccup — retry next tick
      }
    }, 1000);
  }, [stopExtractionPolling, toast]);

  // Auto-extract indicators when a site is opened that has catchments but no indicators yet
  useEffect(() => {
    startBackgroundIndicatorExtraction(currentSite);
  }, [currentSite?.id, currentSite?.catchmentIds, currentSite?.indicators, startBackgroundIndicatorExtraction]);

  // Auto-save site state when user interacts with the map (debounced)
  const siteAutoSaveTimerRef = useRef<number | null>(null);
  const isLoadingSiteRef = useRef(false); // Prevent saving while loading
  const boundaryUpdateRequestSeqRef = useRef(0);

    // Target values popup state (lifted from ContentArea)
  const { isOpen: isTargetModalOpen, onOpen: onOpenTargetModal, onClose: onCloseTargetModal } = useDisclosure();
  const handleToggleTargetModal = () => {
    if (isTargetModalOpen) {
      onCloseTargetModal();
    } else {
      onOpenTargetModal();
    }
  };

  useEffect(() => {
    // Don't save if no site is open, we're loading a site, on create-site page,
    // the open site is a read-only walkthrough demo (never persisted, so
    // this would just 404 against the site store on every debounce tick),
    // or the resume-session prompt hasn't been answered yet.
    if (!sessionDecided || !currentSiteId || isLoadingSiteRef.current || currentPage === 'create-site'
      || currentSite?.source === 'walkthrough') {
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
  }, [sessionDecided, currentSiteId, paneStates, layoutMode, focusedPane, currentPage, currentSite?.source]);

  // Resume-session prompt: user picked "continue where I left off" — proceed
  // with whatever was already restored from localStorage into state.
  const handleResumeSession = useCallback(() => {
    setResumeChoice('resume');
  }, []);

  // Resume-session prompt: user picked "go to home page" — discard the
  // restored page/site and land on the landing page instead.
  const handleStartFresh = useCallback(() => {
    setCurrentPage('landing');
    setCurrentSiteId(null);
    setCurrentSite(null);
    setIsExploreMode(false);
    setResumeChoice('fresh');
  }, []);

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
      // In multi-pane layouts the control panel should not re-open on return.
      if (layoutMode !== 'single') {
        setIndicatorPaneIndex(null);
      }
    } else {
      // Non-map pages
      setCurrentPage(page);
      setIsExploreMode(false);
      if (page !== 'create-site') {
        setEditSite(null);
      }
    }
  }, [layoutMode]);

  // Listen for tour navigation events
  useEffect(() => {
    const handler = (e: Event) => handleNavigate((e as CustomEvent).detail as AppPage);
    window.addEventListener('dt:navigate', handler);
    return () => window.removeEventListener('dt:navigate', handler);
  }, [handleNavigate]);

  // Open a site and go to map view
  const handleOpenSite = useCallback(async (site: Site) => {
    // Prevent auto-save while loading site state
    isLoadingSiteRef.current = true;

    setCurrentSiteId(site.id);
    setCurrentSite(site); // Store full site for title and bounds
    if (site.source === 'walkthrough') primeSiteCatchmentsFromEmbedded(site);
    setIsExploreMode(false); // Exit explore mode when opening a site

    // Load site state - restore pane states including indicator selections
    if (site.paneStates) {
      setPaneStates(site.paneStates);
    }
    if (site.layoutMode) {
      setLayoutMode(site.layoutMode);
    }
    if (site.quadColumns) {
      setQuadColumns(site.quadColumns);
    }
    const paneIdx = typeof site.focusedPane === 'number' ? site.focusedPane : 0;
    setFocusedPane(paneIdx);
    // Only open the control panel in single-pane mode; multi-pane layouts manage their own panel state.
    const effectiveLayout = site.layoutMode || layoutMode;
    setIndicatorPaneIndex(effectiveLayout === 'single' ? paneIdx : null);
    setCurrentPage('map');

    // Re-enable auto-save after a short delay to allow state to settle
    setTimeout(() => {
      isLoadingSiteRef.current = false;
    }, 500);
  }, [layoutMode]);

  // Listen for tour demo site open event
  useEffect(() => {
    const handler = (e: Event) => handleOpenSite((e as CustomEvent).detail as Site);
    window.addEventListener('dt:tour-open-site', handler);
    return () => window.removeEventListener('dt:tour-open-site', handler);
  }, [handleOpenSite]);


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
    startBackgroundIndicatorExtraction(site);
    handleOpenSite(site);
    setViewModes((prev) => prev.map((m, i) => (i === 0 ? 'map' : m)));
  }, [handleOpenSite, startBackgroundIndicatorExtraction]);

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
    setViewModes((prev) => prev.map(() => prev[focusedPane] ?? 'map'));
  }, [focusedPane]);

  // Listen for demo event to reset to single pane map view.
  useEffect(() => {
    const handler = () => {
      setLayoutMode('single');
      setViewModes((prev) => prev.map((_, i) => (i === 0 ? 'map' : prev[i])));
      setSwiperPosition(50);
    };
    window.addEventListener('dt:demo-single-map-view', handler);
    return () => window.removeEventListener('dt:demo-single-map-view', handler);
  }, []);

  // Listen for demo event to switch to a 6-dial, 3-column layout for the
  // Exploring Management Targets tour step.
  useEffect(() => {
    const handler = () => {
      const base = { leftScenario: 'reference' as const, rightScenario: 'current' as const };
      const demoPanes: PaneStates = [
        { ...base, attribute: 'lowTC_prop' },
        { ...base, attribute: 'percBurned' },
        { ...base, attribute: 'CH4_both_kg_km2' },
        { ...base, attribute: 'fracGrazing' },
        { ...base, attribute: 'herbs_tot_kgkm2' },
        { ...base, attribute: 'NPP_gm2' },
      ];
      setLayoutMode('quad');
      setQuadColumns(3);
      setIndicatorPaneIndex(null);
      setPaneStates(demoPanes);
      setViewModes(demoPanes.map(() => 'dial'));
      setRangeMode('site');
    };
    window.addEventListener('dt:demo-go-quad-dial', handler);
    return () => window.removeEventListener('dt:demo-go-quad-dial', handler);
  }, []);

  // Listen for demo event to switch to single-pane chart view with "Mean tree
  // cover %" as the individual factor, grouped by tree biomass class, for the
  // MunywanaDemoTour's "Tree Biomass Distribution" step.
  useEffect(() => {
    const handler = () => {
      setLayoutMode('single');
      setIndicatorPaneIndex(0);
      setViewModes((prev) => {
        const next = [...prev];
        next[0] = 'chart';
        return next;
      });
      setPaneStates((prev) => {
        const next = [...prev] as PaneStates;
        next[0] = { ...next[0], attribute: 'meanTC' };
        return next;
      });
      setChartGroups((prev) => {
        const next = [...prev];
        next[0] = 'Vegetation structure';
        return next;
      });
      setChartAxisLabelFilters((prev) => {
        const next = [...prev];
        next[0] = 'Tree biomass class';
        return next;
      });
      // factorDerivedMode/factorDerivedValue live as local state inside
      // ControlPanel (not lifted here), so sync them via a dedicated event.
      window.dispatchEvent(new CustomEvent('dt:demo-chart-individual-factor', {
        detail: { attribute: 'meanTC' },
      }));
    };
    window.addEventListener('dt:demo-tree-biomass-chart', handler);
    return () => window.removeEventListener('dt:demo-tree-biomass-chart', handler);
  }, []);

  // Listen for demo event to switch to single-pane chart view with Herbivore
  // biomass as the individual factor, grouped by functional group, for the
  // AfricaDemoTour.
  useEffect(() => {
    const handler = () => {
      setLayoutMode('single');
      setIndicatorPaneIndex(0);
      setViewModes((prev) => {
        const next = [...prev];
        next[0] = 'chart';
        return next;
      });
      setPaneStates((prev) => {
        const next = [...prev] as PaneStates;
        next[0] = { ...next[0], attribute: 'herbs_tot_kgkm2' };
        return next;
      });
      setChartGroups((prev) => {
        const next = [...prev];
        next[0] = 'Herbivores';
        return next;
      });
      setChartAxisLabelFilters((prev) => {
        const next = [...prev];
        next[0] = 'Functional group';
        return next;
      });
      // factorDerivedMode/factorDerivedValue live as local state inside
      // ControlPanel (not lifted here), so sync them via a dedicated event.
      window.dispatchEvent(new CustomEvent('dt:demo-chart-individual-factor', {
        detail: { attribute: 'herbs_tot_kgkm2' },
      }));
    };
    window.addEventListener('dt:demo-herbivore-functional-group-chart', handler);
    return () => window.removeEventListener('dt:demo-herbivore-functional-group-chart', handler);
  }, []);

  // Listen for demo event to switch to a 6-dial, 3-column layout covering the
  // ecosystem-scale consequences of the current herbivore regime, for the
  // AfricaDemoTour.
  useEffect(() => {
    const handler = () => {
      const base = { leftScenario: 'reference' as const, rightScenario: 'current' as const };
      const demoPanes: PaneStates = [
        { ...base, attribute: 'herbs_tot_kgkm2' },
        { ...base, attribute: 'herbs_totGRAZING_kgkm2' },
        { ...base, attribute: 'percBurned' },
        { ...base, attribute: 'CH4_both_kg_km2' },
        { ...base, attribute: 'NPP_gm2' },
        { ...base, attribute: 'herbs_fg_kgkm2_Megaherbivores' },
      ];
      setLayoutMode('quad');
      setQuadColumns(3);
      setIndicatorPaneIndex(null);
      setPaneStates(demoPanes);
      setViewModes(demoPanes.map(() => 'dial'));
      setRangeMode('site');
    };
    window.addEventListener('dt:demo-go-quad-dial-africa', handler);
    return () => window.removeEventListener('dt:demo-go-quad-dial-africa', handler);
  }, []);

  // Listen for demo event to swap the NPP dial for change-in-SOC, for the
  // AfricaDemoTour "ecosystem-scale consequences" step.
  useEffect(() => {
    const handler = () => {
      setPaneStates((prev) => {
        if (prev.length <= 4) return prev;
        const next = [...prev] as PaneStates;
        next[4] = { ...next[4], attribute: 'deltaSOC_Mgha' };
        return next;
      });
    };
    window.addEventListener('dt:demo-swap-npp-soc', handler);
    return () => window.removeEventListener('dt:demo-swap-npp-soc', handler);
  }, []);

  const handleAddPane = useCallback(() => {
    setPaneStates((prev) => {
      const source = prev[focusedPane] ?? prev[0] ?? { leftScenario: 'reference', rightScenario: 'current', attribute: '' };
      const nextIndex = prev.length;
      setFocusedPane(nextIndex);
      setIndicatorPaneIndex(null);
      return [...prev, { ...source }];
    });
  }, [focusedPane]);

  const handleRemovePane = useCallback((paneIndex: number) => {
    setPaneStates((prev) => {
      if (prev.length <= minimumQuadPaneCount || paneIndex < minimumQuadPaneCount || paneIndex >= prev.length) {
        return prev;
      }
      return prev.filter((_, idx) => idx !== paneIndex);
    });

    setViewModes((prev) => {
      if (prev.length <= minimumQuadPaneCount || paneIndex < minimumQuadPaneCount || paneIndex >= prev.length) {
        return prev;
      }
      return prev.filter((_, idx) => idx !== paneIndex);
    });

    setChartGroups((prev) => {
      if (prev.length <= minimumQuadPaneCount || paneIndex < minimumQuadPaneCount || paneIndex >= prev.length) {
        return prev;
      }
      return prev.filter((_, idx) => idx !== paneIndex);
    });

    setChartAxisLabelFilters((prev) => {
      if (prev.length <= minimumQuadPaneCount || paneIndex < minimumQuadPaneCount || paneIndex >= prev.length) {
        return prev;
      }
      return prev.filter((_, idx) => idx !== paneIndex);
    });

    setChartGraphModes((prev) => {
      if (prev.length <= minimumQuadPaneCount || paneIndex < minimumQuadPaneCount || paneIndex >= prev.length) {
        return prev;
      }
      return prev.filter((_, idx) => idx !== paneIndex);
    });

    setFocusedPane((prev) => {
      if (prev > paneIndex) return prev - 1;
      if (prev === paneIndex) return Math.max(0, paneIndex - 1);
      return prev;
    });

    setIndicatorPaneIndex((prev) => {
      if (prev === null) return null;
      if (prev > paneIndex) return prev - 1;
      if (prev === paneIndex) return null;
      return prev;
    });
  }, [minimumQuadPaneCount]);

  // Update a specific pane's comparison state
  const handlePaneStateChange = useCallback((paneIndex: number, partial: Partial<ComparisonState>) => {
    setPaneStates((prev) => {
      const next = [...prev] as PaneStates;
      next[paneIndex] = { ...next[paneIndex], ...partial };
      return next;
    });
  }, []);

  // Listen for demo pane state updates (used by MunywanaDemoTour to auto-select indicators).
  // Also switches to single-pane layout so the grid view from a later demo step is cleared.
  useEffect(() => {
    const handler = (e: Event) => {
      const partial = (e as CustomEvent).detail as Partial<ComparisonState>;
      handlePaneStateChange(0, partial);
      setLayoutMode('single');
      setFocusedPane(0);
      setIndicatorPaneIndex(0);
    };
    window.addEventListener('dt:demo-pane-state', handler);
    return () => window.removeEventListener('dt:demo-pane-state', handler);
  }, [handlePaneStateChange]);

  const handleViewModeChange = useCallback((paneIndex: number, mode: ViewMode) => {
    setViewModes((prev) => {
      if (layoutMode === 'quad') {
        return prev.map(() => mode);
      }

      const next = [...prev];
      next[paneIndex] = mode;
      return next;
    });
  }, [layoutMode]);

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

  const handleChartGroupChange = useCallback((group: string | null) => {
    if (indicatorPaneIndex === null) return;
    setChartGroups((prev) => {
      const next = [...prev];
      next[indicatorPaneIndex] = group;
      return next;
    });
    setChartGraphModes((prev) => {
      const next = [...prev];
      next[indicatorPaneIndex] = null;
      return next;
    });
    // Reset grouping-variable filter when changing variable type for this pane.
    setChartAxisLabelFilters((prev) => {
      const next = [...prev];
      next[indicatorPaneIndex] = null;
      return next;
    });
  }, [indicatorPaneIndex]);

  const handleChartAxisLabelFilterChange = useCallback((axisLabel: string | null) => {
    if (indicatorPaneIndex === null) return;
    setChartAxisLabelFilters((prev) => {
      const next = [...prev];
      next[indicatorPaneIndex] = axisLabel;
      return next;
    });
  }, [indicatorPaneIndex]);

  const handleChartGraphModeChange = useCallback((mode: 'line' | 'boxplot' | null) => {
    if (indicatorPaneIndex === null) return;
    setChartGraphModes((prev) => {
      const next = [...prev];
      next[indicatorPaneIndex] = mode;
      return next;
    });
  }, [indicatorPaneIndex]);


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
    if (!isBoundaryEditMode) {
      // Entering edit mode → flatten map and start tracking whether it's edited.
      setIs3DMode(false);
      boundaryEditedDuringSessionRef.current = false;
      return;
    }
    // Exiting edit mode: if the boundary actually changed, re-extract indicators
    // so the catchment count/stats reflect the new shape without the user having
    // to go to the indicators page and click re-extract manually. Delayed so any
    // in-flight boundary save (geometry + catchmentIds) has settled first.
    if (boundaryEditedDuringSessionRef.current) {
      boundaryEditedDuringSessionRef.current = false;
      window.setTimeout(() => {
        startBackgroundIndicatorExtraction(currentSiteRef.current, { force: true });
      }, 1000);
    }
  }, [isBoundaryEditMode, startBackgroundIndicatorExtraction]);

  // Handle geometry update from boundary editing
  const handleBoundaryUpdate = useCallback(async (newGeometry: GeoJSON.Geometry, thumbnail?: string | null) => {
    if (!currentSiteId) return;
    boundaryEditedDuringSessionRef.current = true;

    // Apply immediately so map state stays in sync while requests are in flight.
    setCurrentSite(prev => {
      if (!prev || prev.id !== currentSiteId) return prev;
      return { ...prev, geometry: newGeometry, ...(thumbnail !== undefined && { thumbnail }) };
    });

    const requestSeq = ++boundaryUpdateRequestSeqRef.current;

    try {
      const patch: Partial<Site> = { geometry: newGeometry };
      if (thumbnail !== undefined) patch.thumbnail = thumbnail;
      const updatedSite = await patchSite(currentSiteId, patch);
      if (requestSeq !== boundaryUpdateRequestSeqRef.current) {
        return;
      }
      setCurrentSite(updatedSite);
    } catch (err) {
      console.error('Failed to update site boundary:', err);
    }
  }, [currentSiteId]);

  const handleSiteIndicatorsChange = useCallback(async (indicators: Site['indicators']) => {
    if (!currentSiteId || !indicators) return;

    setCurrentSite((prev) => {
      if (!prev || prev.id !== currentSiteId) return prev;
      return { ...prev, indicators };
    });

    try {
      const updatedSite = await patchSiteIndicators(currentSiteId, indicators, currentSite ?? undefined);
      // The backend has no concept of `source` — it's a frontend-only marker
      // for read-only demo/walkthrough sites — so it never comes back in the
      // response. Carry it forward or a walkthrough site would look like a
      // normal (persistable) one after its first successful edit.
      setCurrentSite((prev) => ({ ...updatedSite, source: prev?.source ?? updatedSite.source }));
      setMapRefreshSeq(s => s + 1);

      const warnings = updatedSite.indicators?.warnings ?? [];
      showTargetWarningsPopup(warnings, toast);
    } catch (err) {
      console.error('Failed to update site indicators:', err);
      throw err;
    }
  }, [currentSiteId, currentSite, toast]);

  const isIndicatorOpen = indicatorPaneIndex !== null;

  // Show setup guide when tiles aren't loaded
  if (info && !info.tiles_loaded) {
    return <SetupGuide info={info} />;
  }

  // Voluntary reinstall, reached via the cog icon in the header
  if (currentPage === 'setup' && info) {
    return <SetupGuide info={info} onBack={() => handleNavigate('landing')} />;
  }

  // New tab, prior session found: ask before silently restoring it.
  if (resumeChoice === null) {
    return (
      <ResumeSessionModal
        savedPage={savedPageForPrompt}
        hasSite={hadSiteForPrompt}
        onResume={handleResumeSession}
        onStartFresh={handleStartFresh}
      />
    );
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
        <FeedbackLink />
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
        <FeedbackLink />
      </Flex>
    );
  }

  if (currentPage === 'partnership') {
    return (
      <Flex direction="column" h="100vh" overflow="hidden">
        <Header
          onToggleDocs={onToggleDocs}
          isDocsOpen={isDocsOpen}
          onNavigate={handleNavigate}
          currentPage={currentPage}
        />
        <Box flex={1} overflow="auto">
          <PartnershipPage onNavigate={handleNavigate} />
        </Box>
        <DocsPanel isOpen={isDocsOpen} onClose={onCloseDocs} />
        <FeedbackLink />
      </Flex>
    );
  }

  if (currentPage === 'download') {
    return (
      <Flex direction="column" h="100vh" overflow="hidden">
        <Header
          onToggleDocs={onToggleDocs}
          isDocsOpen={isDocsOpen}
          onNavigate={handleNavigate}
          currentPage={currentPage}
        />
        <Box flex={1} overflow="auto">
          <DownloadPage onNavigate={handleNavigate} />
        </Box>
        <DocsPanel isOpen={isDocsOpen} onClose={onCloseDocs} />
        <FeedbackLink />
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
        <FeedbackLink />
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
        <FeedbackLink />
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
            autoExtractionInProgress={isExtractingIndicators}
            onSiteUpdated={(updatedSite: Site) => setCurrentSite(updatedSite)}
          />
        </Box>
        <DocsPanel isOpen={isDocsOpen} onClose={onCloseDocs} />
        <FeedbackLink />
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
        onEditBoundary={currentSite && viewModes[focusedPane] === 'map' ? handleToggleBoundaryEdit : undefined}
        isBoundaryEditMode={isBoundaryEditMode}
        onToggleTargetModal={handleToggleTargetModal}
        isTargetModalOpen={isTargetModalOpen}
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
            viewModes={viewModes}
            onViewModeChange={handleViewModeChange}
            focusedPane={focusedPane}
            onFocusPane={handleFocusPane}
            onGoQuad={handleGoQuad}
            onAddPane={handleAddPane}
            onRemovePane={handleRemovePane}
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
            colorScaleMode={colorScaleMode}
            colorScaleType={colorScaleType}
            is3DMode={is3DMode}
            on3DModeChange={setIs3DMode}
            swiperPosition={swiperPosition}
            onSwiperPositionChange={setSwiperPosition}
            siteIndicators={currentSite?.indicators}
            rangeMode={rangeMode}
            onRangeModeChange={setRangeMode}
            mapStatistics={mapStatistics}
            chartGroups={chartGroups}
            chartAxisLabelFilters={chartAxisLabelFilters}
            chartGraphModes={chartGraphModes}
            mapExtent={mapExtent}
            onSiteIndicatorsChange={handleSiteIndicatorsChange}
            isExtractingIndicators={isExtractingIndicators}
            isTargetModalOpen={isTargetModalOpen}
            onOpenTargetModal={onOpenTargetModal}
            onCloseTargetModal={onCloseTargetModal}
            refreshKey={mapRefreshSeq}
            quadColumns={quadColumns}
            onQuadColumnsChange={setQuadColumns}
            fullDomainData={fullDomainData}
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
          viewMode={indicatorPaneIndex !== null ? viewModes[indicatorPaneIndex] : viewModes[0]}
          isExploreMode={isExploreMode}
          onNavigateToCreateSite={handleNavigateToCreateSite}
          mapStatistics={mapStatistics ?? undefined}
          siteIndicators={currentSite?.indicators}
          isSwiperEnabled={isSwiperEnabled}
          isSiteAggregationActive={Boolean(currentSiteId) && (indicatorPaneIndex !== null
            ? viewModes[indicatorPaneIndex] === 'table'
            : viewModes[0] === 'table')}
          hideScenarioSelectors={indicatorPaneIndex !== null
            ? viewModes[indicatorPaneIndex] === 'chart'
            : viewModes[0] === 'chart'}
          hideColorScale={(indicatorPaneIndex !== null
            ? viewModes[indicatorPaneIndex] === 'chart'
            : viewModes[0] === 'chart') || (Boolean(currentSiteId) && (indicatorPaneIndex !== null
              ? viewModes[indicatorPaneIndex] === 'table'
              : viewModes[0] === 'table'))}
          colorScaleMode={colorScaleMode}
          colorScaleType={colorScaleType}
          onColorScaleTypeChange={setColorScaleType}
          rangeMode={rangeMode}
          onRangeModeChange={setRangeMode}
          chartGroup={indicatorPaneIndex !== null ? chartGroups[indicatorPaneIndex] : chartGroups[0]}
          onChartGroupChange={handleChartGroupChange}
          chartAxisLabelFilter={indicatorPaneIndex !== null ? chartAxisLabelFilters[indicatorPaneIndex] : chartAxisLabelFilters[0]}
          onChartAxisLabelFilterChange={handleChartAxisLabelFilterChange}
          chartGraphMode={indicatorPaneIndex !== null ? chartGraphModes[indicatorPaneIndex] : chartGraphModes[0]}
          onChartGraphModeChange={handleChartGraphModeChange}
        />
      </Flex>

      {/* Docs panel - always mounted to preserve iframe navigation state */}
      <DocsPanel isOpen={isDocsOpen} onClose={onCloseDocs} />
      <FeedbackLink />
    </Flex>
  );
}

export default App;
