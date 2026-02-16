import { useState } from 'react';
import {
  Box,
  Heading,
  Text,
  VStack,
  Code,
  Flex,
  Badge,
  Divider,
  Input,
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
  const [zipPath, setZipPath] = useState('');
  const [installing, setInstalling] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const toast = useToast();

  const handleInstall = async () => {
    if (!zipPath.trim()) return;
    setInstalling(true);
    setError(null);

    try {
      const res = await fetch('/api/datapack/install', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: zipPath.trim() }),
      });
      const data = await res.json();

      if (!res.ok) {
        setError(data.error || 'Installation failed');
        return;
      }

      toast({
        title: 'Data pack installed',
        description: 'Reloading application...',
        status: 'success',
        duration: 2000,
      });

      // Reload after a short delay so the user sees the success message
      setTimeout(() => window.location.reload(), 1500);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Network error');
    } finally {
      setInstalling(false);
    }
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
              <StatusRow
                label="Scenario data (GeoParquet)"
                ready={info.geo_loaded}
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
              Provide the path to a Decision Theatre data pack (.zip) file.
              The application will extract and register it automatically.
            </Text>
            <HStack spacing={2}>
              <Input
                placeholder="/path/to/decision-theatre-data-v1.0.0.zip"
                value={zipPath}
                onChange={(e) => setZipPath(e.target.value)}
                bg="gray.800"
                borderColor="gray.600"
                isDisabled={installing}
                onKeyDown={(e) => e.key === 'Enter' && handleInstall()}
              />
              <Button
                colorScheme="blue"
                onClick={handleInstall}
                isLoading={installing}
                loadingText="Installing"
                isDisabled={!zipPath.trim() || installing}
                flexShrink={0}
              >
                Install
              </Button>
            </HStack>
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
cd data/mbtiles
./gpkg_to_mbtiles.sh UoW_layers.gpkg catchments.mbtiles

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
            >{`Data Pack (.zip):
  manifest.json             <- pack metadata
  data/
    mbtiles/
      catchments.mbtiles    <- vector tile data (required)
      style.json            <- MapBox style (required)
    *.geoparquet            <- scenario data (optional)`}</Code>
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
