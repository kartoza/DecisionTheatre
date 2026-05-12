import { useState, useRef } from 'react';
import {
  Box,
  Heading,
  Text,
  VStack,
  Code,
  Flex,
  Badge,
  Divider,
  Button,
  HStack,
  Alert,
  AlertIcon,
  Progress,
  useToast,
} from '@chakra-ui/react';
import type { ServerInfo } from '../types';

interface SetupGuideProps {
  info: ServerInfo;
}

function SetupGuide({ info }: SetupGuideProps) {
  const [selectedPath, setSelectedPath] = useState('');
  const [browsing, setBrowsing] = useState(false);
  const [installing, setInstalling] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pollTimerRef = useRef<number | null>(null);
  const toast = useToast();

  const handleBrowse = async () => {
    setBrowsing(true);
    setError(null);
    try {
      const res = await fetch('/api/dialog/open-file', { method: 'POST' });
      const data = await res.json();
      if (data.path) {
        setSelectedPath(data.path);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not open file dialog');
    } finally {
      setBrowsing(false);
    }
  };

  const handleInstall = async () => {
    if (!selectedPath) return;
    setInstalling(true);
    setError(null);

    try {
      const res = await fetch('/api/datapack/install', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: selectedPath }),
      });
      const data = await res.json();

      if (!res.ok) {
        setError(data.error || 'Installation failed');
        setInstalling(false);
        return;
      }

      // Server returned 202 — extraction is running in the background.
      // Poll the status endpoint until it reports done or error.
      pollStatus();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Network error');
      setInstalling(false);
    }
  };

  const pollStatus = () => {
    const startTime = Date.now();
    const maxWaitMs = 15 * 60 * 1000; // 15 minutes

    const tick = async () => {
      if (Date.now() - startTime > maxWaitMs) {
        setError('Installation timed out. Please restart the application.');
        setInstalling(false);
        return;
      }

      try {
        const res = await fetch('/api/datapack/status');
        const data = await res.json();

        if (data.install_status === 'error') {
          setError(data.install_error || 'Installation failed');
          setInstalling(false);
          return;
        }

        if (data.install_status === 'done' || data.installed) {
          toast({
            title: 'Data pack installed',
            description: 'Reloading application...',
            status: 'success',
            duration: 2000,
          });
          setTimeout(() => window.location.reload(), 1500);
          return;
        }
      } catch (_) {
        // Server may be briefly unavailable while routes are rebuilt — keep polling
      }

      pollTimerRef.current = window.setTimeout(tick, 2000);
    };

    pollTimerRef.current = window.setTimeout(tick, 2000);
  };

  return (
    <Flex
      align="center"
      justify="center"
      minH="100vh"
      bg="gray.900"
      color="white"
      p={8}
    >
      <Box maxW="720px" w="full">
        <VStack spacing={6} align="stretch">
          <Box textAlign="center" mb={4}>
            <Heading size="xl" mb={2}>
              Decision Theatre
            </Heading>
            <Text color="gray.400" fontSize="lg">
              Offline catchment data exploration with embedded AI
            </Text>
            <Badge colorScheme="yellow" mt={3} fontSize="sm" px={3} py={1}>
              Data files required
            </Badge>
          </Box>

          <Divider borderColor="gray.700" />

          {/* Status overview */}
          <Box>
            <Heading size="sm" mb={3} color="gray.300">
              Component Status
            </Heading>
            <VStack spacing={2} align="stretch">
              <StatusRow
                label="Map tiles (MBTiles)"
                ready={info.tiles_loaded}
              />
            </VStack>
          </Box>

          <Divider borderColor="gray.700" />

          {/* Data pack installer */}
          <Box>
            <Heading size="sm" mb={3} color="blue.300">
              Install Data Pack
            </Heading>
            <Text color="gray.300" mb={3}>
              Select a Decision Theatre data pack (.zip or .7z) file and click Install.
            </Text>
            <VStack spacing={3} align="stretch">
              <Button
                onClick={handleBrowse}
                isLoading={browsing}
                loadingText="Opening..."
                isDisabled={installing}
                variant="outline"
                borderColor="gray.600"
                color="gray.300"
                _hover={{ borderColor: 'gray.400', color: 'white' }}
              >
                Browse for data pack...
              </Button>
              {selectedPath && (
                <HStack spacing={2}>
                  <Text
                    fontSize="sm"
                    color="gray.300"
                    flex={1}
                    isTruncated
                    title={selectedPath}
                  >
                    {selectedPath.split(/[\\/]/).pop()}
                  </Text>
                  <Button
                    colorScheme="blue"
                    onClick={handleInstall}
                    isLoading={installing}
                    loadingText="Installing"
                    flexShrink={0}
                  >
                    Install
                  </Button>
                </HStack>
              )}
            </VStack>
            {installing && (
              <Progress size="xs" isIndeterminate mt={2} colorScheme="blue" />
            )}
            {error && (
              <Alert status="error" mt={3} borderRadius="md" bg="red.900">
                <AlertIcon />
                {error}
              </Alert>
            )}
          </Box>

          <Divider borderColor="gray.700" />

          {/* Manual setup instructions */}
          {!info.tiles_loaded && (
            <Box>
              <Heading size="sm" mb={3} color="orange.300">
                Alternative: Manual Setup
              </Heading>
              <Text color="gray.300" mb={3}>
                If you don't have a data pack, you can prepare the data manually.
                Obtain the GeoPackage file and convert it to MBTiles:
              </Text>
              <Code
                display="block"
                p={3}
                bg="gray.800"
                borderRadius="md"
                fontSize="sm"
                whiteSpace="pre"
              >{`# Enter the development shell (provides all tools)
nix develop

# Convert GeoPackage to MBTiles
cd resources/mbtiles
./gpkg_to_mbtiles.sh UoW_layers.gpkg

# Then restart the application
nix run`}</Code>
            </Box>
          )}

          <Box>
            <Heading size="sm" mb={3} color="gray.300">
              Directory structure
            </Heading>
            <Code
              display="block"
              p={3}
              bg="gray.800"
              borderRadius="md"
              fontSize="sm"
              whiteSpace="pre"
              color="gray.400"
            >{`Data Pack (.zip or .7z):
  manifest.json             <- pack metadata
  data/
    mbtiles/
      africa.mbtiles        <- vector tile data (required)
      style.json            <- MapBox style (required)
    datapack.gpkg           <- scenario data (optional)`}</Code>
          </Box>

          <Text color="gray.500" fontSize="xs" textAlign="center" mt={4}>
            Decision Theatre v{info.version}
          </Text>
        </VStack>
      </Box>
    </Flex>
  );
}

function StatusRow({
  label,
  ready,
  optional,
}: {
  label: string;
  ready: boolean;
  optional?: boolean;
}) {
  return (
    <Flex justify="space-between" align="center" px={3} py={2} bg="gray.800" borderRadius="md">
      <Text fontSize="sm">{label}</Text>
      <Badge colorScheme={ready ? 'green' : optional ? 'gray' : 'red'} fontSize="xs">
        {ready ? 'Ready' : optional ? 'Not configured' : 'Missing'}
      </Badge>
    </Flex>
  );
}

export default SetupGuide;
