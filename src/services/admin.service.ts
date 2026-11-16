import { AdminAuditLog, type IAdminAuditLog } from '../models/AdminAuditLog.model';
import { Location } from '../models/Location.model';
import { Report, type IReport } from '../models/Report.model';
import { Session } from '../models/Session.model';
import { User, type IUser } from '../models/User.model';
import { getAvatarUrl } from '../providers/storage.provider';
import {
  AUDIT_ACTIONS,
  type AuditAction,
  type MessageType,
  type PageResult,
  type ReportReason,
  type ReportStatus,
  type ReportTargetType,
  type UserRole,
  type UserStatus,
} from '../types';
import { ApiError } from '../utils/ApiError';
import { buildPageResult, escapeRegex, skipFor } from '../utils/db';
import { logger } from '../utils/logger';
import type {
  ListAuditLogsQuery,
  ListReportsQuery,
  ListUsersQuery,
  UpdateReportInput,
  UpdateUserRoleInput,
  UpdateUserStatusInput,
} from '../validators/admin.validator';
import { recordAudit } from './audit.service';
import { revokeAllUserSessions } from './auth.service';
import { createNotification } from './notification.service';
import { loadPersonRefs, type PersonRef } from './report.service';

// ---------- Who is acting ----------

/** Built by the controller from req.user and the request. Also used for the audit log. */
export interface AdminActor {
  id: string;
  role: UserRole;
  ipAddress: string | null;
  userAgent: string | null;
}

const HOUR_MS = 60 * 60 * 1000;

/**
 * The routes already restrict access by role. These checks repeat it inside the service
 * (defence in depth), so a mistake in a route can never expose an admin function.
 */
function assertAdmin(actor: AdminActor): void {
  if (actor.role !== 'admin') {
    throw ApiError.forbidden('Only administrators can do this', { code: 'INSUFFICIENT_ROLE' });
  }
}

function assertStaff(actor: AdminActor): void {
  if (actor.role !== 'admin' && actor.role !== 'moderator') {
    throw ApiError.forbidden('Only moderators and administrators can do this', { code: 'INSUFFICIENT_ROLE' });
  }
}

const auditContext = (actor: AdminActor) => ({
  actorId: actor.id,
  ipAddress: actor.ipAddress,
  userAgent: actor.userAgent,
});

// ---------- Users ----------

export interface AdminUserDTO {
  id: string;
  username: string;
  email: string;
  displayName: string;
  avatarUrl: string | null;
  role: UserRole;
  status: UserStatus;
  statusReason: string | null;
  emailVerified: boolean;
  isOnline: boolean;
  lastSeenAt: string | null;
  lastLoginAt: string | null;
  createdAt: string;
}

export interface AdminUserDetailDTO extends AdminUserDTO {
  openReportsAgainst: number;
  totalReportsAgainst: number;
  activeSessions: number;
  failedLoginAttempts: number;
  lockedUntil: string | null;
}

const USER_FIELDS =
  'username email displayName avatarPublicId role status statusReason emailVerified isOnline lastSeenAt lastLoginAt createdAt deletedAt failedLoginAttempts lockUntil';

function toAdminUserDTO(user: IUser): AdminUserDTO {
  return {
    id: String(user._id),
    username: user.username,
    email: user.email,
    displayName: user.displayName,
    avatarUrl: getAvatarUrl(user.avatarPublicId),
    role: user.role,
    status: user.status,
    statusReason: user.statusReason,
    emailVerified: user.emailVerified,
    isOnline: user.isOnline,
    lastSeenAt: user.lastSeenAt ? user.lastSeenAt.toISOString() : null,
    lastLoginAt: user.lastLoginAt ? user.lastLoginAt.toISOString() : null,
    createdAt: user.createdAt.toISOString(),
  };
}

async function loadUser(userId: string): Promise<IUser> {
  const user = await User.findOne({ _id: userId, deletedAt: null }).select(USER_FIELDS).lean<IUser>();
  if (!user) throw ApiError.notFound('User not found', { code: 'USER_NOT_FOUND' });
  return user;
}

export async function listUsers(actor: AdminActor, query: ListUsersQuery): Promise<PageResult<AdminUserDTO>> {
  assertAdmin(actor);
  const { page, limit, search, role, status } = query;

  // The search text is escaped, so characters like ".*" are matched literally, never as a pattern
  const regex = search ? new RegExp(escapeRegex(search), 'i') : null;
  const filter = {
    deletedAt: null,
    ...(role ? { role } : {}),
    ...(status ? { status } : {}),
    ...(regex ? { $or: [{ username: regex }, { email: regex }, { displayName: regex }] } : {}),
  };

  const [users, total] = await Promise.all([
    User.find(filter)
      .sort({ createdAt: -1, _id: -1 })
      .skip(skipFor(page, limit))
      .limit(limit)
      .select(USER_FIELDS)
      .lean<IUser[]>(),
    User.countDocuments(filter),
  ]);

  return buildPageResult(users.map(toAdminUserDTO), total, page, limit);
}

export async function getUser(actor: AdminActor, userId: string): Promise<AdminUserDetailDTO> {
  assertAdmin(actor);
  const user = await loadUser(userId);

  const [openReportsAgainst, totalReportsAgainst, activeSessions] = await Promise.all([
    Report.countDocuments({ targetUserId: userId, status: { $in: ['open', 'under_review'] } }),
    Report.countDocuments({ targetUserId: userId }),
    Session.countDocuments({ userId, revokedAt: null, expiresAt: { $gt: new Date() } }),
  ]);

  return {
    ...toAdminUserDTO(user),
    openReportsAgainst,
    totalReportsAgainst,
    activeSessions,
    failedLoginAttempts: user.failedLoginAttempts,
    lockedUntil: user.lockUntil ? user.lockUntil.toISOString() : null,
  };
}

function statusAction(previous: UserStatus, next: UserStatus): AuditAction {
  if (next === 'banned') return 'user.ban';
  if (next === 'suspended') return 'user.suspend';
  return previous === 'banned' ? 'user.unban' : 'user.unsuspend';
}

/**
 * Suspends, bans, or restores an account. Suspending or banning also ends every session
 * and removes the stored location, so the person disappears immediately.
 *
 * The audit entry is written BEFORE the change. A log line for an action that then failed is
 * better than an action with no log line (the database cannot do transactions on a single server).
 */
export async function setUserStatus(
  actor: AdminActor,
  userId: string,
  input: UpdateUserStatusInput,
): Promise<AdminUserDTO> {
  assertAdmin(actor);
  if (actor.id === userId) {
    throw ApiError.badRequest('You cannot change your own status', { code: 'CANNOT_MODIFY_SELF' });
  }

  const user = await loadUser(userId);
  if (user.role === 'admin') {
    throw ApiError.forbidden('An administrator must be demoted before their status can be changed', {
      code: 'TARGET_IS_ADMIN',
    });
  }
  if (user.status === input.status) {
    throw ApiError.conflict(`This user is already ${input.status}`, { code: 'STATUS_UNCHANGED' });
  }

  await recordAudit({
    ...auditContext(actor),
    action: statusAction(user.status, input.status),
    targetUserId: userId,
    metadata: { previousStatus: user.status, newStatus: input.status, reason: input.reason ?? null },
  });

  // The "status: user.status" condition makes this fail cleanly if another admin changed the user meanwhile
  const updated = await User.findOneAndUpdate(
    { _id: userId, deletedAt: null, status: user.status },
    {
      $set: {
        status: input.status,
        statusReason: input.status === 'active' ? null : (input.reason ?? null),
      },
    },
    { new: true },
  )
    .select(USER_FIELDS)
    .lean<IUser>();
  if (!updated) {
    throw ApiError.conflict('This user was changed by someone else. Reload and try again.', {
      code: 'CONCURRENT_UPDATE',
    });
  }

  if (input.status !== 'active') {
    await revokeAllUserSessions(userId, { reason: input.status === 'banned' ? 'banned' : 'suspended' });
    await Location.deleteOne({ userId });
  }

  return toAdminUserDTO(updated);
}

/**
 * Changes a role. The new role takes effect on the user's very next request, because the auth
 * middleware reads the role from the database each time. Admins cannot change their own role,
 * so the last administrator can never remove themselves.
 */
export async function setUserRole(
  actor: AdminActor,
  userId: string,
  input: UpdateUserRoleInput,
): Promise<AdminUserDTO> {
  assertAdmin(actor);
  if (actor.id === userId) {
    throw ApiError.badRequest('You cannot change your own role', { code: 'CANNOT_MODIFY_SELF' });
  }

  const user = await loadUser(userId);
  if (user.role === input.role) {
    throw ApiError.conflict('This user already has that role', { code: 'ROLE_UNCHANGED' });
  }
  if (input.role !== 'user' && (!user.emailVerified || user.status !== 'active')) {
    throw ApiError.badRequest('Only active users with a verified email can be given a staff role', {
      code: 'USER_NOT_ELIGIBLE',
    });
  }

  await recordAudit({
    ...auditContext(actor),
    action: 'user.role_change',
    targetUserId: userId,
    metadata: { previousRole: user.role, newRole: input.role },
  });

  const updated = await User.findOneAndUpdate(
    { _id: userId, deletedAt: null, role: user.role },
    { $set: { role: input.role } },
    { new: true },
  )
    .select(USER_FIELDS)
    .lean<IUser>();
  if (!updated) {
    throw ApiError.conflict('This user was changed by someone else. Reload and try again.', {
      code: 'CONCURRENT_UPDATE',
    });
  }
  return toAdminUserDTO(updated);
}

/** Signs a user out of every device without changing their status. */
export async function forceLogoutUser(actor: AdminActor, userId: string): Promise<{ sessionsRevoked: number }> {
  assertAdmin(actor);
  if (actor.id === userId) {
    throw ApiError.badRequest('Use the normal logout for your own account', { code: 'CANNOT_MODIFY_SELF' });
  }
  await loadUser(userId);

  const active = await Session.countDocuments({ userId, revokedAt: null });
  await recordAudit({
    ...auditContext(actor),
    action: 'user.force_logout',
    targetUserId: userId,
    metadata: { sessionsRevoked: active },
  });

  const sessionsRevoked = await revokeAllUserSessions(userId, { reason: 'admin_force_logout' });
  return { sessionsRevoked };
}

// ---------- Reports ----------

export interface AdminReportDTO {
  id: string;
  targetType: ReportTargetType;
  reason: ReportReason;
  details: string;
  status: ReportStatus;
  reporter: PersonRef | null;
  targetUser: PersonRef | null;
  /** A copy of the reported message (the original is deleted 30 minutes after it was sent) */
  messageSnapshot: { content: string | null; type: MessageType; sentAt: string } | null;
  reviewedBy: PersonRef | null;
  reviewedAt: string | null;
  resolutionNote: string | null;
  createdAt: string;
  updatedAt: string;
}

async function toAdminReportDTOs(reports: IReport[]): Promise<AdminReportDTO[]> {
  const people = await loadPersonRefs(
    reports.flatMap((report) => [report.reporterId, report.targetUserId, report.reviewedBy]),
  );
  const person = (id: unknown): PersonRef | null => (id ? (people.get(String(id)) ?? null) : null);

  return reports.map((report) => ({
    id: String(report._id),
    targetType: report.targetType,
    reason: report.reason,
    details: report.details,
    status: report.status,
    reporter: person(report.reporterId),
    targetUser: person(report.targetUserId),
    messageSnapshot: report.messageSnapshot
      ? {
          content: report.messageSnapshot.content,
          type: report.messageSnapshot.type,
          sentAt: report.messageSnapshot.sentAt.toISOString(),
        }
      : null,
    reviewedBy: person(report.reviewedBy),
    reviewedAt: report.reviewedAt ? report.reviewedAt.toISOString() : null,
    resolutionNote: report.resolutionNote,
    createdAt: report.createdAt.toISOString(),
    updatedAt: report.updatedAt.toISOString(),
  }));
}

export async function listReports(
  actor: AdminActor,
  query: ListReportsQuery,
): Promise<PageResult<AdminReportDTO>> {
  assertStaff(actor);
  const { page, limit, status, targetType } = query;
  const filter = { ...(status ? { status } : {}), ...(targetType ? { targetType } : {}) };

  const [reports, total] = await Promise.all([
    Report.find(filter)
      .sort({ createdAt: -1, _id: -1 })
      .skip(skipFor(page, limit))
      .limit(limit)
      .lean<IReport[]>(),
    Report.countDocuments(filter),
  ]);

  return buildPageResult(await toAdminReportDTOs(reports), total, page, limit);
}

async function loadReport(reportId: string): Promise<IReport> {
  const report = await Report.findById(reportId).lean<IReport>();
  if (!report) throw ApiError.notFound('Report not found', { code: 'REPORT_NOT_FOUND' });
  return report;
}

export async function getReport(actor: AdminActor, reportId: string): Promise<AdminReportDTO> {
  assertStaff(actor);
  const [dto] = await toAdminReportDTOs([await loadReport(reportId)]);
  return dto;
}

/** Resolved and dismissed are final. Open and under_review can move to any other status. */
const REPORT_TRANSITIONS: Record<ReportStatus, ReportStatus[]> = {
  open: ['under_review', 'resolved', 'dismissed'],
  under_review: ['open', 'resolved', 'dismissed'],
  resolved: [],
  dismissed: [],
};

function reportAction(status: ReportStatus): AuditAction {
  if (status === 'resolved') return 'report.resolve';
  if (status === 'dismissed') return 'report.dismiss';
  return 'report.update_status';
}

export async function updateReport(
  actor: AdminActor,
  reportId: string,
  input: UpdateReportInput,
): Promise<AdminReportDTO> {
  assertStaff(actor);
  const report = await loadReport(reportId);

  // You cannot judge a report you filed, or one about yourself
  if (actor.id === String(report.reporterId) || actor.id === String(report.targetUserId)) {
    throw ApiError.forbidden('You cannot review a report that involves you', { code: 'CONFLICT_OF_INTEREST' });
  }

  if (!REPORT_TRANSITIONS[report.status].includes(input.status)) {
    if (REPORT_TRANSITIONS[report.status].length === 0) {
      throw ApiError.conflict('This report is closed and can no longer be changed', { code: 'REPORT_CLOSED' });
    }
    throw ApiError.conflict(`This report is already ${input.status}`, { code: 'STATUS_UNCHANGED' });
  }

  await recordAudit({
    ...auditContext(actor),
    action: reportAction(input.status),
    targetUserId: String(report.targetUserId),
    targetReportId: reportId,
    metadata: {
      previousStatus: report.status,
      newStatus: input.status,
      resolutionNote: input.resolutionNote ?? null,
    },
  });

  const updated = await Report.findOneAndUpdate(
    { _id: reportId, status: report.status },
    {
      $set: {
        status: input.status,
        reviewedBy: actor.id,
        reviewedAt: new Date(),
        ...(input.resolutionNote !== undefined ? { resolutionNote: input.resolutionNote } : {}),
      },
    },
    { new: true },
  ).lean<IReport>();
  if (!updated) {
    throw ApiError.conflict('This report was changed by someone else. Reload and try again.', {
      code: 'CONCURRENT_UPDATE',
    });
  }

  // Tell the reporter once a decision is made (generic wording, best effort)
  if (input.status === 'resolved' || input.status === 'dismissed') {
    try {
      await createNotification({
        userId: String(report.reporterId),
        type: 'report_update',
        title: 'Your report was reviewed',
        body:
          input.status === 'resolved'
            ? 'Thank you for your report. We reviewed it and took the steps needed.'
            : 'We reviewed your report and closed it without further action.',
        data: { reportId },
      });
    } catch (err) {
      logger.error({ err }, 'Could not notify the reporter');
    }
  }

  const [dto] = await toAdminReportDTOs([updated]);
  return dto;
}

// ---------- Audit logs ----------

export interface AuditLogDTO {
  id: string;
  action: AuditAction;
  actor: PersonRef | null;
  targetUser: PersonRef | null;
  targetReportId: string | null;
  metadata: Record<string, unknown>;
  ipAddress: string | null;
  userAgent: string | null;
  createdAt: string;
}

async function toAuditLogDTOs(logs: IAdminAuditLog[]): Promise<AuditLogDTO[]> {
  const people = await loadPersonRefs(logs.flatMap((log) => [log.actorId, log.targetUserId]));
  const person = (id: unknown): PersonRef | null => (id ? (people.get(String(id)) ?? null) : null);

  return logs.map((log) => ({
    id: String(log._id),
    action: log.action,
    actor: person(log.actorId),
    targetUser: person(log.targetUserId),
    targetReportId: log.targetReportId ? String(log.targetReportId) : null,
    metadata: log.metadata ?? {},
    ipAddress: log.ipAddress,
    userAgent: log.userAgent,
    createdAt: log.createdAt.toISOString(),
  }));
}

export async function listAuditLogs(
  actor: AdminActor,
  query: ListAuditLogsQuery,
): Promise<PageResult<AuditLogDTO>> {
  assertAdmin(actor);
  const { page, limit, action, actorId, targetUserId, from, to } = query;

  const filter = {
    ...(action ? { action } : {}),
    ...(actorId ? { actorId } : {}),
    ...(targetUserId ? { targetUserId } : {}),
    ...(from || to
      ? { createdAt: { ...(from ? { $gte: from } : {}), ...(to ? { $lte: to } : {}) } }
      : {}),
  };

  const [logs, total] = await Promise.all([
    AdminAuditLog.find(filter)
      .sort({ createdAt: -1, _id: -1 })
      .skip(skipFor(page, limit))
      .limit(limit)
      .lean<IAdminAuditLog[]>(),
    AdminAuditLog.countDocuments(filter),
  ]);

  return buildPageResult(await toAuditLogDTOs(logs), total, page, limit);
}

// ---------- Security monitoring ----------

export const SECURITY_ACTIONS: AuditAction[] = AUDIT_ACTIONS.filter((action) => action.startsWith('security.'));

export interface SecuritySummary {
  windowHours: number;
  /** How many times each kind of security event happened inside the window */
  events: Record<string, number>;
  /** The addresses with the most failed logins in the window */
  failedLoginsByIp: { ipAddress: string; count: number }[];
  lockedAccounts: number;
  suspendedUsers: number;
  bannedUsers: number;
  openReports: number;
}

export async function listSecurityEvents(
  actor: AdminActor,
  query: { page: number; limit: number; hours: number },
): Promise<PageResult<AuditLogDTO>> {
  assertAdmin(actor);
  const { page, limit, hours } = query;
  const filter = {
    action: { $in: SECURITY_ACTIONS },
    createdAt: { $gte: new Date(Date.now() - hours * HOUR_MS) },
  };

  const [logs, total] = await Promise.all([
    AdminAuditLog.find(filter)
      .sort({ createdAt: -1, _id: -1 })
      .skip(skipFor(page, limit))
      .limit(limit)
      .lean<IAdminAuditLog[]>(),
    AdminAuditLog.countDocuments(filter),
  ]);

  return buildPageResult(await toAuditLogDTOs(logs), total, page, limit);
}

export async function getSecuritySummary(actor: AdminActor, hours: number): Promise<SecuritySummary> {
  assertAdmin(actor);
  const since = new Date(Date.now() - hours * HOUR_MS);

  const [byAction, byIp, lockedAccounts, suspendedUsers, bannedUsers, openReports] = await Promise.all([
    AdminAuditLog.aggregate<{ _id: AuditAction; count: number }>([
      { $match: { action: { $in: SECURITY_ACTIONS }, createdAt: { $gte: since } } },
      { $group: { _id: '$action', count: { $sum: 1 } } },
    ]),
    AdminAuditLog.aggregate<{ _id: string; count: number }>([
      { $match: { action: 'security.login_failed', createdAt: { $gte: since }, ipAddress: { $ne: null } } },
      { $group: { _id: '$ipAddress', count: { $sum: 1 } } },
      { $sort: { count: -1, _id: 1 } },
      { $limit: 5 },
    ]),
    User.countDocuments({ lockUntil: { $gt: new Date() }, deletedAt: null }),
    User.countDocuments({ status: 'suspended', deletedAt: null }),
    User.countDocuments({ status: 'banned', deletedAt: null }),
    Report.countDocuments({ status: { $in: ['open', 'under_review'] } }),
  ]);

  const events: Record<string, number> = {};
  for (const action of SECURITY_ACTIONS) events[action] = 0;
  for (const row of byAction) events[row._id] = row.count;

  return {
    windowHours: hours,
    events,
    failedLoginsByIp: byIp.map((row) => ({ ipAddress: row._id, count: row.count })),
    lockedAccounts,
    suspendedUsers,
    bannedUsers,
    openReports,
  };
}