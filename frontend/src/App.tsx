import { useState, useCallback } from 'react';
import { Box, Flex, useDisclosure } from '@chakra-ui/react';
import MapView from './components/MapView';
import ControlPanel from './components/ControlPanel';
import Header from './components/Header';
import type { Scenario, ComparisonState } from './types';

function App() {
  const { isOpen, onToggle } = useDisclosure({ defaultIsOpen: false });

  const [comparison, setComparison] = useState<ComparisonState>({
    leftScenario: 'past',
    rightScenario: 'present',
    attribute: '',
  });

  const handleLeftChange = useCallback((scenario: Scenario) => {
    setComparison((prev) => ({ ...prev, leftScenario: scenario }));
  }, []);

  const handleRightChange = useCallback((scenario: Scenario) => {
    setComparison((prev) => ({ ...prev, rightScenario: scenario }));
  }, []);

  const handleAttributeChange = useCallback((attribute: string) => {
    setComparison((prev) => ({ ...prev, attribute }));
  }, []);

  return (
    <Flex direction="column" h="100vh" overflow="hidden">
      <Header onTogglePanel={onToggle} isPanelOpen={isOpen} />

      <Flex flex={1} overflow="hidden" position="relative">
        {/* Map area - shrinks when panel opens */}
        <Box
          flex={1}
          transition="margin-right 0.3s cubic-bezier(0.4, 0, 0.2, 1)"
          mr={isOpen ? { base: 0, md: '400px', lg: '440px' } : 0}
          position="relative"
        >
          <MapView comparison={comparison} />
        </Box>

        {/* Slide-out control panel */}
        <ControlPanel
          isOpen={isOpen}
          comparison={comparison}
          onLeftChange={handleLeftChange}
          onRightChange={handleRightChange}
          onAttributeChange={handleAttributeChange}
        />
      </Flex>
    </Flex>
  );
}

export default App;
