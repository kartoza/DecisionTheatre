import {
  Box,
  Button,
  HStack,
  IconButton,
  Input,
  InputGroup,
  InputLeftElement,
  InputRightElement,
  List,
  ListItem,
  Spinner,
  Text,
  Tooltip,
  VStack,
  useToast,
} from '@chakra-ui/react';
import { motion, AnimatePresence } from 'framer-motion';
import maplibregl from 'maplibre-gl';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { FiCheck, FiGlobe, FiMapPin, FiRotateCcw, FiSearch, FiSquare, FiTrash2 } from 'react-icons/fi';
import type { SiteCreationMethod, BoundingBox } from '../types';
import { SITE_COLORS } from '../hooks/usePhysicsPolygon';
import { colors } from '../styles/colors';
import { applyZoomOutClipToBounds, fetchCatchmentBounds, fetchTileBounds } from '../lib/mapBounds';
import { getAppRuntime } from '../types/runtime';
import places from '../data/places.json';
import { satelliteAttribution, satelliteTileUrl } from '../lib/satelliteBasemap';

const MAX_SEARCH_RESULTS = 8;
const SEARCH_FLY_ZOOM = 10;
const SEARCH_MIN_CHARS = 3;
const SEARCH_DEBOUNCE_MS = 400;
// Place search goes through our own backend rather than straight to Nominatim.
// The OSM usage policy requires an identifying User-Agent and a real rate limit,
// and neither is possible here: User-Agent is a forbidden header name for fetch,
// and a per-tab debounce is not a rate limit when a user has several tabs open.
// See internal/server/geocode.go.
const PLACE_SEARCH_URL = '/api/geocode';

interface PlaceResult {
  name: string;
  lng: number;
  lat: number;
}

// Online search covers small towns that the bundled gazetteer (major cities
// only) misses. It's an enhancement — a failed, rate-limited or offline request
// just leaves the instant local matches in place, so search still works offline.
//
// The backend already returns the normalised shape and has done the parsing, so
// the client no longer knows or cares which geocoder answered.
async function fetchOnlinePlaces(query: string, signal: AbortSignal): Promise<PlaceResult[]> {
  const url = `${PLACE_SEARCH_URL}?q=${encodeURIComponent(query)}`;
  const response = await fetch(url, { signal, headers: { Accept: 'application/json' } });
  if (!response.ok) return [];

  const results = await response.json() as PlaceResult[];
  return results.filter((place) => Number.isFinite(place.lng) && Number.isFinite(place.lat));
}

const MotionBox = motion(Box);

interface SiteCreationMapProps {
  mode: SiteCreationMethod;
  initialGeometry?: GeoJSON.Geometry | null;
  initialExtent?: { center: [number, number]; zoom: number };
  boundingBox?: BoundingBox | null;
  onGeometryComplete: (geometry: GeoJSON.Geometry, catchmentIds?: string[], thumbnail?: string) => void;
  onCancel: () => void;
}

const GOOGLE_SATELLITE_SOURCE_ID = 'google-satellite';
const GOOGLE_SATELLITE_LAYER_ID = 'google-satellite-tiles';


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

// The site boundary must always render above catchment/basemap layers, no
// matter what gets added to the map afterwards (e.g. toggling satellite view).
function moveSiteGeometryToTop(map: maplibregl.Map) {
  for (const layerId of ['site-glow', 'site-fill', 'site-line']) {
    if (map.getLayer(layerId)) map.moveLayer(layerId);
  }
}

function SiteCreationMap({
  mode,
  initialGeometry,
  initialExtent,
  boundingBox,
  onGeometryComplete,
}: SiteCreationMapProps) {
  const mapContainerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const viewportBoundsRef = useRef<maplibregl.LngLatBoundsLike | null>(null);
  const [isMapReady, setIsMapReady] = useState(false);
  const [isGoogleBasemap, setIsGoogleBasemap] = useState(false);
  const isGoogleBasemapRef = useRef(false);
  const hiddenLayersRef = useRef<string[]>([]);
  const [drawnPoints, setDrawnPoints] = useState<[number, number][]>([]);
  const [selectedCatchments, setSelectedCatchments] = useState<Map<string, GeoJSON.Feature>>(new Map());
  const [isAnimating, setIsAnimating] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);
  const [isBoxSelectionMode, setIsBoxSelectionMode] = useState(false);
  const [selectionBox, setSelectionBox] = useState<{ left: number; top: number; width: number; height: number } | null>(null);
  const boxStartPointRef = useRef<{ x: number; y: number } | null>(null);
  const isDraggingBoxRef = useRef(false);
  const catchmentGeometryCacheRef = useRef<Map<string, GeoJSON.Feature>>(new Map());
  const [locationQuery, setLocationQuery] = useState('');
  const [isLocationDropdownOpen, setIsLocationDropdownOpen] = useState(false);
  const [onlineLocationResults, setOnlineLocationResults] = useState<PlaceResult[]>([]);
  const [isSearchingOnline, setIsSearchingOnline] = useState(false);
  const searchAbortRef = useRef<AbortController | null>(null);
  const toast = useToast();

  const localLocationResults = useMemo<PlaceResult[]>(() => {
    const query = locationQuery.trim().toLowerCase();
    if (!query) return [];
    return (places as PlaceResult[])
      .filter((place) => place.name.toLowerCase().includes(query))
      .slice(0, MAX_SEARCH_RESULTS);
  }, [locationQuery]);

  // Debounced online search — the backend enforces the upstream rate limit and
  // caches, but debouncing still avoids a request per keystroke. Nominatim's
  // usage policy caps requests to
  // roughly 1/sec, so only fire once typing pauses, and cancel any request
  // that's superseded by further typing.
  useEffect(() => {
    const query = locationQuery.trim();
    if (query.length < SEARCH_MIN_CHARS) {
      searchAbortRef.current?.abort();
      setOnlineLocationResults([]);
      setIsSearchingOnline(false);
      return;
    }

    const timer = setTimeout(() => {
      searchAbortRef.current?.abort();
      const controller = new AbortController();
      searchAbortRef.current = controller;
      setIsSearchingOnline(true);

      fetchOnlinePlaces(query, controller.signal)
        .then((results) => {
          if (!controller.signal.aborted) setOnlineLocationResults(results);
        })
        .catch(() => {
          // Offline or request failed — local matches remain available.
        })
        .finally(() => {
          if (!controller.signal.aborted) setIsSearchingOnline(false);
        });
    }, SEARCH_DEBOUNCE_MS);

    return () => clearTimeout(timer);
  }, [locationQuery]);

  const locationResults = useMemo<PlaceResult[]>(() => {
    if (onlineLocationResults.length === 0) return localLocationResults;

    // Prefer the more thorough online results; fill remaining slots with any
    // local matches not already covered by them.
    const merged = [...onlineLocationResults];
    for (const place of localLocationResults) {
      const isDuplicate = merged.some(
        (existing) => Math.abs(existing.lng - place.lng) < 0.01 && Math.abs(existing.lat - place.lat) < 0.01
      );
      if (!isDuplicate) merged.push(place);
    }
    return merged.slice(0, MAX_SEARCH_RESULTS);
  }, [localLocationResults, onlineLocationResults]);

  const handleSelectLocation = useCallback((place: PlaceResult) => {
    searchAbortRef.current?.abort();
    const map = mapRef.current;
    if (map) {
      map.flyTo({ center: [place.lng, place.lat], zoom: SEARCH_FLY_ZOOM, duration: 1200 });
    }
    setLocationQuery(place.name);
    setIsLocationDropdownOpen(false);
  }, []);

  // Capture map as thumbnail
  const captureMapThumbnail = useCallback((): string | undefined => {
    const map = mapRef.current;
    if (!map) return undefined;

    try {
      const canvas = map.getCanvas();
      // Keep auto-captured thumbnails compact to reduce site-create payload size.
      const maxWidth = 280;
      const scale = Math.min(maxWidth / canvas.width, 1);
      const thumbnailCanvas = document.createElement('canvas');
      thumbnailCanvas.width = canvas.width * scale;
      thumbnailCanvas.height = canvas.height * scale;
      const ctx = thumbnailCanvas.getContext('2d');
      if (ctx) {
        ctx.drawImage(canvas, 0, 0, thumbnailCanvas.width, thumbnailCanvas.height);
        return thumbnailCanvas.toDataURL('image/jpeg', 0.72);
      }
    } catch (error) {
      console.error('Failed to capture map thumbnail:', error);
    }
    return undefined;
  }, []);

  const resolveCatchmentFeature = useCallback(async (
    catchmentId: string,
    fallbackFeature: maplibregl.MapGeoJSONFeature,
  ): Promise<GeoJSON.Feature> => {
    try {
      const response = await fetch(`/api/catchments/geometry/${catchmentId}`);
      if (response.ok) {
        const fullFeature = await response.json();
        return fullFeature as GeoJSON.Feature;
      }
    } catch {
      // Fall back to the rendered vector tile feature
    }

    return fallbackFeature as unknown as GeoJSON.Feature;
  }, []);

  // Update selected catchments layer (defined early for use in interaction handlers)
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

  // Initialize map
  useEffect(() => {
    if (!mapContainerRef.current || mapRef.current) return;

    const map = new maplibregl.Map({
      container: mapContainerRef.current,
      style: '/data/style.json',
      center: initialExtent?.center || [22.977, 1.258],
      zoom: initialExtent?.zoom || 4,
      attributionControl: false,
      preserveDrawingBuffer: true, // Required for canvas thumbnail capture
    });

    map.addControl(new maplibregl.NavigationControl(), 'top-right');

    const applyViewportLimits = () => {
      const bounds = viewportBoundsRef.current;
      if (!bounds) return;
      applyZoomOutClipToBounds(map, bounds);
    };

    void (async () => {
      const bounds = await fetchCatchmentBounds() ?? await fetchTileBounds();
      if (!bounds) return;
      viewportBoundsRef.current = bounds;
      applyViewportLimits();
    })();

    map.on('load', () => {
      // Force tile re-evaluation — resize() alone doesn't always trigger
      // maplibre to re-request tiles for a newly-sized viewport.
      map.resize();
      map.jumpTo({ center: map.getCenter(), zoom: map.getZoom() });
      applyViewportLimits();
      mapRef.current = map;
      setIsMapReady(true);

      // The shared basemap style doesn't include catchment boundary layers,
      // so add them here — otherwise catchments are invisible under the
      // ecoregion/country fills with nothing to select against.
      if (!map.getLayer('Catchments Fill')) {
        map.addLayer({
          id: 'Catchments Fill',
          type: 'fill',
          source: 'UoW Tiles',
          'source-layer': 'catchments_lev12',
          minzoom: 8,
          paint: {
            'fill-color': 'rgba(60, 140, 180, 0.1)',
            'fill-outline-color': 'rgba(60, 140, 180, 0.3)',
          },
        });
      }
      if (!map.getLayer('Catchments Outlines')) {
        map.addLayer({
          id: 'Catchments Outlines',
          type: 'line',
          source: 'UoW Tiles',
          'source-layer': 'catchments_lev12',
          minzoom: 8,
          paint: {
            'line-color': 'rgba(60, 140, 180, 0.6)',
            'line-width': 2.5,
          },
        });
      }

      // Add a transparent fill layer for catchment selection (clickable area)
      // This must be added after the base style loads
      if (!map.getLayer('catchments-selectable-fill')) {
        // Check if the Catchments Outlines layer exists in the style
        const beforeLayer = map.getLayer('Catchments Outlines') ? 'Catchments Outlines' : undefined;
        map.addLayer({
          id: 'catchments-selectable-fill',
          type: 'fill',
          source: 'UoW Tiles',
          'source-layer': 'catchments_lev12',
          minzoom: 8,
          paint: {
            'fill-color': 'transparent',
            'fill-opacity': 0,
          },
        }, beforeLayer); // Insert below the outlines if layer exists
      }

      // Default to Google satellite in browser runtime — inject it beneath all vector layers
      if (getAppRuntime() === 'browser') {
        const firstLayerId = map.getStyle()?.layers?.[0]?.id;
        if (!map.getSource(GOOGLE_SATELLITE_SOURCE_ID)) {
          map.addSource(GOOGLE_SATELLITE_SOURCE_ID, {
            type: 'raster',
            tiles: [satelliteTileUrl()],
            tileSize: 256,
            attribution: satelliteAttribution(),
            maxzoom: 21,
          });
        }
        if (!map.getLayer(GOOGLE_SATELLITE_LAYER_ID)) {
          map.addLayer(
            { id: GOOGLE_SATELLITE_LAYER_ID, type: 'raster', source: GOOGLE_SATELLITE_SOURCE_ID },
            firstLayerId,
          );
        }
        // Hide fill/background layers so satellite shows through at all zoom levels.
        // Skip catchments-selectable-fill: it's already invisible (opacity 0) and
        // exists purely so click handlers can query it — hiding it would make
        // maplibre exclude it from queryRenderedFeatures, silently breaking
        // catchment selection while the (line-type) outlines stay visible.
        const hidden: string[] = [];
        for (const layer of map.getStyle()?.layers ?? []) {
          if (layer.id === 'catchments-selectable-fill') continue;
          if (layer.type === 'fill' || layer.type === 'background') {
            map.setLayoutProperty(layer.id, 'visibility', 'none');
            hidden.push(layer.id);
          }
        }
        hiddenLayersRef.current = hidden;
        isGoogleBasemapRef.current = true;
        setIsGoogleBasemap(true);
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

  useEffect(() => {
    if (mode !== 'catchments') {
      setIsBoxSelectionMode(false);
      setSelectionBox(null);
      boxStartPointRef.current = null;
      isDraggingBoxRef.current = false;
    }
  }, [mode]);

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
      map.getCanvas().style.cursor = isBoxSelectionMode ? 'grab' : 'pointer';

      const handleClick = (e: maplibregl.MapMouseEvent) => {
        // Query features at click point from the transparent fill layer
        const features = map.queryRenderedFeatures(e.point, {
          layers: ['catchments-selectable-fill'],
        });

        if (features.length > 0) {
          const feature = features[0];
          const catchmentId = String(feature.properties?.HYBAS_ID || feature.id);
          const fallbackFeature = feature as unknown as GeoJSON.Feature;

          // Apply selection state immediately so first click feels responsive.
          let wasRemoved = false;
          setSelectedCatchments(prev => {
            const next = new Map(prev);
            if (next.has(catchmentId)) {
              next.delete(catchmentId);
              wasRemoved = true;
            } else {
              next.set(catchmentId, fallbackFeature);
            }
            updateSelectedCatchmentsLayer(map, next);
            return next;
          });

          if (wasRemoved) {
            return;
          }

          // Upgrade to full geometry in the background for better visual fidelity.
          const cachedFeature = catchmentGeometryCacheRef.current.get(catchmentId);
          if (cachedFeature) {
            setSelectedCatchments(prev => {
              if (!prev.has(catchmentId)) return prev;
              const next = new Map(prev);
              next.set(catchmentId, cachedFeature);
              updateSelectedCatchmentsLayer(map, next);
              return next;
            });
            return;
          }

          void resolveCatchmentFeature(catchmentId, feature).then((resolvedFeature) => {
            catchmentGeometryCacheRef.current.set(catchmentId, resolvedFeature);
            setSelectedCatchments(prev => {
              if (!prev.has(catchmentId)) return prev;
              const next = new Map(prev);
              next.set(catchmentId, resolvedFeature);
              updateSelectedCatchmentsLayer(map, next);
              return next;
            });
          });
        }
      };

      const handleMouseDown = (e: maplibregl.MapMouseEvent) => {
        if (!isBoxSelectionMode) return;
        if ((e.originalEvent as MouseEvent).button !== 0) return;

        const start = { x: e.point.x, y: e.point.y };
        boxStartPointRef.current = start;
        isDraggingBoxRef.current = true;
        setSelectionBox({ left: start.x, top: start.y, width: 0, height: 0 });
        map.dragPan.disable();
      };

      const handleMouseMove = (e: maplibregl.MapMouseEvent) => {
        if (!isBoxSelectionMode || !isDraggingBoxRef.current || !boxStartPointRef.current) return;

        const start = boxStartPointRef.current;
        const current = { x: e.point.x, y: e.point.y };
        const left = Math.min(start.x, current.x);
        const top = Math.min(start.y, current.y);
        const width = Math.abs(current.x - start.x);
        const height = Math.abs(current.y - start.y);

        setSelectionBox({ left, top, width, height });
      };

      const finishBoxSelection = async (endPoint?: { x: number; y: number }) => {
        if (!isBoxSelectionMode || !isDraggingBoxRef.current || !boxStartPointRef.current) return;

        const start = boxStartPointRef.current;
        const end = endPoint ?? start;
        const left = Math.min(start.x, end.x);
        const top = Math.min(start.y, end.y);
        const right = Math.max(start.x, end.x);
        const bottom = Math.max(start.y, end.y);

        boxStartPointRef.current = null;
        isDraggingBoxRef.current = false;
        setSelectionBox(null);
        map.dragPan.enable();

        // Ignore tiny drags that are effectively clicks.
        if (Math.abs(right - left) < 4 || Math.abs(bottom - top) < 4) return;

        const nw = map.unproject([left, top]);
        const se = map.unproject([right, bottom]);
        const bbox = {
          minX: Math.min(nw.lng, se.lng),
          minY: Math.min(nw.lat, se.lat),
          maxX: Math.max(nw.lng, se.lng),
          maxY: Math.max(nw.lat, se.lat),
        };

        let bboxFeatures: GeoJSON.Feature[] = [];
        let isTruncated = false;

        try {
          const response = await fetch('/api/catchments/in-bbox', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(bbox),
          });

          if (!response.ok) {
            throw new Error('Failed to query catchments in bounding box');
          }

          const result = await response.json() as {
            features?: GeoJSON.Feature[];
            truncated?: boolean;
          };

          bboxFeatures = Array.isArray(result.features) ? result.features : [];
          isTruncated = result.truncated === true;
        } catch (error) {
          toast({
            title: 'Box select failed',
            description: error instanceof Error ? error.message : 'Unknown error',
            status: 'error',
            duration: 3000,
          });
          return;
        }

        const featureById = new Map<string, GeoJSON.Feature>();
        for (const feature of bboxFeatures) {
          const catchmentId = String(feature.properties?.HYBAS_ID || feature.id);
          if (!catchmentId || featureById.has(catchmentId)) continue;
          featureById.set(catchmentId, feature);
        }

        if (featureById.size === 0) {
          toast({
            title: 'No catchments found in box',
            status: 'info',
            duration: 2500,
          });
          return;
        }

        const alreadySelected = new Set(selectedCatchments.keys());
        const idsToAdd = Array.from(featureById.keys()).filter((id) => !alreadySelected.has(id));
        if (idsToAdd.length === 0) {
          toast({
            title: 'All catchments in this box are already selected',
            status: 'info',
            duration: 2500,
          });
          return;
        }

        setSelectedCatchments((prev) => {
          const next = new Map(prev);
          for (const id of idsToAdd) {
            const feature = featureById.get(id);
            if (feature) {
              next.set(id, feature);
            }
          }
          updateSelectedCatchmentsLayer(map, next);
          return next;
        });

        toast({
          title: `${idsToAdd.length} catchment${idsToAdd.length > 1 ? 's' : ''} added`,
          status: 'success',
          duration: 2500,
        });

        if (isTruncated) {
          toast({
            title: 'Selection limit reached',
            description: 'Not all catchments in this box were returned. Zoom in and select again to add more.',
            status: 'warning',
            duration: 4000,
          });
        }
      };

      const handleMouseUp = (e: maplibregl.MapMouseEvent) => {
        void finishBoxSelection({ x: e.point.x, y: e.point.y });
      };

      const handleMouseLeave = () => {
        void finishBoxSelection();
      };

      map.on('click', handleClick);
      map.on('mousedown', handleMouseDown);
      map.on('mousemove', handleMouseMove);
      map.on('mouseup', handleMouseUp);
      map.on('mouseleave', handleMouseLeave);

      return () => {
        map.off('click', handleClick);
        map.off('mousedown', handleMouseDown);
        map.off('mousemove', handleMouseMove);
        map.off('mouseup', handleMouseUp);
        map.off('mouseleave', handleMouseLeave);
        if (!map.dragPan.isEnabled()) {
          map.dragPan.enable();
        }
        boxStartPointRef.current = null;
        isDraggingBoxRef.current = false;
        setSelectionBox(null);
        map.getCanvas().style.cursor = '';
      };
    }
  }, [
    mode,
    isMapReady,
    isBoxSelectionMode,
    selectedCatchments,
    resolveCatchmentFeature,
    updateSelectedCatchmentsLayer,
    toast,
  ]);

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

    moveSiteGeometryToTop(map);
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
      const thumbnail = captureMapThumbnail();
      onGeometryComplete(polygon, undefined, thumbnail);
    }, 800);
  }, [drawnPoints, addGeometryToMap, onGeometryComplete, captureMapThumbnail]);

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
        const thumbnail = captureMapThumbnail();
        onGeometryComplete(result.geometry, catchmentIds, thumbnail);
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
  }, [selectedCatchments, addGeometryToMap, onGeometryComplete, toast, captureMapThumbnail]);

  // Confirm for uploaded geometry
  const handleConfirmGeometry = useCallback(() => {
    if (initialGeometry) {
      const thumbnail = captureMapThumbnail();
      onGeometryComplete(initialGeometry, undefined, thumbnail);
    }
  }, [initialGeometry, onGeometryComplete, captureMapThumbnail]);

  // Reset drawing
  const handleReset = useCallback(() => {
    setDrawnPoints([]);
    setSelectedCatchments(new Map());
    setShowConfirm(false);
    setSelectionBox(null);
    setIsBoxSelectionMode(false);
    boxStartPointRef.current = null;
    isDraggingBoxRef.current = false;

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

  const toggleGoogleBasemap = useCallback(() => {
    const map = mapRef.current;
    if (!map) return;

    const next = !isGoogleBasemapRef.current;
    isGoogleBasemapRef.current = next;
    setIsGoogleBasemap(next);

    if (next) {
      if (!map.getSource(GOOGLE_SATELLITE_SOURCE_ID)) {
        map.addSource(GOOGLE_SATELLITE_SOURCE_ID, {
          type: 'raster',
          tiles: [satelliteTileUrl()],
          tileSize: 256,
          attribution: satelliteAttribution(),
          maxzoom: 21,
        });
      }
      if (!map.getLayer(GOOGLE_SATELLITE_LAYER_ID)) {
        const firstLayerId = map.getStyle()?.layers?.[0]?.id;
        map.addLayer(
          { id: GOOGLE_SATELLITE_LAYER_ID, type: 'raster', source: GOOGLE_SATELLITE_SOURCE_ID },
          firstLayerId,
        );
      }
      // Skip catchments-selectable-fill (needed for click detection despite being
      // invisible) and the site boundary's own fill, which must stay visible.
      const skipHiding = new Set([GOOGLE_SATELLITE_LAYER_ID, 'catchments-selectable-fill', 'site-fill']);
      const hidden: string[] = [];
      for (const layer of map.getStyle()?.layers ?? []) {
        if (skipHiding.has(layer.id)) continue;
        if (layer.type === 'fill' || layer.type === 'background') {
          map.setLayoutProperty(layer.id, 'visibility', 'none');
          hidden.push(layer.id);
        }
      }
      hiddenLayersRef.current = hidden;
      moveSiteGeometryToTop(map);
    } else {
      if (map.getLayer(GOOGLE_SATELLITE_LAYER_ID)) map.removeLayer(GOOGLE_SATELLITE_LAYER_ID);
      if (map.getSource(GOOGLE_SATELLITE_SOURCE_ID)) map.removeSource(GOOGLE_SATELLITE_SOURCE_ID);
      for (const layerId of hiddenLayersRef.current) {
        if (map.getLayer(layerId)) {
          map.setLayoutProperty(layerId, 'visibility', 'visible');
        }
      }
      hiddenLayersRef.current = [];
    }
  }, []);

  const getInstructions = () => {
    switch (mode) {
      case 'drawn':
        return drawnPoints.length === 0
          ? 'Click on the map to start drawing your site boundary'
          : drawnPoints.length < 3
          ? `Click to add more points (${3 - drawnPoints.length} more needed)`
          : 'Click to add more points, or confirm when ready';
      case 'catchments':
        return selectedCatchments.size != 0
          ? `${selectedCatchments.size} catchment${selectedCatchments.size > 1 ? 's' : ''} selected`
          : isBoxSelectionMode
          ? 'Drag to draw a selection box and add catchments'
          : 'Click catchments, or enable Box Select to drag a bounding box';
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

      {/* Location search */}
      <AnimatePresence>
        {isMapReady && (
          <MotionBox
            initial={{ opacity: 0, x: -20 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: -20 }}
            position="absolute"
            top={4}
            left={4}
            w="260px"
            zIndex={2}
          >
            <InputGroup size="sm">
              <InputLeftElement pointerEvents="none">
                <FiSearch color="white" />
              </InputLeftElement>
              <Input
                placeholder="Search for a location..."
                value={locationQuery}
                onChange={(e) => {
                  setLocationQuery(e.target.value);
                  setIsLocationDropdownOpen(true);
                }}
                onFocus={() => setIsLocationDropdownOpen(true)}
                onBlur={() => setTimeout(() => setIsLocationDropdownOpen(false), 150)}
                bg="blackAlpha.700"
                color="white"
                border="1px solid"
                borderColor="whiteAlpha.300"
                backdropFilter="blur(10px)"
                borderRadius="lg"
                _placeholder={{ color: 'whiteAlpha.700' }}
                _hover={{ borderColor: 'whiteAlpha.400' }}
                _focus={{ borderColor: colors.orange, boxShadow: 'none' }}
              />
              {isSearchingOnline && (
                <InputRightElement>
                  <Spinner size="xs" color="whiteAlpha.700" />
                </InputRightElement>
              )}
            </InputGroup>
            {isLocationDropdownOpen && locationResults.length > 0 && (
              <List
                mt={1}
                bg="blackAlpha.800"
                backdropFilter="blur(10px)"
                borderRadius="lg"
                border="1px solid"
                borderColor="whiteAlpha.300"
                overflow="hidden"
              >
                {locationResults.map((place) => (
                  <ListItem key={`${place.name}-${place.lng}-${place.lat}`}>
                    <Button
                      w="100%"
                      justifyContent="flex-start"
                      leftIcon={<FiMapPin />}
                      onClick={() => handleSelectLocation(place)}
                      variant="ghost"
                      color="white"
                      fontWeight="normal"
                      borderRadius="none"
                      _hover={{ bg: 'whiteAlpha.200' }}
                    >
                      {place.name}
                    </Button>
                  </ListItem>
                ))}
              </List>
            )}
          </MotionBox>
        )}
      </AnimatePresence>

      {/* Google basemap toggle */}
      <AnimatePresence>
        {isMapReady && (
          <MotionBox
            initial={{ opacity: 0, x: -20 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: -20 }}
            position="absolute"
            top={16}
            left={4}
          >
            <Tooltip
              label={isGoogleBasemap ? 'Switch to default basemap' : 'Switch to Google satellite'}
              placement="right"
            >
              <IconButton
                aria-label="Toggle Google satellite basemap"
                icon={<FiGlobe />}
                size="sm"
                onClick={toggleGoogleBasemap}
                bg={isGoogleBasemap ? 'cyan.500' : 'blackAlpha.700'}
                color={isGoogleBasemap ? 'black' : 'white'}
                _hover={{ bg: isGoogleBasemap ? 'cyan.400' : 'blackAlpha.600' }}
                backdropFilter="blur(10px)"
                borderRadius="lg"
              />
            </Tooltip>
          </MotionBox>
        )}
      </AnimatePresence>

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
        {mode === 'catchments' && (
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
                leftIcon={<FiSquare />}
                onClick={() => setIsBoxSelectionMode((prev) => !prev)}
                bg={isBoxSelectionMode ? 'cyan.500' : 'blackAlpha.700'}
                color={isBoxSelectionMode ? 'black' : 'white'}
                _hover={{ bg: isBoxSelectionMode ? 'cyan.400' : 'blackAlpha.600' }}
                backdropFilter="blur(10px)"
              >
                {isBoxSelectionMode ? 'Box Select: ON' : 'Box Select'}
              </Button>
              {selectedCatchments.size > 0 && (
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
              )}
            </HStack>
          </MotionBox>
        )}
      </AnimatePresence>

      {/* Box selection visual overlay */}
      {mode === 'catchments' && isBoxSelectionMode && selectionBox && (
        <Box
          position="absolute"
          left={`${selectionBox.left}px`}
          top={`${selectionBox.top}px`}
          width={`${selectionBox.width}px`}
          height={`${selectionBox.height}px`}
          border="2px solid"
          borderColor="cyan.300"
          bg="cyan.300"
          opacity={0.2}
          pointerEvents="none"
        />
      )}

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
              bg={colors.orange}
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
