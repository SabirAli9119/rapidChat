import { AdminAuditLog } from '../models/AdminAuditLog.model';
import type { AuditAction } from '../types';
import { logger } from '../utils/logger';

export interface AuditEntry {
  /** The admin who acted. Leave out for events the system records itself (security.*) */
  actorId?: string | null;
  action: AuditAction;
  targetUserId?: string | null;
  targetReportId?: string | null;
  metadata?: Record<string, unknown>;
  ipAddress?: string | null;
  userAgent?: string | null;
}

/** Writes an audit entry. Throws on failure, so use it where the log is part of the action. */
export async function recordAudit(entry: AuditEntry): Promise<void> {
  await AdminAuditLog.create({
    actorId: entry.actorId ?? null,
    action: entry.action,
    targetUserId: entry.targetUserId ?? null,
    targetReportId: entry.targetReportId ?? null,
    metadata: entry.metadata ?? {},
    ipAddress: entry.ipAddress ?? null,
    userAgent: entry.userAgent ? entry.userAgent.slice(0, 512) : null,
  });
}

/** Same, but NEVER throws. A failing log must not break a login or a refresh. */
export async function recordSecurityEvent(entry: AuditEntry): Promise<void> {
  try {
    await recordAudit(entry);
  } catch (err) {
    logger.error({ err, action: entry.action }, 'Could not write security audit entry');
  }
}