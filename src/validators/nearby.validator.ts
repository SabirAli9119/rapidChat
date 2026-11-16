import { z } from 'zod';
import { env } from '../config/env';

export const updateLocationSchema = z.object({
  body: z.object({
    latitude: z.number().min(-90).max(90),
    longitude: z.number().min(-180).max(180),
  }),
});

export const searchNearbySchema = z.object({
  query: z.object({
    radiusKm: z.coerce
      .number()
      .positive('radiusKm must be greater than 0')
      .max(env.NEARBY_MAX_RADIUS_KM, `radiusKm cannot be more than ${env.NEARBY_MAX_RADIUS_KM} km`)
      .default(env.NEARBY_MAX_RADIUS_KM),
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(50).default(20),
  }),
});

export type UpdateLocationInput = z.infer<typeof updateLocationSchema>['body'];
export type SearchNearbyInput = z.infer<typeof searchNearbySchema>['query'];