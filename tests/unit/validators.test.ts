import { describe, expect, it } from 'vitest';
import type { ZodType } from 'zod';
import {
  adminUserIdParamsSchema,
  listAuditLogsSchema,
  listUsersSchema,
  updateReportSchema,
  updateUserRoleSchema,
  updateUserStatusSchema,
} from '../../src/validators/admin.validator';
import {
  changePasswordSchema,
  forgotPasswordSchema,
  loginSchema,
  registerSchema,
  resetPasswordSchema,
  sessionIdParamsSchema,
  verifyEmailSchema,
} from '../../src/validators/auth.validator';
import { blockParamsSchema } from '../../src/validators/block.validator';
import { createRoomSchema } from '../../src/validators/chat.validator';
import { cursorQuerySchema, objectIdSchema, paginationQuerySchema } from '../../src/validators/common.validator';
import { mediaFileSchema, uploadMediaSchema } from '../../src/validators/media.validator';
import { listMessagesSchema, roomPayloadSchema, sendMessagePayloadSchema } from '../../src/validators/message.validator';
import { searchNearbySchema, updateLocationSchema } from '../../src/validators/nearby.validator';
import { listNotificationsSchema } from '../../src/validators/notification.validator';
import { createReportSchema } from '../../src/validators/report.validator';
import { deleteAccountSchema, updatePrivacySchema, updateProfileSchema } from '../../src/validators/user.validator';

const ID = '507f1f77bcf86cd799439011';
const TOKEN = 'a'.repeat(64);
const PASSWORD = 'Sup3rSecret99';

interface Outcome {
  ok: boolean;
  data: unknown;
  fields: string[];
}

function run(schema: ZodType, input: unknown): Outcome {
  const result = schema.safeParse(input);
  if (result.success) return { ok: true, data: result.data, fields: [] };
  return { ok: false, data: undefined, fields: [...new Set(result.error.issues.map((i) => i.path.join('.')))] };
}

const validRegister = { username: 'sabir_01', email: 'sabir@example.com', password: PASSWORD, displayName: 'Sabir' };

describe('registration', () => {
  it('cleans the input and drops fields it does not know', () => {
    const result = run(registerSchema, {
      body: { username: ' Sabir_01 ', email: ' Sabir@Example.COM ', password: PASSWORD, displayName: ' Sabir ', role: 'admin' },
    });
    expect(result.ok).toBe(true);
    expect((result.data as { body: unknown }).body).toEqual({
      username: 'sabir_01',
      email: 'sabir@example.com',
      password: PASSWORD,
      displayName: 'Sabir',
    });
  });

  it.each([
    ['a short password', { password: 'short1' }, 'body.password'],
    ['a password without a number', { password: 'OnlyLettersHere' }, 'body.password'],
    ['a password without a letter', { password: '12345678901234' }, 'body.password'],
    ['a password over 128 characters', { password: `A1${'x'.repeat(130)}` }, 'body.password'],
    ['a password containing the username', { username: 'sabir', password: 'Sabir12345' }, 'body.password'],
    ['a username with spaces or symbols', { username: 'bad name!' }, 'body.username'],
    ['a username that is too short', { username: 'ab' }, 'body.username'],
    ['a username that is too long', { username: 'a'.repeat(31) }, 'body.username'],
    ['a reserved username', { username: 'Admin' }, 'body.username'],
    ['another reserved username', { username: 'support' }, 'body.username'],
    ['an invalid email', { email: 'nope' }, 'body.email'],
    ['an empty display name', { displayName: '   ' }, 'body.displayName'],
    ['a display name over 50 characters', { displayName: 'x'.repeat(51) }, 'body.displayName'],
  ])('rejects %s', (_label, change, field) => {
    const result = run(registerSchema, { body: { ...validRegister, ...change } });
    expect(result.ok).toBe(false);
    expect(result.fields).toContain(field);
  });

  it('allows underscores and digits in usernames', () => {
    expect(run(registerSchema, { body: { ...validRegister, username: 'a_b_9' } }).ok).toBe(true);
  });
});

describe('login and tokens', () => {
  it('lowercases the identifier and applies no strength rules to existing passwords', () => {
    const result = run(loginSchema, { body: { identifier: '  Sabir@Example.com ', password: 'x' } });
    expect(result.ok).toBe(true);
    expect((result.data as { body: { identifier: string } }).body.identifier).toBe('sabir@example.com');
  });

  it('needs both an identifier and a password', () => {
    expect(run(loginSchema, { body: { identifier: '', password: 'x' } }).ok).toBe(false);
    expect(run(loginSchema, { body: { identifier: 'a', password: '' } }).ok).toBe(false);
  });

  it('accepts emailed tokens that are 64 hex characters, and nothing else', () => {
    expect(run(verifyEmailSchema, { body: { token: TOKEN } }).ok).toBe(true);
    expect(run(verifyEmailSchema, { body: { token: 'A'.repeat(64) } }).ok).toBe(true);
    expect(run(verifyEmailSchema, { body: { token: 'a'.repeat(63) } }).ok).toBe(false);
    expect(run(verifyEmailSchema, { body: { token: 'z'.repeat(64) } }).ok).toBe(false);
  });

  it('checks the new password when resetting', () => {
    expect(run(resetPasswordSchema, { body: { token: TOKEN, newPassword: PASSWORD } }).ok).toBe(true);
    expect(run(resetPasswordSchema, { body: { token: TOKEN, newPassword: 'weak' } }).fields).toContain('body.newPassword');
  });

  it('needs a valid email to request a reset', () => {
    expect(run(forgotPasswordSchema, { body: { email: 'a@b.com' } }).ok).toBe(true);
    expect(run(forgotPasswordSchema, { body: { email: 'nope' } }).ok).toBe(false);
  });

  it('refuses a "new" password equal to the current one', () => {
    const same = run(changePasswordSchema, { body: { currentPassword: PASSWORD, newPassword: PASSWORD } });
    expect(same.ok).toBe(false);
    expect(same.fields).toContain('body.newPassword');
    expect(run(changePasswordSchema, { body: { currentPassword: PASSWORD, newPassword: 'Brand9NewPassword' } }).ok).toBe(true);
  });

  it('needs a real id for a session', () => {
    expect(run(sessionIdParamsSchema, { params: { sessionId: ID } }).ok).toBe(true);
    expect(run(sessionIdParamsSchema, { params: { sessionId: 'xyz' } }).ok).toBe(false);
  });
});

describe('ids and paging', () => {
  it('accepts 24 hex characters only', () => {
    expect(run(objectIdSchema, ID).ok).toBe(true);
    expect(run(objectIdSchema, ID.toUpperCase()).ok).toBe(true);
    expect(run(objectIdSchema, ID.slice(1)).ok).toBe(false);
    expect(run(objectIdSchema, 'z'.repeat(24)).ok).toBe(false);
  });

  it('pages by number with sensible defaults and limits', () => {
    expect(run(paginationQuerySchema, {}).data).toEqual({ page: 1, limit: 20 });
    expect(run(paginationQuerySchema, { page: '3', limit: '50' }).data).toEqual({ page: 3, limit: 50 });
    expect(run(paginationQuerySchema, { limit: '101' }).ok).toBe(false);
    expect(run(paginationQuerySchema, { page: '0' }).ok).toBe(false);
  });

  it('pages by cursor', () => {
    expect(run(cursorQuerySchema, {}).data).toEqual({ limit: 30 });
    expect(run(cursorQuerySchema, { cursor: ID, limit: '10' }).data).toEqual({ cursor: ID, limit: 10 });
    expect(run(cursorQuerySchema, { cursor: 'zzz' }).ok).toBe(false);
    expect(run(cursorQuerySchema, { limit: '500' }).ok).toBe(false);
  });

  it('checks the room id of message history', () => {
    expect(run(listMessagesSchema, { params: { roomId: ID }, query: {} }).ok).toBe(true);
    expect(run(listMessagesSchema, { params: { roomId: 'x' }, query: {} }).ok).toBe(false);
  });
});

describe('profile, privacy and account', () => {
  it('needs at least one profile field', () => {
    expect(run(updateProfileSchema, { body: {} }).ok).toBe(false);
    expect(run(updateProfileSchema, { body: { displayName: '' } }).ok).toBe(false);
    expect(run(updateProfileSchema, { body: { bio: '' } }).ok).toBe(true);
    expect(run(updateProfileSchema, { body: { bio: 'x'.repeat(301) } }).ok).toBe(false);
  });

  it('needs at least one real boolean privacy setting', () => {
    expect(run(updatePrivacySchema, { body: {} }).ok).toBe(false);
    expect(run(updatePrivacySchema, { body: { nearbyDiscoverable: true } }).ok).toBe(true);
    expect(run(updatePrivacySchema, { body: { nearbyDiscoverable: 'true' } }).ok).toBe(false);
  });

  it('asks for the password and the word DELETE to delete an account', () => {
    expect(run(deleteAccountSchema, { body: { password: 'x', confirmation: 'DELETE' } }).ok).toBe(true);
    expect(run(deleteAccountSchema, { body: { password: 'x', confirmation: 'delete' } }).ok).toBe(false);
    expect(run(deleteAccountSchema, { body: { confirmation: 'DELETE' } }).ok).toBe(false);
  });
});

describe('nearby', () => {
  it('uses the maximum radius of 5 km by default', () => {
    expect(run(searchNearbySchema, { query: {} }).data).toEqual({ query: { radiusKm: 5, page: 1, limit: 20 } });
  });

  it('converts text to numbers and enforces the 5 km limit', () => {
    expect((run(searchNearbySchema, { query: { radiusKm: '3' } }).data as { query: { radiusKm: number } }).query.radiusKm).toBe(3);
    expect(run(searchNearbySchema, { query: { radiusKm: '10' } }).fields).toContain('query.radiusKm');
    expect(run(searchNearbySchema, { query: { radiusKm: '0' } }).ok).toBe(false);
    expect(run(searchNearbySchema, { query: { radiusKm: '-1' } }).ok).toBe(false);
    expect(run(searchNearbySchema, { query: { limit: '51' } }).ok).toBe(false);
  });

  it('accepts only real coordinates, as numbers', () => {
    expect(run(updateLocationSchema, { body: { latitude: 28.6, longitude: 77.2 } }).ok).toBe(true);
    expect(run(updateLocationSchema, { body: { latitude: 91, longitude: 0 } }).ok).toBe(false);
    expect(run(updateLocationSchema, { body: { latitude: 0, longitude: -181 } }).ok).toBe(false);
    expect(run(updateLocationSchema, { body: { latitude: '28.6', longitude: 77.2 } }).ok).toBe(false);
  });
});

describe('chat and messages', () => {
  it('needs a user id to start a chat', () => {
    expect(run(createRoomSchema, { body: { userId: ID } }).ok).toBe(true);
    expect(run(createRoomSchema, { body: { userId: 'nope' } }).ok).toBe(false);
    expect(run(roomPayloadSchema, { roomId: ID }).ok).toBe(true);
  });

  it('accepts text messages of 1 to 2000 characters', () => {
    expect(run(sendMessagePayloadSchema, { roomId: ID, type: 'text', content: 'hi' }).ok).toBe(true);
    expect(run(sendMessagePayloadSchema, { roomId: ID, type: 'text', content: 'x'.repeat(2000) }).ok).toBe(true);
    expect(run(sendMessagePayloadSchema, { roomId: ID, type: 'text', content: 'x'.repeat(2001) }).ok).toBe(false);
    expect(run(sendMessagePayloadSchema, { roomId: ID, type: 'text', content: '   ' }).ok).toBe(false);
    expect(run(sendMessagePayloadSchema, { roomId: ID, type: 'text' }).ok).toBe(false);
  });

  it('needs a media id for every file type, with an optional caption', () => {
    for (const type of ['image', 'video', 'audio', 'document']) {
      expect(run(sendMessagePayloadSchema, { roomId: ID, type, mediaId: ID }).ok).toBe(true);
      expect(run(sendMessagePayloadSchema, { roomId: ID, type }).ok).toBe(false);
    }
    expect(run(sendMessagePayloadSchema, { roomId: ID, type: 'image', mediaId: ID, content: 'look' }).ok).toBe(true);
    expect(run(sendMessagePayloadSchema, { roomId: ID, type: 'image', mediaId: ID, content: 'x'.repeat(2001) }).ok).toBe(false);
  });

  it('rejects unknown message types and bad room ids', () => {
    expect(run(sendMessagePayloadSchema, { roomId: ID, type: 'sticker', content: 'x' }).ok).toBe(false);
    expect(run(sendMessagePayloadSchema, { roomId: 'nope', type: 'text', content: 'x' }).ok).toBe(false);
    expect(run(sendMessagePayloadSchema, null).ok).toBe(false);
  });
});

describe('media', () => {
  it('needs a room for an upload', () => {
    expect(run(uploadMediaSchema, { body: { roomId: ID } }).ok).toBe(true);
    expect(run(uploadMediaSchema, { body: {} }).ok).toBe(false);
  });

  it('needs all three signed-link parts, or none', () => {
    const sig = 'a'.repeat(64);
    expect(run(mediaFileSchema, { params: { mediaId: ID }, query: {} }).ok).toBe(true);
    expect(run(mediaFileSchema, { params: { mediaId: ID }, query: { uid: ID, exp: '1700000000', sig } }).ok).toBe(true);
    expect(run(mediaFileSchema, { params: { mediaId: ID }, query: { uid: ID } }).ok).toBe(false);
    expect(run(mediaFileSchema, { params: { mediaId: ID }, query: { uid: ID, exp: '1700000000', sig: 'short' } }).ok).toBe(false);
  });
});

describe('notifications, blocks and reports', () => {
  it('reads unreadOnly as a real boolean', () => {
    expect((run(listNotificationsSchema, { query: {} }).data as { query: { unreadOnly: boolean } }).query.unreadOnly).toBe(false);
    expect((run(listNotificationsSchema, { query: { unreadOnly: 'true' } }).data as { query: { unreadOnly: boolean } }).query.unreadOnly).toBe(true);
    expect(run(listNotificationsSchema, { query: { unreadOnly: 'maybe' } }).ok).toBe(false);
  });

  it('needs a user id to block', () => {
    expect(run(blockParamsSchema, { params: { userId: ID } }).ok).toBe(true);
    expect(run(blockParamsSchema, { params: { userId: 'x' } }).ok).toBe(false);
  });

  it('accepts reports about users and messages', () => {
    expect(run(createReportSchema, { body: { targetType: 'user', userId: ID, reason: 'spam' } }).ok).toBe(true);
    expect(run(createReportSchema, { body: { targetType: 'message', messageId: ID, reason: 'harassment' } }).ok).toBe(true);
    expect(run(createReportSchema, { body: { targetType: 'message', reason: 'spam' } }).ok).toBe(false);
    expect(run(createReportSchema, { body: { targetType: 'user', userId: ID, reason: 'because' } }).ok).toBe(false);
    expect(run(createReportSchema, { body: { targetType: 'group', userId: ID, reason: 'spam' } }).ok).toBe(false);
  });

  it('wants a description when the reason is "other"', () => {
    const base = { targetType: 'user', userId: ID, reason: 'other' };
    expect(run(createReportSchema, { body: base }).ok).toBe(false);
    expect(run(createReportSchema, { body: { ...base, details: 'too short' } }).ok).toBe(false);
    expect(run(createReportSchema, { body: { ...base, details: 'Repeated rude messages' } }).ok).toBe(true);
  });
});

describe('admin', () => {
  it('needs a reason to suspend or ban, but not to restore', () => {
    const params = { userId: ID };
    expect(run(updateUserStatusSchema, { params, body: { status: 'banned' } }).ok).toBe(false);
    expect(run(updateUserStatusSchema, { params, body: { status: 'banned', reason: 'ab' } }).ok).toBe(false);
    expect(run(updateUserStatusSchema, { params, body: { status: 'banned', reason: 'Repeated spam' } }).ok).toBe(true);
    expect(run(updateUserStatusSchema, { params, body: { status: 'active' } }).ok).toBe(true);
  });

  it('knows only the three roles', () => {
    expect(run(updateUserRoleSchema, { params: { userId: ID }, body: { role: 'moderator' } }).ok).toBe(true);
    expect(run(updateUserRoleSchema, { params: { userId: ID }, body: { role: 'superadmin' } }).ok).toBe(false);
    expect(run(adminUserIdParamsSchema, { params: { userId: 'x' } }).ok).toBe(false);
  });

  it('needs a note to resolve or dismiss a report', () => {
    const params = { reportId: ID };
    expect(run(updateReportSchema, { params, body: { status: 'under_review' } }).ok).toBe(true);
    expect(run(updateReportSchema, { params, body: { status: 'resolved' } }).ok).toBe(false);
    expect(run(updateReportSchema, { params, body: { status: 'resolved', resolutionNote: 'ok' } }).ok).toBe(false);
    expect(run(updateReportSchema, { params, body: { status: 'dismissed', resolutionNote: 'No violation found' } }).ok).toBe(true);
  });

  it('filters users and audit logs sensibly', () => {
    expect(run(listUsersSchema, { query: { role: 'superuser' } }).ok).toBe(false);
    expect(run(listUsersSchema, { query: { search: '' } }).ok).toBe(false);
    expect(run(listUsersSchema, { query: { search: 'ali', role: 'user', status: 'active' } }).ok).toBe(true);
    expect(run(listAuditLogsSchema, { query: { from: '2020-01-01', to: '2030-01-01' } }).ok).toBe(true);
    expect(run(listAuditLogsSchema, { query: { from: '2030-01-01', to: '2020-01-01' } }).ok).toBe(false);
    expect(run(listAuditLogsSchema, { query: { from: 'notadate' } }).ok).toBe(false);
  });
});