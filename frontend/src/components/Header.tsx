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
import { FiSettings, FiLayers, FiCpu, FiZap } from 'react-icons/fi';
import { useServerInfo } from '../hooks/useApi';

interface HeaderProps {
  onTogglePanel: () => void;
  isPanelOpen: boolean;
}

function Header({ onTogglePanel, isPanelOpen }: HeaderProps) {
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
        >
          Decision Theatre
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
        {/* Status indicators */}
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

          <Tooltip label={info?.llm_available ? 'LLM ready' : 'LLM not loaded'}>
            <Badge
              colorScheme={info?.llm_available ? 'green' : 'gray'}
              variant="subtle"
              display="flex"
              alignItems="center"
              gap={1}
              px={2}
            >
              <FiCpu size={12} />
              <Text fontSize="xs">LLM</Text>
            </Badge>
          </Tooltip>

          <Tooltip label={info?.nn_available ? 'Neural net ready' : 'Neural net not loaded'}>
            <Badge
              colorScheme={info?.nn_available ? 'green' : 'gray'}
              variant="subtle"
              display="flex"
              alignItems="center"
              gap={1}
              px={2}
            >
              <FiZap size={12} />
              <Text fontSize="xs">NN</Text>
            </Badge>
          </Tooltip>
        </HStack>

        <IconButton
          aria-label="Toggle control panel"
          icon={<FiSettings />}
          onClick={onTogglePanel}
          variant={isPanelOpen ? 'solid' : 'ghost'}
          colorScheme="brand"
          size="sm"
        />
      </HStack>
    </Flex>
  );
}

export default Header;
