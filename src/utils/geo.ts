export interface Coordinates {
  latitude: number;
  longitude: number;
}

const EARTH_RADIUS_KM = 6371;

const toRadians = (degrees: number): number => (degrees * Math.PI) / 180;

export function isValidCoordinates({ latitude, longitude }: Coordinates): boolean {
  return (
    Number.isFinite(latitude) &&
    Number.isFinite(longitude) &&
    latitude >= -90 &&
    latitude <= 90 &&
    longitude >= -180 &&
    longitude <= 180
  );
}

/** Straight-line distance between two points on Earth, in kilometres (haversine formula). */
export function haversineDistanceKm(a: Coordinates, b: Coordinates): number {
  const dLat = toRadians(b.latitude - a.latitude);
  const dLon = toRadians(b.longitude - a.longitude);

  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRadians(a.latitude)) * Math.cos(toRadians(b.latitude)) * Math.sin(dLon / 2) ** 2;

  return 2 * EARTH_RADIUS_KM * Math.asin(Math.sqrt(h));
}

export const kmToMeters = (km: number): number => km * 1000;

/**
 * Snaps coordinates to a coarse grid before they are stored.
 * 3 decimals is roughly 110 m. Because this is deterministic (not random jitter),
 * repeated requests cannot be averaged to recover the exact position.
 */
export function coarsenCoordinates(coords: Coordinates, decimals = 3): Coordinates {
  const factor = 10 ** decimals;
  return {
    latitude: Math.round(coords.latitude * factor) / factor,
    longitude: Math.round(coords.longitude * factor) / factor,
  };
}

/** GeoJSON uses [longitude, latitude] order, which is the opposite of what people expect. */
export function toGeoJsonPoint(coords: Coordinates): { type: 'Point'; coordinates: [number, number] } {
  return { type: 'Point', coordinates: [coords.longitude, coords.latitude] };
}

/**
 * Turns an exact distance into a rounded-up bucket, so the API never reveals precise distance.
 * 0.3 km → "Less than 1 km away", 2.4 km → "Within 3 km"
 */
export function approximateDistance(distanceKm: number): { bucketKm: number; label: string } {
  const bucketKm = Math.max(1, Math.ceil(distanceKm));
  const label = bucketKm === 1 ? 'Less than 1 km away' : `Within ${bucketKm} km`;
  return { bucketKm, label };
}