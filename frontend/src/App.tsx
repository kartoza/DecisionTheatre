import { useState, useCallback, useEffect } from 'react';
import { Box, Flex, useDisclosure } from '@chakra-ui/react';
import ContentArea from './components/ContentArea';
import ControlPanel from './components/ControlPanel';
import Header from './components/Header';
import DocsPanel from './components/DocsPanel';
import SetupGuide from './components/SetupGuide';
import LandingPage from './components/LandingPage';
import AboutPage from './components/AboutPage';
import ProjectsPage from './components/ProjectsPage';
import CreateProjectPage from './components/CreateProjectPage';
import { useServerInfo } from './hooks/useApi';
import type { Scenario, LayoutMode, PaneStates, ComparisonState, AppPage, Project, IdentifyResult } from './types';
import {
  loadPaneStates,
  savePaneStates,
  loadLayoutMode,
  saveLayoutMode,
  loadFocusedPane,
  saveFocusedPane,
  loadCurrentPage,
  saveCurrentPage,
  loadCurrentProject,
  saveCurrentProject,
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
  const [currentProjectId, setCurrentProjectId] = useState<string | null>(loadCurrentProject);
  const [cloneFromProject, setCloneFromProject] = useState<Project | null>(null);
  const [identifyResult, setIdentifyResult] = useState<IdentifyResult>(null);
  const { info } = useServerInfo();

  // Persist state changes
  useEffect(() => { savePaneStates(paneStates); }, [paneStates]);
  useEffect(() => { saveLayoutMode(layoutMode); }, [layoutMode]);
  useEffect(() => { saveFocusedPane(focusedPane); }, [focusedPane]);
  useEffect(() => { saveCurrentPage(currentPage); }, [currentPage]);
  useEffect(() => { saveCurrentProject(currentProjectId); }, [currentProjectId]);

  // Navigate to a page
  const handleNavigate = useCallback((page: AppPage) => {
    setCurrentPage(page);
    if (page !== 'create') {
      setCloneFromProject(null);
    }
  }, []);

  // Open a project and go to map view
  const handleOpenProject = useCallback(async (project: Project) => {
    setCurrentProjectId(project.id);
    // Load project state
    if (project.paneStates) {
      setPaneStates(project.paneStates);
    }
    if (project.layoutMode) {
      setLayoutMode(project.layoutMode);
    }
    if (typeof project.focusedPane === 'number') {
      setFocusedPane(project.focusedPane);
      if (project.layoutMode === 'single') {
        setIndicatorPaneIndex(project.focusedPane);
      }
    }
    setCurrentPage('map');
  }, []);

  // Clone a project
  const handleCloneProject = useCallback((project: Project) => {
    setCloneFromProject(project);
    setCurrentPage('create');
  }, []);

  // Handle project created
  const handleProjectCreated = useCallback((project: Project) => {
    handleOpenProject(project);
  }, [handleOpenProject]);

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

  const isIndicatorOpen = indicatorPaneIndex !== null;

  // Show setup guide when tiles aren't loaded (only on map page)
  if (currentPage === 'map' && info && !info.tiles_loaded) {
    return <SetupGuide info={info} />;
  }

  // Render landing/about/projects/create pages
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

  if (currentPage === 'projects') {
    return (
      <Flex direction="column" h="100vh" overflow="hidden">
        <Header
          onToggleDocs={onToggleDocs}
          isDocsOpen={isDocsOpen}
          onNavigate={handleNavigate}
          currentPage={currentPage}
        />
        <Box flex={1} overflow="auto">
          <ProjectsPage
            onNavigate={handleNavigate}
            onOpenProject={handleOpenProject}
            onCloneProject={handleCloneProject}
          />
        </Box>
        <DocsPanel isOpen={isDocsOpen} onClose={onCloseDocs} />
      </Flex>
    );
  }

  if (currentPage === 'create') {
    return (
      <Flex direction="column" h="100vh" overflow="hidden">
        <Header
          onToggleDocs={onToggleDocs}
          isDocsOpen={isDocsOpen}
          onNavigate={handleNavigate}
          currentPage={currentPage}
        />
        <Box flex={1} overflow="auto">
          <CreateProjectPage
            onNavigate={handleNavigate}
            onProjectCreated={handleProjectCreated}
            cloneFrom={cloneFromProject}
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
        />
      </Flex>

      {/* Docs panel - always mounted to preserve iframe navigation state */}
      <DocsPanel isOpen={isDocsOpen} onClose={onCloseDocs} />
    </Flex>
  );
}

export default App;
