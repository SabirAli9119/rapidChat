import type { IncomingHttpHeaders } from 'node:http';
import type { Types } from 'mongoose';
import { resolveUserFromAccessToken } from '../middlewares/auth.middleware';
import { Session } from '../models/Session.model';
import { User, type IUser } from '../models/User.model';
import type { TypedSocket, TypedSocketServer } from '../types';
import { ApiError } from '../utils/ApiError';
import { ACCESS_COOKIE_NAME } from '../utils/cookies';
import { userRoom } from './channels';

/** One person may keep at most this many connections open (tabs and devices). */
export const MAX_SOCKETS_PER_USER = 10;

/** Reasons an open connection must be ended, with the message shown to the user. */
export const SESSION_PROBLEMS = {
  SESSION_INVALID: 'Your session has ended. Please log in again.',
  USER_NOT_FOUND: 'Account not found',
  ACCOUNT_BANNED: 'Your account has been banned',
  ACCOUNT_SUSPENDED: 'Your account is suspended',
} as const;

export type SessionProblem = keyof typeof SESSION_PROBLEMS;

export const isSessionProblem = (code: string): code is SessionProblem =>
  Object.hasOwn(SESSION_PROBLEMS, code);

// ---------- Connecting ----------

function readCookie(header: string | undefined, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index === -1) continue;
    if (part.slice(0, index).trim() !== name) continue;

    const raw = part.slice(index + 1).trim();
    try {
      return decodeURIComponent(raw);
    } catch {
      return raw;
    }
  }
  return null;
}

/**
 * Where the access token can come from, in this order:
 *  1. handshake auth: io(url, { auth: { token } })  (apps, scripts, Postman)
 *  2. an "Authorization: Bearer" header
 *  3. the HTTP-only cookie  (browsers: io(url, { withCredentials: true }))
 */
export function extractSocketToken(handshake: {
  headers: IncomingHttpHeaders;
  auth: Record<string, unknown>;
}): string | null {
  const fromAuth = handshake.auth?.token;
  if (typeof fromAuth === 'string' && fromAuth.length > 0) return fromAuth;

  const header = handshake.headers.authorization;
  if (typeof header === 'string' && header.startsWith('Bearer ')) {
    const token = header.slice(7).trim();
    if (token.length > 0) return token;
  }
  return readCookie(handshake.headers.cookie, ACCESS_COOKIE_NAME);
}

/**
 * Runs once per connection, before it is accepted. Same checks as the REST API: valid token,
 * live session, active account. Chat also needs a verified email, like the REST routes.
 */
export async function authenticateSocket(socket: TypedSocket): Promise<void> {
  const token = extractSocketToken(socket.handshake);
  if (!token) throw ApiError.unauthorized('Authentication required', { code: 'NO_TOKEN' });

  const user = await resolveUserFromAccessToken(token);
  if (!user.emailVerified) {
    throw ApiError.forbidden('Please verify your email address first', { code: 'EMAIL_NOT_VERIFIED' });
  }

  socket.data.userId = user.id;
  socket.data.sessionId = user.sessionId;
  socket.data.role = user.role;
}

export async function assertConnectionAllowed(io: TypedSocketServer, userId: string): Promise<void> {
  const open = await io.in(userRoom(userId)).fetchSockets();
  if (open.length >= MAX_SOCKETS_PER_USER) {
    throw ApiError.tooManyRequests('Too many open connections for this account', {
      code: 'TOO_MANY_CONNECTIONS',
    });
  }
}

/** The client sees this as connect_error: err.message is the text, err.data.code is the code. */
export function toConnectError(err: unknown): Error & { data: { code: string } } {
  let code = 'INTERNAL_ERROR';
  let message = 'Could not connect';
  if (err instanceof ApiError) {
    code = err.code ?? 'UNAUTHORIZED';
    message = err.message;
  }
  return Object.assign(new Error(message), { data: { code } });
}

// ---------- Staying connected ----------

/**
 * Checks many (user, session) pairs with just two queries. Returns the problem for every
 * session that must be ended. The account is judged first, so a banned user gets ACCOUNT_BANNED
 * rather than SESSION_INVALID (banning also revokes their sessions).
 */
export async function findSessionProblems(
  pairs: { userId: string; sessionId: string }[],
): Promise<Map<string, SessionProblem>> {
  const problems = new Map<string, SessionProblem>();
  if (pairs.length === 0) return problems;

  const sessionIds = [...new Set(pairs.map((pair) => pair.sessionId))];
  const userIds = [...new Set(pairs.map((pair) => pair.userId))];

  const [sessions, users] = await Promise.all([
    Session.find({ _id: { $in: sessionIds }, revokedAt: null, expiresAt: { $gt: new Date() } })
      .select('userId')
      .lean<{ _id: Types.ObjectId; userId: Types.ObjectId }[]>(),
    User.find({ _id: { $in: userIds } })
      .select('status deletedAt')
      .lean<Pick<IUser, '_id' | 'status' | 'deletedAt'>[]>(),
  ]);

  const liveSessions = new Map(sessions.map((s) => [String(s._id), String(s.userId)]));
  const usersById = new Map(users.map((u) => [String(u._id), u]));

  for (const { userId, sessionId } of pairs) {
    const user = usersById.get(userId);
    if (!user || user.deletedAt) problems.set(sessionId, 'USER_NOT_FOUND');
    else if (user.status === 'banned') problems.set(sessionId, 'ACCOUNT_BANNED');
    else if (user.status === 'suspended') problems.set(sessionId, 'ACCOUNT_SUSPENDED');
    else if (liveSessions.get(sessionId) !== userId) problems.set(sessionId, 'SESSION_INVALID');
  }
  return problems;
}

/** Tells the client why, then closes the connection. */
export function endSocket(socket: TypedSocket, code: string): void {
  socket.emit('session_ended', { code });
  socket.disconnect(true);
}

const lastValidated = new WeakMap<TypedSocket, number>();

export function markSocketValidated(socket: TypedSocket): void {
  lastValidated.set(socket, Date.now());
}

/**
 * Called before sensitive events (sending, joining). Throws if this connection's session or
 * account is no longer valid. The database is consulted at most once per `recheckMs`,
 * so a burst of messages costs one check, not one per message.
 */
export async function assertSocketActive(socket: TypedSocket, recheckMs: number): Promise<void> {
  const last = lastValidated.get(socket) ?? 0;
  if (recheckMs > 0 && Date.now() - last < recheckMs) return;

  const { userId, sessionId } = socket.data;
  const problem = (await findSessionProblems([{ userId, sessionId }])).get(sessionId);
  if (problem) {
    // The handler sends the error reply first and ends the connection afterwards
    throw ApiError.unauthorized(SESSION_PROBLEMS[problem], { code: problem });
  }
  lastValidated.set(socket, Date.now());
}

/**
 * Closes every connection whose session was revoked or whose account was banned, suspended or deleted.
 * Runs on a timer, so a ban or logout takes effect on open connections within one interval.
 * Returns how many connections were closed.
 */
export async function sweepInvalidSockets(io: TypedSocketServer): Promise<number> {
  const sockets = await io.fetchSockets();
  if (sockets.length === 0) return 0;

  const problems = await findSessionProblems(
    sockets.map((s) => ({ userId: s.data.userId, sessionId: s.data.sessionId })),
  );

  let ended = 0;
  for (const remote of sockets) {
    const problem = problems.get(remote.data.sessionId);
    if (!problem) continue;
    remote.emit('session_ended', { code: problem });
    remote.disconnect(true);
    ended++;
  }
  return ended;
}