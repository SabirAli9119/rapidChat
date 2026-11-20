import { describe, expect, it } from 'vitest';
import {
  approximateDistance,
  coarsenCoordinates,
  haversineDistanceKm,
  isValidCoordinates,
  kmToMeters,
  toGeoJsonPoint,
} from '../../src/utils/geo';

describe('distance', () => {
  it('is zero between identical points', () => {
    const point = { latitude: 28.6, longitude: 77.2 };
    expect(haversineDistanceKm(point, point)).toBe(0);
  });

  it('knows that one degree of latitude is about 111 km', () => {
    expect(haversineDistanceKm({ latitude: 0, longitude: 0 }, { latitude: 1, longitude: 0 })).toBeCloseTo(111.19, 1);
  });

  it('measures a short city distance', () => {
    const km = haversineDistanceKm(
      { latitude: 28.6315, longitude: 77.2167 },
      { latitude: 28.6129, longitude: 77.2295 },
    );
    expect(km).toBeGreaterThan(2.35);
    expect(km).toBeLessThan(2.5);
  });

  it('is the same in both directions', () => {
    const a = { latitude: 28.6, longitude: 77.2 };
    const b = { latitude: 28.5, longitude: 77.3 };
    expect(haversineDistanceKm(a, b)).toBeCloseTo(haversineDistanceKm(b, a), 10);
  });

  it('converts kilometres to metres', () => {
    expect(kmToMeters(5)).toBe(5000);
  });
});

describe('privacy rounding', () => {
  it('snaps stored positions to a grid of about 110 m', () => {
    expect(coarsenCoordinates({ latitude: 28.631512, longitude: 77.216789 })).toEqual({
      latitude: 28.632,
      longitude: 77.217,
    });
    expect(coarsenCoordinates({ latitude: -33.8688, longitude: 151.2093 })).toEqual({
      latitude: -33.869,
      longitude: 151.209,
    });
  });

  it('never moves a point by more than 200 m', () => {
    const original = { latitude: 28.631512, longitude: 77.216789 };
    expect(haversineDistanceKm(original, coarsenCoordinates(original))).toBeLessThan(0.2);
  });

  it('is deterministic, so repeated requests cannot be averaged to find the exact point', () => {
    const point = { latitude: 28.631512, longitude: 77.216789 };
    expect(coarsenCoordinates(point)).toEqual(coarsenCoordinates(point));
  });

  it('puts longitude first for GeoJSON', () => {
    expect(toGeoJsonPoint({ latitude: 28.6, longitude: 77.2 })).toEqual({ type: 'Point', coordinates: [77.2, 28.6] });
  });

  it('turns exact distances into rounded-up buckets', () => {
    expect(approximateDistance(0)).toEqual({ bucketKm: 1, label: 'Less than 1 km away' });
    expect(approximateDistance(0.3)).toEqual({ bucketKm: 1, label: 'Less than 1 km away' });
    expect(approximateDistance(1.01)).toEqual({ bucketKm: 2, label: 'Within 2 km' });
    expect(approximateDistance(2.42)).toEqual({ bucketKm: 3, label: 'Within 3 km' });
    expect(approximateDistance(4.99)).toEqual({ bucketKm: 5, label: 'Within 5 km' });
  });
});

describe('coordinate validation', () => {
  it('accepts the full valid range', () => {
    expect(isValidCoordinates({ latitude: 90, longitude: 180 })).toBe(true);
    expect(isValidCoordinates({ latitude: -90, longitude: -180 })).toBe(true);
    expect(isValidCoordinates({ latitude: 0, longitude: 0 })).toBe(true);
  });

  it('rejects out-of-range and non-numeric values', () => {
    expect(isValidCoordinates({ latitude: 90.1, longitude: 0 })).toBe(false);
    expect(isValidCoordinates({ latitude: 0, longitude: 180.1 })).toBe(false);
    expect(isValidCoordinates({ latitude: Number.NaN, longitude: 0 })).toBe(false);
    expect(isValidCoordinates({ latitude: 0, longitude: Number.POSITIVE_INFINITY })).toBe(false);
  });
});