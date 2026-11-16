import { z } from 'zod';
import { REPORT_REASONS } from '../types';
import { objectIdSchema, paginationQuerySchema } from './common.validator';

const reportBase = {
  reason: z.enum(REPORT_REASONS),
  details: z.string().trim().max(1000, 'Details must be at most 1000 characters').default(''),
};

/**
 * Report a user OR a specific message.
 * For a message we only take the message id; the service looks up the sender
 * and saves a snapshot of the text (messages vanish after 30 minutes).
 */
export const createReportSchema = z.object({
  body: z
    .union([
      z.object({ targetType: z.literal('user'), userId: objectIdSchema, ...reportBase }),
      z.object({ targetType: z.literal('message'), messageId: objectIdSchema, ...reportBase }),
    ])
    .refine((data) => data.reason !== 'other' || data.details.length >= 10, {
      path: ['details'],
      message: 'Please describe the problem (at least 10 characters) when the reason is "other"',
    }),
});

export const listMyReportsSchema = z.object({
  query: paginationQuerySchema,
});

export type CreateReportInput = z.infer<typeof createReportSchema>['body'];