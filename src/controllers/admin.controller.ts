import type { Request, Response } from 'express';
import type { z } from 'zod';
import { requireUser } from '../middlewares/auth.middleware';
import * as adminService from '../services/admin.service';
import type { AdminActor } from '../services/admin.service';
import { ApiResponse } from '../utils/ApiResponse';
import { asyncHandler } from '../utils/asyncHandler';
import { getRequestContext } from '../utils/request';
import type {
  ListAuditLogsQuery,
  ListReportsQuery,
  ListUsersQuery,
  UpdateReportInput,
  UpdateUserRoleInput,
  UpdateUserStatusInput,
  listSecurityEventsSchema,
  securitySummarySchema,
} from '../validators/admin.validator';

type SecurityEventsQuery = z.infer<typeof listSecurityEventsSchema>['query'];
type SecuritySummaryQuery = z.infer<typeof securitySummarySchema>['query'];

/**
 * Who is acting, plus where from. The service writes this into the audit log.
 * The role comes from req.user, which the auth middleware read from the database on this very request.
 */
function actorFrom(req: Request): AdminActor {
  const me = requireUser(req);
  return { id: me.id, role: me.role, ...getRequestContext(req) };
}

// ---------- Users ----------

export const listUsers = asyncHandler(async (req: Request, res: Response) => {
  const { items, ...meta } = await adminService.listUsers(actorFrom(req), req.query as unknown as ListUsersQuery);
  ApiResponse.ok(res, items, 'Users', meta);
});

export const getUser = asyncHandler(async (req: Request, res: Response) => {
  const user = await adminService.getUser(actorFrom(req), req.params.userId);
  ApiResponse.ok(res, { user }, 'User details');
});

export const updateUserStatus = asyncHandler(async (req: Request, res: Response) => {
  const user = await adminService.setUserStatus(actorFrom(req), req.params.userId, req.body as UpdateUserStatusInput);
  ApiResponse.ok(res, { user }, 'User status updated');
});

export const updateUserRole = asyncHandler(async (req: Request, res: Response) => {
  const user = await adminService.setUserRole(actorFrom(req), req.params.userId, req.body as UpdateUserRoleInput);
  ApiResponse.ok(res, { user }, 'User role updated');
});

export const forceLogout = asyncHandler(async (req: Request, res: Response) => {
  const result = await adminService.forceLogoutUser(actorFrom(req), req.params.userId);
  ApiResponse.ok(res, result, 'User logged out of all devices');
});

// ---------- Reports ----------

export const listReports = asyncHandler(async (req: Request, res: Response) => {
  const { items, ...meta } = await adminService.listReports(actorFrom(req), req.query as unknown as ListReportsQuery);
  ApiResponse.ok(res, items, 'Reports', meta);
});

export const getReport = asyncHandler(async (req: Request, res: Response) => {
  const report = await adminService.getReport(actorFrom(req), req.params.reportId);
  ApiResponse.ok(res, { report }, 'Report details');
});

export const updateReport = asyncHandler(async (req: Request, res: Response) => {
  const report = await adminService.updateReport(actorFrom(req), req.params.reportId, req.body as UpdateReportInput);
  ApiResponse.ok(res, { report }, 'Report updated');
});

// ---------- Audit log and security ----------

export const listAuditLogs = asyncHandler(async (req: Request, res: Response) => {
  const { items, ...meta } = await adminService.listAuditLogs(
    actorFrom(req),
    req.query as unknown as ListAuditLogsQuery,
  );
  ApiResponse.ok(res, items, 'Audit log', meta);
});

export const listSecurityEvents = asyncHandler(async (req: Request, res: Response) => {
  const { items, ...meta } = await adminService.listSecurityEvents(
    actorFrom(req),
    req.query as unknown as SecurityEventsQuery,
  );
  ApiResponse.ok(res, items, 'Security events', meta);
});

export const getSecuritySummary = asyncHandler(async (req: Request, res: Response) => {
  const { hours } = req.query as unknown as SecuritySummaryQuery;
  const summary = await adminService.getSecuritySummary(actorFrom(req), hours);
  ApiResponse.ok(res, { summary }, 'Security summary');
});