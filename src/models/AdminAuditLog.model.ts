import { Schema, model, type HydratedDocument, type Types } from 'mongoose';
import { AUDIT_ACTIONS, type AuditAction } from '../types';

export interface IAdminAuditLog {
  _id: Types.ObjectId;
  /** The admin who acted. null for events the system recorded itself (security.*) */
  actorId: Types.ObjectId | null;
  action: AuditAction;
  targetUserId: Types.ObjectId | null;
  targetReportId: Types.ObjectId | null;
  /** Extra details, e.g. { reason: "spam", previousRole: "user", newRole: "moderator" } */
  metadata: Record<string, unknown>;
  ipAddress: string | null;
  userAgent: string | null;
  createdAt: Date;
}

export type AdminAuditLogDocument = HydratedDocument<IAdminAuditLog>;

const adminAuditLogSchema = new Schema<IAdminAuditLog>(
  {
    actorId: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    action: { type: String, enum: [...AUDIT_ACTIONS], required: true },
    targetUserId: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    targetReportId: { type: Schema.Types.ObjectId, ref: 'Report', default: null },
    metadata: { type: Schema.Types.Mixed, default: {} },
    ipAddress: { type: String, default: null, maxlength: 64 },
    userAgent: { type: String, default: null, maxlength: 512 },
  },
  {
    timestamps: { createdAt: true, updatedAt: false },
    minimize: false,
  },
);

// ---- Append-only protection ----
const BLOCKED_OPERATIONS = [
  'updateOne',
  'updateMany',
  'findOneAndUpdate',
  'findOneAndReplace',
  'findOneAndDelete',
  'replaceOne',
  'deleteOne',
  'deleteMany',
] as const;

adminAuditLogSchema.pre([...BLOCKED_OPERATIONS], function () {
  throw new Error('Admin audit logs are append-only');
});

// Also stop "load a log, change it, save it again"
adminAuditLogSchema.pre('save', function () {
  if (!this.isNew) {
    throw new Error('Admin audit logs are append-only');
  }
});

adminAuditLogSchema.index({ createdAt: -1 });
adminAuditLogSchema.index({ action: 1, createdAt: -1 }); // security monitoring: "recent token reuse events"
adminAuditLogSchema.index({ actorId: 1, createdAt: -1 });
adminAuditLogSchema.index({ targetUserId: 1, createdAt: -1 });

export const AdminAuditLog = model<IAdminAuditLog>('AdminAuditLog', adminAuditLogSchema);