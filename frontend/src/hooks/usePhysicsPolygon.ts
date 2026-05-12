import { useEffect, useRef, useState, useCallback } from 'react';
import Matter from 'matter-js';

// Vibrant colors for the site boundary
const SITE_COLORS = {
  primary: '#00FFFF',    // Cyan
  secondary: '#FF00FF',  // Magenta
  accent: '#FFFF00',     // Yellow
  glow: '#00FF88',       // Electric green
};

interface PhysicsPolygonState {
  isSettled: boolean;
  position: { x: number; y: number };
  angle: number;
  scale: number;
}

interface UsePhysicsPolygonOptions {
  containerRef: React.RefObject<HTMLDivElement>;
  geometry: GeoJSON.Geometry | null;
  enabled?: boolean;
  onSettled?: () => void;
  dropDelay?: number;
}

/**
 * Hook that creates a Matter.js physics simulation for polygon geometry
 * The polygon "drops" in with physics and settles into place with a satisfying thunk
 */
export function usePhysicsPolygon({
  containerRef,
  geometry,
  enabled = true,
  onSettled,
  dropDelay = 200,
}: UsePhysicsPolygonOptions): PhysicsPolygonState {
  const engineRef = useRef<Matter.Engine | null>(null);
  const renderRef = useRef<Matter.Render | null>(null);
  const runnerRef = useRef<Matter.Runner | null>(null);
  const bodyRef = useRef<Matter.Body | null>(null);

  const [state, setState] = useState<PhysicsPolygonState>({
    isSettled: false,
    position: { x: 0, y: 0 },
    angle: 0,
    scale: 1,
  });

  const cleanup = useCallback(() => {
    if (runnerRef.current) {
      Matter.Runner.stop(runnerRef.current);
      runnerRef.current = null;
    }
    if (renderRef.current) {
      Matter.Render.stop(renderRef.current);
      renderRef.current.canvas.remove();
      renderRef.current = null;
    }
    if (engineRef.current) {
      Matter.Engine.clear(engineRef.current);
      engineRef.current = null;
    }
    bodyRef.current = null;
  }, []);

  useEffect(() => {
    if (!enabled || !geometry || !containerRef.current) {
      cleanup();
      return;
    }

    const container = containerRef.current;
    const width = container.clientWidth;
    const height = container.clientHeight;

    // Create engine with custom gravity for dramatic drop
    const engine = Matter.Engine.create({
      gravity: { x: 0, y: 1.5, scale: 0.001 },
    });
    engineRef.current = engine;

    // Create renderer with transparent background
    const render = Matter.Render.create({
      element: container,
      engine: engine,
      options: {
        width,
        height,
        wireframes: false,
        background: 'transparent',
        pixelRatio: window.devicePixelRatio,
      },
    });
    renderRef.current = render;

    // Create ground at the bottom
    const ground = Matter.Bodies.rectangle(
      width / 2,
      height + 30,
      width * 2,
      60,
      {
        isStatic: true,
        render: { visible: false },
      }
    );

    // Create left and right walls (invisible)
    const leftWall = Matter.Bodies.rectangle(-30, height / 2, 60, height * 2, {
      isStatic: true,
      render: { visible: false },
    });
    const rightWall = Matter.Bodies.rectangle(width + 30, height / 2, 60, height * 2, {
      isStatic: true,
      render: { visible: false },
    });

    // Convert GeoJSON geometry to Matter.js vertices
    const vertices = geometryToVertices(geometry, width, height);

    if (vertices.length > 0) {
      // Create the polygon body
      const body = Matter.Bodies.fromVertices(
        width / 2,
        -100, // Start above the visible area
        [vertices],
        {
          restitution: 0.3,     // Bounciness
          friction: 0.8,         // High friction for settling
          frictionAir: 0.02,     // Air resistance
          density: 0.002,        // Mass
          render: {
            fillStyle: `${SITE_COLORS.primary}33`,
            strokeStyle: SITE_COLORS.primary,
            lineWidth: 4,
          },
        }
      );
      bodyRef.current = body;

      // Add random initial rotation for visual interest
      Matter.Body.setAngularVelocity(body, (Math.random() - 0.5) * 0.1);

      // Delay the drop for dramatic effect
      setTimeout(() => {
        Matter.Composite.add(engine.world, [ground, leftWall, rightWall, body]);
      }, dropDelay);
    } else {
      Matter.Composite.add(engine.world, [ground, leftWall, rightWall]);
    }

    // Track settling
    let settledCounter = 0;
    const SETTLE_THRESHOLD = 30; // Frames of low velocity before considering settled

    Matter.Events.on(engine, 'afterUpdate', () => {
      const body = bodyRef.current;
      if (!body) return;

      const velocity = body.velocity;
      const angularVelocity = body.angularVelocity;
      const isMoving = Math.abs(velocity.x) > 0.05 ||
                       Math.abs(velocity.y) > 0.05 ||
                       Math.abs(angularVelocity) > 0.001;

      if (!isMoving) {
        settledCounter++;
        if (settledCounter >= SETTLE_THRESHOLD && !state.isSettled) {
          setState(prev => ({ ...prev, isSettled: true }));
          onSettled?.();

          // Add a final "thunk" effect by making the body static
          Matter.Body.setStatic(body, true);
        }
      } else {
        settledCounter = 0;
      }

      setState({
        isSettled: settledCounter >= SETTLE_THRESHOLD,
        position: body.position,
        angle: body.angle,
        scale: 1,
      });
    });

    // Start the simulation
    const runner = Matter.Runner.create();
    runnerRef.current = runner;
    Matter.Runner.run(runner, engine);
    Matter.Render.run(render);

    return cleanup;
  }, [enabled, geometry, containerRef, cleanup, dropDelay, onSettled, state.isSettled]);

  return state;
}

/**
 * Convert GeoJSON geometry to Matter.js vertices
 */
function geometryToVertices(
  geometry: GeoJSON.Geometry,
  containerWidth: number,
  containerHeight: number
): Matter.Vector[] {
  // Get all coordinates from the geometry
  const coords = extractCoordinates(geometry);
  if (coords.length === 0) return [];

  // Find bounding box
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [x, y] of coords) {
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  }

  const geoWidth = maxX - minX;
  const geoHeight = maxY - minY;

  // Scale to fit container with padding
  const padding = 60;
  const availableWidth = containerWidth - padding * 2;
  const availableHeight = containerHeight - padding * 2;
  const scale = Math.min(availableWidth / geoWidth, availableHeight / geoHeight);

  // Convert to screen coordinates (flip Y axis)
  const vertices: Matter.Vector[] = [];
  for (const [x, y] of coords) {
    vertices.push({
      x: ((x - minX) * scale) + padding,
      y: ((maxY - y) * scale) + padding, // Flip Y
    });
  }

  // Simplify if too many vertices (Matter.js can struggle with complex polygons)
  if (vertices.length > 100) {
    return simplifyVertices(vertices, 100);
  }

  return vertices;
}

/**
 * Extract coordinates from GeoJSON geometry
 */
function extractCoordinates(geometry: GeoJSON.Geometry): [number, number][] {
  switch (geometry.type) {
    case 'Polygon':
      // Use the outer ring
      return geometry.coordinates[0] as [number, number][];

    case 'MultiPolygon':
      // Use the first polygon's outer ring
      return geometry.coordinates[0]?.[0] as [number, number][] || [];

    case 'Point':
      return [geometry.coordinates as [number, number]];

    case 'LineString':
      return geometry.coordinates as [number, number][];

    case 'MultiPoint':
    case 'MultiLineString':
      return geometry.coordinates.flat() as [number, number][];

    case 'GeometryCollection':
      return geometry.geometries.flatMap(g => extractCoordinates(g));

    default:
      return [];
  }
}

/**
 * Simplify vertices using Douglas-Peucker-like algorithm
 */
function simplifyVertices(vertices: Matter.Vector[], maxPoints: number): Matter.Vector[] {
  if (vertices.length <= maxPoints) return vertices;

  const step = Math.ceil(vertices.length / maxPoints);
  const simplified: Matter.Vector[] = [];

  for (let i = 0; i < vertices.length; i += step) {
    simplified.push(vertices[i]);
  }

  // Ensure the polygon is closed
  if (simplified.length > 0 && simplified[0] !== simplified[simplified.length - 1]) {
    simplified.push(simplified[0]);
  }

  return simplified;
}

export { SITE_COLORS };
