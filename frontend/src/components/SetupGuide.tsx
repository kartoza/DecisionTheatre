import {
  Box,
  Heading,
  Text,
  VStack,
  Code,
  Flex,
  Badge,
  Divider,
} from '@chakra-ui/react';
import type { ServerInfo } from '../types';

interface SetupGuideProps {
  info: ServerInfo;
}

function SetupGuide({ info }: SetupGuideProps) {
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
              <StatusRow label="Embedded LLM" ready={info.llm_available} optional />
              <StatusRow label="Neural network" ready={info.nn_available} optional />
            </VStack>
          </Box>

          <Divider borderColor="gray.700" />

          {/* Setup instructions */}
          {!info.tiles_loaded && (
            <Box>
              <Heading size="sm" mb={3} color="orange.300">
                Step 1: Obtain the GeoPackage
              </Heading>
              <Text color="gray.300" mb={3}>
                The map data originates from a GeoPackage file containing African
                catchment boundaries, country outlines, rivers, lakes, ecoregions,
                and populated places. Contact the project maintainers to obtain{' '}
                <Code colorScheme="orange">UoW_layers.gpkg</Code>.
              </Text>
              <Text color="gray.300" mb={2}>
                Place it in the resources directory:
              </Text>
              <Code
                display="block"
                p={3}
                bg="gray.800"
                borderRadius="md"
                fontSize="sm"
                whiteSpace="pre"
              >{`resources/mbtiles/UoW_layers.gpkg`}</Code>
            </Box>
          )}

          {!info.tiles_loaded && (
            <Box>
              <Heading size="sm" mb={3} color="orange.300">
                Step 2: Convert to MBTiles
              </Heading>
              <Text color="gray.300" mb={3}>
                Use the included conversion script to convert the GeoPackage into
                vector MBTiles. This requires{' '}
                <Code colorScheme="blue">gdal</Code>,{' '}
                <Code colorScheme="blue">tippecanoe</Code>, and{' '}
                <Code colorScheme="blue">sqlite3</Code> (all available in the nix
                devShell):
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

# Run the conversion (takes ~10-30 minutes)
cd resources/mbtiles
./gpkg_to_mbtiles.sh UoW_layers.gpkg catchments.mbtiles`}</Code>
              <Text color="gray.400" fontSize="sm" mt={2}>
                This will produce a ~8 GB MBTiles file with all vector layers
                merged at appropriate zoom levels.
              </Text>
            </Box>
          )}

          {!info.tiles_loaded && (
            <Box>
              <Heading size="sm" mb={3} color="orange.300">
                Step 3: Run the application
              </Heading>
              <Text color="gray.300" mb={3}>
                Once the MBTiles file is in place, restart the application:
              </Text>
              <Code
                display="block"
                p={3}
                bg="gray.800"
                borderRadius="md"
                fontSize="sm"
                whiteSpace="pre"
              >{`# From the project root directory:
nix run

# Or in headless mode (open http://localhost:8080):
nix run . -- --headless`}</Code>
            </Box>
          )}

          {info.tiles_loaded && !info.geo_loaded && (
            <Box>
              <Heading size="sm" mb={3} color="blue.300">
                Optional: Add scenario data
              </Heading>
              <Text color="gray.300" mb={3}>
                To enable scenario comparison, place GeoParquet files in the data
                directory:
              </Text>
              <Code
                display="block"
                p={3}
                bg="gray.800"
                borderRadius="md"
                fontSize="sm"
                whiteSpace="pre"
              >{`data/
  past.geoparquet
  present.geoparquet
  future.geoparquet`}</Code>
            </Box>
          )}

          <Divider borderColor="gray.700" />

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
            >{`DecisionTheatre/
  resources/
    mbtiles/
      catchments.mbtiles    <- vector tile data (required)
      uow_tiles.json        <- MapBox style (included)
      gpkg_to_mbtiles.sh    <- conversion script (included)
      UoW_layers.gpkg       <- source GeoPackage (obtain separately)
  data/
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
