/**
 * Internal planar geometry for service zones (V1.6). Coordinates follow GeoJSON order
 * [longitude, latitude]. Zones are small (city scale), so planar math on degrees is adequate;
 * this module is the single place to replace with PostGIS (ST_Covers/ST_Intersects) later.
 */
export type GeoPoint = { latitude: number; longitude: number };
type Position = [number, number];
type Ring = Position[];
export type PolygonGeometry = { type: 'Polygon'; coordinates: Ring[] };
export type MultiPolygonGeometry = {
  type: 'MultiPolygon';
  coordinates: Ring[][];
};
export type ZoneBoundary = PolygonGeometry | MultiPolygonGeometry;
export type BoundingBox = {
  minLatitude: number;
  maxLatitude: number;
  minLongitude: number;
  maxLongitude: number;
};

const EPSILON = 1e-12;
const MAX_POSITIONS = 10000;

export class InvalidBoundaryError extends Error {}

function position(value: unknown, path: string): Position {
  if (
    !Array.isArray(value) ||
    value.length !== 2 ||
    !value.every((n) => typeof n === 'number' && Number.isFinite(n))
  )
    throw new InvalidBoundaryError(`${path} must be [longitude, latitude]`);
  const [lng, lat] = value as Position;
  if (lng < -180 || lng > 180 || lat < -90 || lat > 90)
    throw new InvalidBoundaryError(
      `${path} is outside valid coordinate ranges`,
    );
  return [lng, lat];
}

function ring(value: unknown, path: string): Ring {
  if (!Array.isArray(value) || value.length < 4)
    throw new InvalidBoundaryError(
      `${path} must be a closed ring with at least 4 positions`,
    );
  const points = value.map((p, i) => position(p, `${path}[${i}]`));
  const [first, last] = [points[0], points[points.length - 1]];
  if (first[0] !== last[0] || first[1] !== last[1])
    throw new InvalidBoundaryError(`${path} must be closed (first = last)`);
  if (Math.abs(signedArea(points)) < EPSILON)
    throw new InvalidBoundaryError(`${path} must enclose a non-zero area`);
  if (ringSelfIntersects(points))
    throw new InvalidBoundaryError(`${path} must not self-intersect`);
  return points;
}

function polygon(value: unknown, path: string): Ring[] {
  if (!Array.isArray(value) || value.length < 1)
    throw new InvalidBoundaryError(`${path} must contain an outer ring`);
  return value.map((r, i) => ring(r, `${path}[${i}]`));
}

/** Validates and normalizes a GeoJSON Polygon/MultiPolygon (holes allowed). */
export function parseBoundary(value: unknown): ZoneBoundary {
  if (!value || typeof value !== 'object')
    throw new InvalidBoundaryError(
      'boundary must be a GeoJSON geometry object',
    );
  const { type, coordinates } = value as {
    type?: unknown;
    coordinates?: unknown;
  };
  let boundary: ZoneBoundary;
  if (type === 'Polygon')
    boundary = { type, coordinates: polygon(coordinates, 'coordinates') };
  else if (type === 'MultiPolygon') {
    if (!Array.isArray(coordinates) || coordinates.length < 1)
      throw new InvalidBoundaryError('coordinates must contain polygons');
    boundary = {
      type,
      coordinates: coordinates.map((p, i) => polygon(p, `coordinates[${i}]`)),
    };
  } else
    throw new InvalidBoundaryError(
      'boundary.type must be Polygon or MultiPolygon',
    );
  if (positions(boundary).length > MAX_POSITIONS)
    throw new InvalidBoundaryError(
      `boundary exceeds ${MAX_POSITIONS} positions`,
    );
  return boundary;
}

const polygonsOf = (b: ZoneBoundary) =>
  b.type === 'Polygon' ? [b.coordinates] : b.coordinates;
const positions = (b: ZoneBoundary) => polygonsOf(b).flat(2) as Position[];

export function boundingBox(boundary: ZoneBoundary): BoundingBox {
  const points = positions(boundary);
  return {
    minLongitude: Math.min(...points.map((p) => p[0])),
    maxLongitude: Math.max(...points.map((p) => p[0])),
    minLatitude: Math.min(...points.map((p) => p[1])),
    maxLatitude: Math.max(...points.map((p) => p[1])),
  };
}

function signedArea(points: Ring) {
  let area = 0;
  for (let i = 0; i < points.length - 1; i++)
    area += points[i][0] * points[i + 1][1] - points[i + 1][0] * points[i][1];
  return area / 2;
}

function orientation(a: Position, b: Position, c: Position) {
  const value = (b[1] - a[1]) * (c[0] - b[0]) - (b[0] - a[0]) * (c[1] - b[1]);
  return Math.abs(value) < EPSILON ? 0 : value > 0 ? 1 : 2;
}
function onSegment(a: Position, p: Position, b: Position) {
  return (
    p[0] <= Math.max(a[0], b[0]) + EPSILON &&
    p[0] >= Math.min(a[0], b[0]) - EPSILON &&
    p[1] <= Math.max(a[1], b[1]) + EPSILON &&
    p[1] >= Math.min(a[1], b[1]) - EPSILON
  );
}
function segmentsIntersect(
  p1: Position,
  q1: Position,
  p2: Position,
  q2: Position,
) {
  const o1 = orientation(p1, q1, p2);
  const o2 = orientation(p1, q1, q2);
  const o3 = orientation(p2, q2, p1);
  const o4 = orientation(p2, q2, q1);
  if (o1 !== o2 && o3 !== o4) return true;
  return (
    (o1 === 0 && onSegment(p1, p2, q1)) ||
    (o2 === 0 && onSegment(p1, q2, q1)) ||
    (o3 === 0 && onSegment(p2, p1, q2)) ||
    (o4 === 0 && onSegment(p2, q1, q2))
  );
}
function ringSelfIntersects(points: Ring) {
  const n = points.length - 1;
  for (let i = 0; i < n; i++)
    for (let j = i + 1; j < n; j++) {
      // Adjacent edges share a vertex by construction.
      if (j === i + 1 || (i === 0 && j === n - 1)) continue;
      if (segmentsIntersect(points[i], points[i + 1], points[j], points[j + 1]))
        return true;
    }
  return false;
}

/** Points on the ring border count as inside (closed set semantics). */
function ringCovers(points: Ring, p: Position) {
  let inside = false;
  for (let i = 0, j = points.length - 2; i < points.length - 1; j = i++) {
    const [xi, yi] = points[i];
    const [xj, yj] = points[j];
    if (
      orientation(points[j], points[i], p) === 0 &&
      onSegment(points[j], p, points[i])
    )
      return true;
    if (
      yi > p[1] !== yj > p[1] &&
      p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi
    )
      inside = !inside;
  }
  return inside;
}
function polygonCovers(rings: Ring[], p: Position) {
  const [outer, ...holes] = rings;
  if (!ringCovers(outer, p)) return false;
  // A point strictly inside a hole is outside; a point on a hole border stays inside.
  return !holes.some((hole) => ringCovers(hole, p) && !onRingBorder(hole, p));
}
function onRingBorder(points: Ring, p: Position) {
  for (let i = 0; i < points.length - 1; i++)
    if (
      orientation(points[i], points[i + 1], p) === 0 &&
      onSegment(points[i], p, points[i + 1])
    )
      return true;
  return false;
}

export function containsPoint(boundary: ZoneBoundary, point: GeoPoint) {
  const p: Position = [point.longitude, point.latitude];
  return polygonsOf(boundary).some((rings) => polygonCovers(rings, p));
}

/** True when two boundaries share any area or border (touching counts as intersecting). */
export function boundariesIntersect(a: ZoneBoundary, b: ZoneBoundary) {
  for (const pa of polygonsOf(a))
    for (const pb of polygonsOf(b)) {
      const [outerA] = pa;
      const [outerB] = pb;
      for (let i = 0; i < outerA.length - 1; i++)
        for (let j = 0; j < outerB.length - 1; j++)
          if (
            segmentsIntersect(
              outerA[i],
              outerA[i + 1],
              outerB[j],
              outerB[j + 1],
            )
          )
            return true;
      if (polygonCovers(pb, outerA[0]) || polygonCovers(pa, outerB[0]))
        return true;
    }
  return false;
}
