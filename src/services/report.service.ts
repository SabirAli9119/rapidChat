import type { Types } from 'mongoose';
import { ChatRoom, buildParticipantKey } from '../models/ChatRoom.model';
import { Message, notExpiredFilter, type IMessage } from '../models/Message.model';
import { Report, type IReport } from '../models/Report.model';
import { User, type IUser } from '../models/User.model';
import type { PageResult, ReportReason, ReportStatus, ReportTargetType } from '../types';
import { ApiError } from '../utils/ApiError';
import { buildPageResult, isDuplicateKeyError, skipFor } from '../utils/db';
import type { CreateReportInput } from '../validators/report.validator';
import { areNearby } from './nearby.service';

/** Stops one account from flooding moderators. */
export const MAX_REPORTS_PER_DAY = 20;

/** The minimum needed to show "who" in a moderation screen. */
export interface PersonRef {
  id: string;
  username: string;
  displayName: string;
}

/** What the person who FILED a report may see about it (no reviewer, no moderator notes). */
export interface ReporterReportDTO {
  id: string;
  targetType: ReportTargetType;
  targetUser: PersonRef | null;
  reason: ReportReason;
  details: string;
  status: ReportStatus;
  createdAt: string;
  updatedAt: string;
}

/** Looks up several users at once (includes banned or deleted accounts, which moderators still need to see). */
export async function loadPersonRefs(
  ids: (Types.ObjectId | string | null | undefined)[],
): Promise<Map<string, PersonRef>> {
  const unique = [
    ...new Set(
      ids.filter((id): id is Types.ObjectId | string => id !== null && id !== undefined).map(String),
    ),
  ];
  if (unique.length === 0) return new Map();

  const users = await User.find({ _id: { $in: unique } })
    .select('username displayName')
    .lean<Pick<IUser, '_id' | 'username' | 'displayName'>[]>();

  return new Map(
    users.map((user) => [
      String(user._id),
      { id: String(user._id), username: user.username, displayName: user.displayName },
    ]),
  );
}

async function toReporterDTOs(reports: IReport[]): Promise<ReporterReportDTO[]> {
  const people = await loadPersonRefs(reports.map((report) => report.targetUserId));
  return reports.map((report) => ({
    id: String(report._id),
    targetType: report.targetType,
    targetUser: people.get(String(report.targetUserId)) ?? null,
    reason: report.reason,
    details: report.details,
    status: report.status,
    createdAt: report.createdAt.toISOString(),
    updatedAt: report.updatedAt.toISOString(),
  }));
}

/**
 * Files a report about a user or a message. Abuse protections:
 *  - at most MAX_REPORTS_PER_DAY per account
 *  - a user can only be reported by someone who shares a chat with them or is nearby
 *  - a message can only be reported by a member of its room (blocking does NOT stop you: block, then report)
 *  - you cannot report yourself or your own messages
 *  - the same open report cannot be filed twice (enforced by a unique index)
 * For a message report, the text is COPIED into the report, because the message itself disappears
 * after 30 minutes.
 */
export async function createReport(reporterId: string, input: CreateReportInput): Promise<ReporterReportDTO> {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const recent = await Report.countDocuments({ reporterId, createdAt: { $gte: since } });
  if (recent >= MAX_REPORTS_PER_DAY) {
    throw ApiError.tooManyRequests('You have reached the daily limit for reports. Please try again tomorrow.', {
      code: 'REPORT_LIMIT',
    });
  }

  let fields: Pick<IReport, 'targetType' | 'targetUserId' | 'targetMessageId' | 'messageSnapshot'>;

  if (input.targetType === 'user') {
    if (input.userId === reporterId) {
      throw ApiError.badRequest('You cannot report yourself', { code: 'REPORT_SELF' });
    }

    const target = await User.exists({ _id: input.userId, deletedAt: null });
    let related = false;
    if (target) {
      related =
        (await ChatRoom.exists({ participantKey: buildParticipantKey(reporterId, input.userId) })) !== null ||
        (await areNearby(reporterId, input.userId));
    }
    // One answer for "does not exist" and "not connected to you", so ids reveal nothing
    if (!target || !related) throw ApiError.notFound('User not found');

    fields = {
      targetType: 'user',
      targetUserId: input.userId as unknown as Types.ObjectId,
      targetMessageId: null,
      messageSnapshot: null,
    };
  } else {
    const message = await Message.findOne({ _id: input.messageId, ...notExpiredFilter() }).lean<IMessage>();
    const inRoom = message
      ? await ChatRoom.exists({ _id: message.roomId, participants: reporterId })
      : null;
    if (!message || !inRoom) throw ApiError.notFound('Message not found');

    if (String(message.senderId) === reporterId) {
      throw ApiError.badRequest('You cannot report your own message', { code: 'REPORT_SELF' });
    }

    fields = {
      targetType: 'message',
      targetUserId: message.senderId,
      targetMessageId: message._id,
      messageSnapshot: { content: message.content, type: message.type, sentAt: message.createdAt },
    };
  }

  try {
    const doc = await Report.create({
      reporterId,
      ...fields,
      reason: input.reason,
      details: input.details,
    });
    const [dto] = await toReporterDTOs([doc.toObject() as IReport]);
    return dto;
  } catch (err) {
    if (isDuplicateKeyError(err)) {
      throw ApiError.conflict('You have already reported this and it is still being reviewed', {
        code: 'ALREADY_REPORTED',
      });
    }
    throw err;
  }
}

export async function listMyReports(
  reporterId: string,
  options: { page: number; limit: number },
): Promise<PageResult<ReporterReportDTO>> {
  const { page, limit } = options;

  const [reports, total] = await Promise.all([
    Report.find({ reporterId })
      .sort({ createdAt: -1, _id: -1 })
      .skip(skipFor(page, limit))
      .limit(limit)
      .lean<IReport[]>(),
    Report.countDocuments({ reporterId }),
  ]);

  return buildPageResult(await toReporterDTOs(reports), total, page, limit);
}