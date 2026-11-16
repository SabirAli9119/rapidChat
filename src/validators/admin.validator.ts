import { z } from 'zod';
import {
  AUDIT_ACTIONS,
  REPORT_STATUSES,
  REPORT_TARGET_TYPES,
  USER_ROLES,
  USER_STATUSES,
} from '../types';
import { objectIdSchema, paginationQuerySchema } from './common.validator';

// ---------- Users ----------

export const listUsersSchema = z.object({
  query: paginationQuerySchema.extend({
    search: z.string().trim().min(1).max(50).optional(),
    role: z.enum(USER_ROLES).optional(),
    status: z.enum(USER_STATUSES).optional(),
  }),
});

export const adminUserIdParamsSchema = z.object({
  params: z.object({ userId: objectIdSchema }),
});

export const updateUserStatusSchema = z.object({
  params: z.object({ userId: objectIdSchema }),
  body: z
    .object({
      status: z.enum(USER_STATUSES),
      reason: z.string().trim().min(3, 'Reason is too short').max(500).optional(),
    })
    .refine((data) => data.status === 'active' || data.reason !== undefined, {
      path: ['reason'],
      message: 'A reason is required when suspending or banning a user',
    }),
});

export const updateUserRoleSchema = z.object({
  params: z.object({ userId: objectIdSchema }),
  body: z.object({ role: z.enum(USER_ROLES) }),
});

// ---------- Reports ----------

export const listReportsSchema = z.object({
  query: paginationQuerySchema.extend({
    status: z.enum(REPORT_STATUSES).optional(),
    targetType: z.enum(REPORT_TARGET_TYPES).optional(),
  }),
});

export const reportIdParamsSchema = z.object({
  params: z.object({ reportId: objectIdSchema }),
});

export const updateReportSchema = z.object({
  params: z.object({ reportId: objectIdSchema }),
  body: z
    .object({
      status: z.enum(REPORT_STATUSES),
      resolutionNote: z.string().trim().max(1000).optional(),
    })
    .refine(
      (data) =>
        !['resolved', 'dismissed'].includes(data.status) ||
        (data.resolutionNote !== undefined && data.resolutionNote.length >= 3),
      {
        path: ['resolutionNote'],
        message: 'A note is required when resolving or dismissing a report',
      },
    ),
});

// ---------- Audit logs and security ----------

export const listAuditLogsSchema = z.object({
  query: paginationQuerySchema
    .extend({
      action: z.enum(AUDIT_ACTIONS).optional(),
      actorId: objectIdSchema.optional(),
      targetUserId: objectIdSchema.optional(),
      from: z.coerce.date().optional(),
      to: z.coerce.date().optional(),
    })
    .refine((data) => !data.from || !data.to || data.from <= data.to, {
      path: ['from'],
      message: '"from" must be earlier than "to"',
    }),
});

/** Recent security events (failed logins, token reuse...) from the last N hours. */
export const listSecurityEventsSchema = z.object({
  query: paginationQuerySchema.extend({
    hours: z.coerce.number().int().min(1).max(720).default(24),
  }),
});

/** GET /api/v1/admin/security/summary?hours=24 */
export const securitySummarySchema = z.object({
  query: z.object({
    hours: z.coerce.number().int().min(1).max(720).default(24),
  }),
});

export type ListUsersQuery = z.infer<typeof listUsersSchema>['query'];
export type UpdateUserStatusInput = z.infer<typeof updateUserStatusSchema>['body'];
export type UpdateUserRoleInput = z.infer<typeof updateUserRoleSchema>['body'];
export type ListReportsQuery = z.infer<typeof listReportsSchema>['query'];
export type UpdateReportInput = z.infer<typeof updateReportSchema>['body'];
export type ListAuditLogsQuery = z.infer<typeof listAuditLogsSchema>['query'];