import {
  Box,
  Button,
  HStack,
  Text,
  VStack,
  useToast,
} from '@chakra-ui/react';
import { motion, AnimatePresence } from 'framer-motion';
import maplibregl from 'maplibre-gl';
import { useCallback, useEffect, useRef, useState } from 'react';
import { FiCheck, FiRotateCcw, FiTrash2 } from 'react-icons/fi';
import type { SiteCreationMethod, BoundingBox } from '../types';
import { SITE_COLORS } from '../hooks/usePhysicsPolygon';

const MotionBox = motion(Box);

interface SiteCreationMapProps {
  mode: SiteCreationMethod;
  initialGeometry?: GeoJSON.Geometry | null;
  initialExtent?: { center: [number, number]; zoom: number };
  boundingBox?: BoundingBox | null;
  onGeometryComplete: (geometry: GeoJSON.Geometry, catchmentIds?: string[]) => void;
  onCancel: () => void;
}

// Bright, chunky line styles for site boundaries
const SITE_LINE_PAINT = {
  'line-color': SITE_COLORS.primary,
  'line-width': 6,
  'line-opacity': 1,
};

const SITE_LINE_GLOW_PAINT = {
  'line-color': SITE_COLORS.primary,
  'line-width': 12,
  'line-opacity': 0.3,
  'line-blur': 4,
};

const SITE_FILL_PAINT = {
  'fill-color': SITE_COLORS.primary,
  'fill-opacity': 0.15,
};

const SELECTED_CATCHMENT_PAINT = {
  'fill-color': SITE_COLORS.glow,
  'fill-opacity': 0.4,
};

const SELECTED_CATCHMENT_LINE_PAINT = {
  'line-color': SITE_COLORS.glow,
  'line-width': 3,
  'line-opacity': 0.8,
};

function SiteCreationMap({
  mode,
  initialGeometry,
  initialExtent,
  boundingBox,
  onGeometryComplete,
}: SiteCreationMapProps) {
  const mapContainerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const [isMapReady, setIsMapReady] = useState(false);
  const [drawnPoints, setDrawnPoints] = useState<[number, number][]>([]);
  const [selectedCatchments, setSelectedCatchments] = useState<Map<string, GeoJSON.Feature>>(new Map());
  const [isAnimating, setIsAnimating] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);
  const toast = useToast();

  // Initialize map
  useEffect(() => {
    if (!mapContainerRef.current || mapRef.current) return;

    const map = new maplibregl.Map({
      container: mapContainerRef.current,
      style: '/data/style.json',
      center: initialExtent?.center || [22.977, 1.258],
      zoom: initialExtent?.zoom || 4,
      attributionControl: false,
    });

    map.addControl(new maplibregl.NavigationControl(), 'top-right');

    map.on('load', () => {
      mapRef.current = map;
      setIsMapReady(true);

      // Add a transparent fill layer for catchment selection (clickable area)
      // This must be added after the base style loads
      if (!map.getLayer('catchments-selectable-fill')) {
        map.addLayer({
          id: 'catchments-selectable-fill',
          type: 'fill',
          source: 'UoW Tiles',
          'source-layer': 'catchments_lev12',
          paint: {
            'fill-color': 'transparent',
            'fill-opacity': 0,
          },
        }, 'Catchments Outlines'); // Insert below the outlines
      }

      // If we have initial geometry, display it
      if (initialGeometry && boundingBox) {
        addGeometryToMap(map, initialGeometry);
        // Fit to bounds with animation
        map.fitBounds(
          [
            [boundingBox.minX, boundingBox.minY],
            [boundingBox.maxX, boundingBox.maxY],
          ],
          { padding: 60, duration: 1000 }
        );
        setShowConfirm(true);
      }
    });

    return () => {
      map.remove();
      mapRef.current = null;
    };
  }, [initialGeometry, boundingBox, initialExtent]);

  // Set up interaction handlers based on mode
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !isMapReady) return;

    if (mode === 'drawn') {
      // Drawing mode cursor
      map.getCanvas().style.cursor = 'crosshair';

      const handleClick = (e: maplibregl.MapMouseEvent) => {
        const point: [number, number] = [e.lngLat.lng, e.lngLat.lat];
        setDrawnPoints(prev => {
          const newPoints = [...prev, point];
          updateDrawingPreview(map, newPoints);
          return newPoints;
        });
      };

      map.on('click', handleClick);
      return () => {
        map.off('click', handleClick);
        map.getCanvas().style.cursor = '';
      };
    }

    if (mode === 'catchments') {
      // Catchment selection mode
      map.getCanvas().style.cursor = 'pointer';

      const handleClick = async (e: maplibregl.MapMouseEvent) => {
        // Query features at click point from the transparent fill layer
        const features = map.queryRenderedFeatures(e.point, {
          layers: ['catchments-selectable-fill'],
        });

        if (features.length > 0) {
          const feature = features[0];
          const catchmentId = String(feature.properties?.HYBAS_ID || feature.id);

          setSelectedCatchments(prev => {
            const next = new Map(prev);
            if (next.has(catchmentId)) {
              next.delete(catchmentId);
            } else {
              next.set(catchmentId, feature as unknown as GeoJSON.Feature);
            }
            updateSelectedCatchmentsLayer(map, next);
            return next;
          });
        }
      };

      map.on('click', handleClick);
      return () => {
        map.off('click', handleClick);
        map.getCanvas().style.cursor = '';
      };
    }
  }, [mode, isMapReady]);

  // Update drawing preview
  const updateDrawingPreview = useCallback((map: maplibregl.Map, points: [number, number][]) => {
    const sourceId = 'drawing-preview';

    // Create or update source
    let source = map.getSource(sourceId) as maplibregl.GeoJSONSource;
    if (!source) {
      map.addSource(sourceId, {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] },
      });

      // Add glow layer
      map.addLayer({
        id: 'drawing-glow',
        type: 'line',
        source: sourceId,
        filter: ['==', '$type', 'LineString'],
        paint: {
          'line-color': SITE_COLORS.accent,
          'line-width': 10,
          'line-opacity': 0.3,
          'line-blur': 3,
        },
      });

      // Add line layer
      map.addLayer({
        id: 'drawing-line',
        type: 'line',
        source: sourceId,
        filter: ['==', '$type', 'LineString'],
        paint: {
          'line-color': SITE_COLORS.accent,
          'line-width': 4,
          'line-dasharray': [2, 2],
        },
      });

      // Add points layer
      map.addLayer({
        id: 'drawing-points',
        type: 'circle',
        source: sourceId,
        filter: ['==', '$type', 'Point'],
        paint: {
          'circle-radius': 8,
          'circle-color': SITE_COLORS.accent,
          'circle-stroke-width': 3,
          'circle-stroke-color': '#fff',
        },
      });

      source = map.getSource(sourceId) as maplibregl.GeoJSONSource;
    }

    // Build features
    const features: GeoJSON.Feature[] = [];

    // Add points
    for (const point of points) {
      features.push({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: point },
        properties: {},
      });
    }

    // Add line if we have multiple points
    if (points.length >= 2) {
      features.push({
        type: 'Feature',
        geometry: {
          type: 'LineString',
          coordinates: points,
        },
        properties: {},
      });
    }

    source.setData({ type: 'FeatureCollection', features });

    // Show confirm button if we have at least 3 points
    setShowConfirm(points.length >= 3);
  }, []);

  // Update selected catchments layer
  const updateSelectedCatchmentsLayer = useCallback((map: maplibregl.Map, selected: Map<string, GeoJSON.Feature>) => {
    const sourceId = 'selected-catchments';

    // Create or update source
    let source = map.getSource(sourceId) as maplibregl.GeoJSONSource;
    if (!source) {
      map.addSource(sourceId, {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] },
      });

      // Add fill layer
      map.addLayer({
        id: 'selected-fill',
        type: 'fill',
        source: sourceId,
        paint: SELECTED_CATCHMENT_PAINT,
      });

      // Add line layer
      map.addLayer({
        id: 'selected-line',
        type: 'line',
        source: sourceId,
        paint: SELECTED_CATCHMENT_LINE_PAINT,
      });

      source = map.getSource(sourceId) as maplibregl.GeoJSONSource;
    }

    source.setData({
      type: 'FeatureCollection',
      features: Array.from(selected.values()),
    });

    setShowConfirm(selected.size > 0);
  }, []);

  // Add geometry to map with physics animation
  const addGeometryToMap = useCallback((map: maplibregl.Map, geometry: GeoJSON.Geometry) => {
    const sourceId = 'site-geometry';

    // Remove existing layers/source
    if (map.getLayer('site-glow')) map.removeLayer('site-glow');
    if (map.getLayer('site-fill')) map.removeLayer('site-fill');
    if (map.getLayer('site-line')) map.removeLayer('site-line');
    if (map.getSource(sourceId)) map.removeSource(sourceId);

    // Add source
    map.addSource(sourceId, {
      type: 'geojson',
      data: {
        type: 'Feature',
        geometry,
        properties: {},
      },
    });

    // Add glow layer (rendered first, behind)
    map.addLayer({
      id: 'site-glow',
      type: 'line',
      source: sourceId,
      paint: SITE_LINE_GLOW_PAINT,
    });

    // Add fill layer
    map.addLayer({
      id: 'site-fill',
      type: 'fill',
      source: sourceId,
      paint: SITE_FILL_PAINT,
    });

    // Add line layer (on top)
    map.addLayer({
      id: 'site-line',
      type: 'line',
      source: sourceId,
      paint: SITE_LINE_PAINT,
    });
  }, []);

  // Complete the drawing
  const handleCompleteDrawing = useCallback(() => {
    if (drawnPoints.length < 3) return;

    // Close the polygon
    const polygon: GeoJSON.Polygon = {
      type: 'Polygon',
      coordinates: [[...drawnPoints, drawnPoints[0]]],
    };

    // Animate the transition
    setIsAnimating(true);
    const map = mapRef.current;
    if (map) {
      // Remove drawing preview
      if (map.getLayer('drawing-glow')) map.removeLayer('drawing-glow');
      if (map.getLayer('drawing-line')) map.removeLayer('drawing-line');
      if (map.getLayer('drawing-points')) map.removeLayer('drawing-points');
      if (map.getSource('drawing-preview')) map.removeSource('drawing-preview');

      // Add final geometry with animation
      addGeometryToMap(map, polygon);
    }

    setTimeout(() => {
      setIsAnimating(false);
      onGeometryComplete(polygon);
    }, 800);
  }, [drawnPoints, addGeometryToMap, onGeometryComplete]);

  // Complete catchment selection
  const handleCompleteCatchments = useCallback(async () => {
    if (selectedCatchments.size === 0) return;

    setIsAnimating(true);

    const catchmentIds = Array.from(selectedCatchments.keys());

    try {
      // Call API to dissolve catchments
      const response = await fetch('/api/sites/dissolve-catchments', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ catchmentIds }),
      });

      if (!response.ok) {
        throw new Error('Failed to dissolve catchments');
      }

      const result = await response.json();

      // Display the dissolved geometry
      const map = mapRef.current;
      if (map && result.geometry) {
        // Remove selected catchments layer
        if (map.getLayer('selected-fill')) map.removeLayer('selected-fill');
        if (map.getLayer('selected-line')) map.removeLayer('selected-line');
        if (map.getSource('selected-catchments')) map.removeSource('selected-catchments');

        addGeometryToMap(map, result.geometry);

        // Fit to new bounds
        if (result.boundingBox) {
          map.fitBounds(
            [
              [result.boundingBox.minX, result.boundingBox.minY],
              [result.boundingBox.maxX, result.boundingBox.maxY],
            ],
            { padding: 60, duration: 800 }
          );
        }
      }

      setTimeout(() => {
        setIsAnimating(false);
        onGeometryComplete(result.geometry, catchmentIds);
      }, 1000);
    } catch (error) {
      console.error('Dissolve error:', error);
      toast({
        title: 'Failed to create boundary',
        description: error instanceof Error ? error.message : 'Unknown error',
        status: 'error',
        duration: 5000,
      });
      setIsAnimating(false);
    }
  }, [selectedCatchments, addGeometryToMap, onGeometryComplete, toast]);

  // Confirm for uploaded geometry
  const handleConfirmGeometry = useCallback(() => {
    if (initialGeometry) {
      onGeometryComplete(initialGeometry);
    }
  }, [initialGeometry, onGeometryComplete]);

  // Reset drawing
  const handleReset = useCallback(() => {
    setDrawnPoints([]);
    setSelectedCatchments(new Map());
    setShowConfirm(false);

    const map = mapRef.current;
    if (!map) return;

    // Remove all layers
    const layersToRemove = [
      'drawing-glow', 'drawing-line', 'drawing-points',
      'selected-fill', 'selected-line',
      'site-glow', 'site-fill', 'site-line',
    ];
    const sourcesToRemove = ['drawing-preview', 'selected-catchments', 'site-geometry'];

    for (const layer of layersToRemove) {
      if (map.getLayer(layer)) map.removeLayer(layer);
    }
    for (const source of sourcesToRemove) {
      if (map.getSource(source)) map.removeSource(source);
    }
  }, []);

  // Undo last point in drawing mode
  const handleUndo = useCallback(() => {
    if (drawnPoints.length === 0) return;

    setDrawnPoints(prev => {
      const newPoints = prev.slice(0, -1);
      const map = mapRef.current;
      if (map) {
        updateDrawingPreview(map, newPoints);
      }
      return newPoints;
    });
  }, [drawnPoints.length, updateDrawingPreview]);

  const getInstructions = () => {
    switch (mode) {
      case 'drawn':
        return drawnPoints.length === 0
          ? 'Click on the map to start drawing your site boundary'
          : drawnPoints.length < 3
          ? `Click to add more points (${3 - drawnPoints.length} more needed)`
          : 'Click to add more points, or confirm when ready';
      case 'catchments':
        return selectedCatchments.size === 0
          ? 'Click on catchments to select them for your site'
          : `${selectedCatchments.size} catchment${selectedCatchments.size > 1 ? 's' : ''} selected`;
      default:
        return 'Review your site boundary';
    }
  };

  return (
    <Box
      position="relative"
      w="100%"
      h="100%"
      borderRadius="2xl"
      overflow="hidden"
      border="2px solid"
      borderColor="whiteAlpha.200"
    >
      {/* Map container */}
      <Box ref={mapContainerRef} w="100%" h="100%" />

      {/* Instructions overlay */}
      <AnimatePresence>
        {isMapReady && (
          <MotionBox
            initial={{ opacity: 0, y: -20 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -20 }}
            position="absolute"
            top={4}
            left="50%"
            transform="translateX(-50%)"
            bg="blackAlpha.800"
            backdropFilter="blur(10px)"
            px={6}
            py={3}
            borderRadius="full"
            border="1px solid"
            borderColor="whiteAlpha.200"
          >
            <Text color="white" fontWeight="medium" textAlign="center">
              {getInstructions()}
            </Text>
          </MotionBox>
        )}
      </AnimatePresence>

      {/* Drawing controls */}
      <AnimatePresence>
        {mode === 'drawn' && drawnPoints.length > 0 && (
          <MotionBox
            initial={{ opacity: 0, x: -20 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: -20 }}
            position="absolute"
            bottom={6}
            left={6}
          >
            <HStack spacing={3}>
              <Button
                leftIcon={<FiRotateCcw />}
                onClick={handleUndo}
                bg="blackAlpha.700"
                color="white"
                _hover={{ bg: 'blackAlpha.600' }}
                backdropFilter="blur(10px)"
              >
                Undo
              </Button>
              <Button
                leftIcon={<FiTrash2 />}
                onClick={handleReset}
                colorScheme="red"
                variant="ghost"
              >
                Clear
              </Button>
            </HStack>
          </MotionBox>
        )}
      </AnimatePresence>

      {/* Catchment controls */}
      <AnimatePresence>
        {mode === 'catchments' && selectedCatchments.size > 0 && (
          <MotionBox
            initial={{ opacity: 0, x: -20 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: -20 }}
            position="absolute"
            bottom={6}
            left={6}
          >
            <Button
              leftIcon={<FiTrash2 />}
              onClick={handleReset}
              bg="blackAlpha.700"
              color="white"
              _hover={{ bg: 'blackAlpha.600' }}
              backdropFilter="blur(10px)"
            >
              Clear Selection
            </Button>
          </MotionBox>
        )}
      </AnimatePresence>

      {/* Confirm button */}
      <AnimatePresence>
        {showConfirm && !isAnimating && (
          <MotionBox
            initial={{ opacity: 0, y: 20, scale: 0.9 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 20, scale: 0.9 }}
            transition={{
              type: 'spring',
              stiffness: 400,
              damping: 25,
            }}
            position="absolute"
            bottom={6}
            right={6}
          >
            <Button
              size="lg"
              leftIcon={<FiCheck />}
              bgGradient={`linear(to-r, ${SITE_COLORS.primary}, ${SITE_COLORS.glow})`}
              color="black"
              fontWeight="bold"
              px={8}
              onClick={
                mode === 'drawn' ? handleCompleteDrawing :
                mode === 'catchments' ? handleCompleteCatchments :
                handleConfirmGeometry
              }
              _hover={{
                transform: 'scale(1.05)',
                boxShadow: `0 0 30px ${SITE_COLORS.primary}66`,
              }}
              transition="all 0.2s"
            >
              {mode === 'catchments' ? 'Create Boundary' : 'Confirm Boundary'}
            </Button>
          </MotionBox>
        )}
      </AnimatePresence>

      {/* Animation overlay */}
      <AnimatePresence>
        {isAnimating && (
          <MotionBox
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            position="absolute"
            top={0}
            left={0}
            right={0}
            bottom={0}
            bg="blackAlpha.400"
            display="flex"
            alignItems="center"
            justifyContent="center"
            pointerEvents="none"
          >
            <VStack spacing={4}>
              <MotionBox
                animate={{
                  scale: [1, 1.3, 1],
                  opacity: [0.5, 1, 0.5],
                }}
                transition={{
                  duration: 1,
                  repeat: Infinity,
                  ease: 'easeInOut',
                }}
              >
                <Box
                  w={20}
                  h={20}
                  borderRadius="full"
                  border="4px solid"
                  borderColor={SITE_COLORS.primary}
                  boxShadow={`0 0 40px ${SITE_COLORS.primary}`}
                />
              </MotionBox>
              <Text color="white" fontWeight="bold" fontSize="lg">
                Creating your site boundary...
              </Text>
            </VStack>
          </MotionBox>
        )}
      </AnimatePresence>
    </Box>
  );
}

export default SiteCreationMap;
