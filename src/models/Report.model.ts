import { Schema, model, type HydratedDocument, type Types } from 'mongoose';
import {
  MESSAGE_TYPES,
  REPORT_REASONS,
  REPORT_STATUSES,
  REPORT_TARGET_TYPES,
  type MessageType,
  type ReportReason,
  type ReportStatus,
  type ReportTargetType,
} from '../types';

/**
 * Copy of the reported message, taken at the moment of reporting.
 * Needed because the original message is deleted 30 minutes after it was sent,
 * and moderators must still be able to review what was reported.
 */
export interface IMessageSnapshot {
  content: string | null;
  type: MessageType;
  sentAt: Date;
}

export interface IReport {
  _id: Types.ObjectId;
  reporterId: Types.ObjectId;
  targetType: ReportTargetType;
  /** The person being reported (always set, also for message reports) */
  targetUserId: Types.ObjectId;
  targetMessageId: Types.ObjectId | null;
  messageSnapshot: IMessageSnapshot | null;
  reason: ReportReason;
  details: string;
  status: ReportStatus;
  reviewedBy: Types.ObjectId | null;
  reviewedAt: Date | null;
  resolutionNote: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export type ReportDocument = HydratedDocument<IReport>;

const messageSnapshotSchema = new Schema<IMessageSnapshot>(
  {
    content: { type: String, default: null, maxlength: 2000 },
    type: { type: String, enum: [...MESSAGE_TYPES], required: true },
    sentAt: { type: Date, required: true },
  },
  { _id: false },
);

const reportSchema = new Schema<IReport>(
  {
    reporterId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    targetType: { type: String, enum: [...REPORT_TARGET_TYPES], required: true },
    targetUserId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    targetMessageId: { type: Schema.Types.ObjectId, ref: 'Message', default: null },
    messageSnapshot: { type: messageSnapshotSchema, default: null },
    reason: { type: String, enum: [...REPORT_REASONS], required: true },
    details: { type: String, default: '', trim: true, maxlength: 1000 },
    status: { type: String, enum: [...REPORT_STATUSES], default: 'open' },
    reviewedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    reviewedAt: { type: Date, default: null },
    resolutionNote: { type: String, default: null, trim: true, maxlength: 1000 },
  },
  { timestamps: true },
);

reportSchema.pre('validate', function () {
  if (this.reporterId && this.targetUserId && this.reporterId.equals(this.targetUserId)) {
    throw new Error('You cannot report yourself');
  }
  if (this.targetType === 'message' && (!this.targetMessageId || !this.messageSnapshot)) {
    throw new Error('Message reports need a targetMessageId and a message snapshot');
  }
  if (this.targetType === 'user' && this.targetMessageId) {
    throw new Error('User reports cannot reference a message');
  }
});

// Admin lists: filter by status, newest first
reportSchema.index({ status: 1, createdAt: -1 });
reportSchema.index({ targetUserId: 1, createdAt: -1 }); // "all reports about this user"
reportSchema.index({ reporterId: 1, createdAt: -1 });

// Stops report spam: while a report is still "open", the same person cannot file
// the same report again. The service turns the duplicate-key error into a 409.
reportSchema.index(
  { reporterId: 1, targetType: 1, targetUserId: 1, targetMessageId: 1 },
  { unique: true, partialFilterExpression: { status: 'open' } },
);

export const Report = model<IReport>('Report', reportSchema);