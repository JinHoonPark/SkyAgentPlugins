type Point = { x: number; y: number };
type Size = { width: number; height: number };

const PAN_KEEP_PX = 64;
export const DEFAULT_ZOOM = 1;
export const MIN_ZOOM = 0.25;
export const MAX_ZOOM = 2;

export function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function axisBounds(contentSize: number, viewportSize: number) {
  const keep = Math.min(contentSize, viewportSize, PAN_KEEP_PX);
  return { min: keep - contentSize, max: viewportSize - keep };
}

export function panBounds(
  canvasWidth: number,
  canvasHeight: number,
  viewportWidth: number,
  viewportHeight: number,
  scale: number,
) {
  const x = axisBounds(canvasWidth * scale, viewportWidth);
  const y = axisBounds(canvasHeight * scale, viewportHeight);
  return { minX: x.min, maxX: x.max, minY: y.min, maxY: y.max };
}

export function canvasToViewport(point: Point, camera: Point, scale: number): Point {
  return { x: camera.x + point.x * scale, y: camera.y + point.y * scale };
}

export function zoomAtCursor(
  camera: Point,
  scale: number,
  deltaY: number,
  cursor: Point,
  canvas: Size,
  viewport: Size,
) {
  const nextScale = clamp(scale * Math.exp(-deltaY * 0.002), MIN_ZOOM, MAX_ZOOM);
  const ratio = nextScale / scale;
  const bounds = panBounds(canvas.width, canvas.height, viewport.width, viewport.height, nextScale);
  return {
    scale: nextScale,
    camera: {
      x: clamp(cursor.x - (cursor.x - camera.x) * ratio, bounds.minX, bounds.maxX),
      y: clamp(cursor.y - (cursor.y - camera.y) * ratio, bounds.minY, bounds.maxY),
    },
    bounds,
  };
}
