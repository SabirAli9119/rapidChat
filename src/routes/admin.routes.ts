import { Router } from 'express';
import * as adminController from '../controllers/admin.controller';
import { authenticate, requireRole } from '../middlewares/auth.middleware';
import { validate } from '../middlewares/validation.middleware';
import {
  adminUserIdParamsSchema,
  listAuditLogsSchema,
  listReportsSchema,
  listSecurityEventsSchema,
  listUsersSchema,
  reportIdParamsSchema,
  securitySummarySchema,
  updateReportSchema,
  updateUserRoleSchema,
  updateUserStatusSchema,
} from '../validators/admin.validator';

const router = Router();

const adminOnly = requireRole('admin');
const staff = requireRole('admin', 'moderator');

// Everything here needs a login. The role is checked on each route, BEFORE validation.
router.use(authenticate);

// ----- users (administrators only) -----
router.get('/users', adminOnly, validate(listUsersSchema), adminController.listUsers);
router.get('/users/:userId', adminOnly, validate(adminUserIdParamsSchema), adminController.getUser);
router.patch(
  '/users/:userId/status',
  adminOnly,
  validate(updateUserStatusSchema),
  adminController.updateUserStatus,
);
router.patch(
  '/users/:userId/role',
  adminOnly,
  validate(updateUserRoleSchema),
  adminController.updateUserRole,
);
router.post(
  '/users/:userId/force-logout',
  adminOnly,
  validate(adminUserIdParamsSchema),
  adminController.forceLogout,
);

// ----- reports (moderators can handle these too) -----
router.get('/reports', staff, validate(listReportsSchema), adminController.listReports);
router.get('/reports/:reportId', staff, validate(reportIdParamsSchema), adminController.getReport);
router.patch('/reports/:reportId', staff, validate(updateReportSchema), adminController.updateReport);

// ----- audit log and security monitoring (administrators only) -----
router.get('/audit-logs', adminOnly, validate(listAuditLogsSchema), adminController.listAuditLogs);
router.get(
  '/security/events',
  adminOnly,
  validate(listSecurityEventsSchema),
  adminController.listSecurityEvents,
);
router.get(
  '/security/summary',
  adminOnly,
  validate(securitySummarySchema),
  adminController.getSecuritySummary,
);

export default router;