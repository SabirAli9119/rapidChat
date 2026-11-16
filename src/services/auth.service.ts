import * as argon2 from 'argon2';
import type { Types } from 'mongoose';
import { env } from '../config/env';
import { EmailVerificationToken, type IEmailVerificationToken } from '../models/EmailVerificationToken.model';
import { PasswordResetToken, type IPasswordResetToken } from '../models/PasswordResetToken.model';
import { RefreshToken, type IRefreshToken } from '../models/RefreshToken.model';
import { Session, type ISession } from '../models/Session.model';
import { User, type IUser } from '../models/User.model';
import { ApiError } from '../utils/ApiError';
import { isDuplicateKeyError } from '../utils/db';
import { logger } from '../utils/logger';
import {
  generateSecureToken,
  hashToken,
  safeEqual,
  signAccessToken,
  signRefreshToken,
  verifyRefreshToken,
  type RefreshTokenPayload,
} from '../utils/token';
import type {
  ChangePasswordInput,
  LoginInput,
  RegisterInput,
  ResetPasswordInput,
} from '../validators/auth.validator';
import { recordSecurityEvent } from './audit.service';
import {
  sendPasswordChangedEmail,
  sendPasswordResetEmail,
  sendVerificationEmail,
} from './email.service';
import { toSelfUserDTO, type SelfUserDTO } from './user.service';

// ---------- Types ----------

/** Information about the HTTP request that controllers pass in (the service never sees `req`). */
export interface RequestContext {
  ipAddress: string | null;
  userAgent: string | null;
}

export interface AuthResult {
  user: SelfUserDTO;
  accessToken: string;
  refreshToken: string;
  sessionId: string;
}

export interface RefreshResult {
  accessToken: string;
  refreshToken: string;
}

export interface SessionDTO {
  id: string;
  deviceLabel: string;
  ipAddress: string | null;
  lastActiveAt: string;
  createdAt: string;
  /** True for the session making this request */
  current: boolean;
}

// ---------- Settings ----------

const MINUTE_MS = 60 * 1000;
const DAY_MS = 24 * 60 * MINUTE_MS;

const MAX_FAILED_LOGINS = 5;
const LOCK_MINUTES = 15;
/** Two tabs refreshing at the same moment is normal; this long after use, a second use is treated as theft. */
const REFRESH_REUSE_GRACE_MS = 10 * 1000;
const EMAIL_COOLDOWN_MS = 60 * 1000;
const MAX_ACTIVE_SESSIONS = 10;

// ---------- Passwords ----------

const HASH_OPTIONS: argon2.HashOptions = {
  type: argon2.argon2id,
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
};

export const hashPassword = (password: string): Promise<string> =>
  argon2.hash(password, HASH_OPTIONS) as Promise<string>;

async function verifyPassword(hash: string, password: string): Promise<boolean> {
  try {
    return await argon2.verify(hash, password);
  } catch {
    return false; // a malformed hash must behave like a wrong password
  }
}

/**
 * Used when the account does not exist, so a login for an unknown user takes about
 * as long as a real one. Otherwise response time would reveal which accounts exist.
 */
let dummyHash: Promise<string> | undefined;
const getDummyHash = (): Promise<string> => (dummyHash ??= hashPassword('timing-equaliser-password'));

const invalidCredentials = (): ApiError =>
  ApiError.unauthorized('Incorrect username/email or password', { code: 'INVALID_CREDENTIALS' });

// ---------- Small helpers ----------

const clip = (value: string | null, max: number): string | null => (value ? value.slice(0, max) : null);

/** Turns a User-Agent string into a friendly label like "Chrome on Windows". */
export function describeDevice(userAgent: string | null): string {
  if (!userAgent) return 'Unknown device';

  let browser: string | null = null;
  if (/PostmanRuntime/i.test(userAgent)) browser = 'Postman';
  else if (/Thunder Client/i.test(userAgent)) browser = 'Thunder Client';
  else if (/Edg\//.test(userAgent)) browser = 'Edge';
  else if (/OPR\/|Opera/.test(userAgent)) browser = 'Opera';
  else if (/Firefox\//.test(userAgent)) browser = 'Firefox';
  else if (/Chrome\/|CriOS\//.test(userAgent)) browser = 'Chrome';
  else if (/Safari\//.test(userAgent)) browser = 'Safari';

  // Order matters: Android UAs also say "Linux", and iPhone UAs also say "Mac OS X"
  let os: string | null = null;
  if (/Windows/.test(userAgent)) os = 'Windows';
  else if (/Android/.test(userAgent)) os = 'Android';
  else if (/iPhone|iPad|iPod/.test(userAgent)) os = 'iOS';
  else if (/Mac OS X|Macintosh/.test(userAgent)) os = 'macOS';
  else if (/Linux/.test(userAgent)) os = 'Linux';

  if (browser && os) return `${browser} on ${os}`;
  if (browser) return browser;
  if (os) return `Unknown browser on ${os}`;
  return 'Unknown device';
}

// ---------- Sessions and tokens (internal) ----------

async function issueTokens(
  userId: string,
  sessionId: string,
): Promise<{ accessToken: string; refreshToken: string; refreshExpiresAt: Date; jti: string }> {
  const accessToken = signAccessToken(userId, sessionId);
  const refresh = signRefreshToken(userId, sessionId);

  // Only the HASH of the refresh token is stored
  await RefreshToken.create({
    jti: refresh.jti,
    userId,
    sessionId,
    tokenHash: hashToken(refresh.token),
    expiresAt: refresh.expiresAt,
  });

  return { accessToken, refreshToken: refresh.token, refreshExpiresAt: refresh.expiresAt, jti: refresh.jti };
}

/** Ends sessions and deletes their refresh tokens. Safe to call for sessions that are already ended. */
async function revokeSessions(sessionIds: (Types.ObjectId | string)[], reason: string): Promise<void> {
  if (sessionIds.length === 0) return;
  await Session.updateMany(
    { _id: { $in: sessionIds }, revokedAt: null },
    { $set: { revokedAt: new Date(), revokedReason: reason } },
  );
  await RefreshToken.deleteMany({ sessionId: { $in: sessionIds } });
}

/** Ends every session of a user, optionally keeping one. Returns how many were ended. */
export async function revokeAllUserSessions(
  userId: string,
  options: { reason: string; exceptSessionId?: string },
): Promise<number> {
  const sessions = await Session.find({
    userId,
    revokedAt: null,
    ...(options.exceptSessionId ? { _id: { $ne: options.exceptSessionId } } : {}),
  })
    .select('_id')
    .lean<{ _id: Types.ObjectId }[]>();

  await revokeSessions(
    sessions.map((s) => s._id),
    options.reason,
  );
  return sessions.length;
}

/** Keeps at most MAX_ACTIVE_SESSIONS devices logged in; the least recently used are signed out. */
async function enforceSessionLimit(userId: string): Promise<void> {
  const active = await Session.find({ userId, revokedAt: null, expiresAt: { $gt: new Date() } })
    .sort({ lastActiveAt: -1 })
    .select('_id')
    .lean<{ _id: Types.ObjectId }[]>();

  const excess = active.slice(MAX_ACTIVE_SESSIONS);
  await revokeSessions(
    excess.map((s) => s._id),
    'session_limit',
  );
}

async function startSession(
  userId: string,
  ctx: RequestContext,
): Promise<{ sessionId: string; accessToken: string; refreshToken: string }> {
  const session = await Session.create({
    userId,
    userAgent: clip(ctx.userAgent, 512),
    deviceLabel: describeDevice(ctx.userAgent),
    ipAddress: clip(ctx.ipAddress, 64),
    expiresAt: new Date(Date.now() + env.JWT_REFRESH_EXPIRES_IN_DAYS * DAY_MS),
  });

  const sessionId = session.id as string;
  const tokens = await issueTokens(userId, sessionId);
  await enforceSessionLimit(userId);

  return { sessionId, accessToken: tokens.accessToken, refreshToken: tokens.refreshToken };
}

// ---------- Registration and email verification ----------

/** Replaces any older verification token with a new one and returns the RAW token (to email). */
async function createVerificationToken(user: { _id: Types.ObjectId; email: string }): Promise<string> {
  await EmailVerificationToken.deleteMany({ userId: user._id });

  const token = generateSecureToken();
  await EmailVerificationToken.create({
    userId: user._id,
    email: user.email,
    tokenHash: hashToken(token),
    expiresAt: new Date(Date.now() + env.EMAIL_VERIFICATION_EXPIRES_HOURS * 60 * MINUTE_MS),
  });
  return token;
}

/** Creates an account and emails a verification link. The user must still log in afterwards. */
export async function register(input: RegisterInput): Promise<SelfUserDTO> {
  const [usernameTaken, emailTaken] = await Promise.all([
    User.exists({ username: input.username }),
    User.exists({ email: input.email }),
  ]);
  if (usernameTaken) throw ApiError.conflict('This username is already taken', { code: 'USERNAME_TAKEN' });
  if (emailTaken) throw ApiError.conflict('An account with this email already exists', { code: 'EMAIL_TAKEN' });

  const passwordHash = await hashPassword(input.password);

  let user;
  try {
    user = await User.create({
      username: input.username,
      email: input.email,
      passwordHash,
      displayName: input.displayName,
    });
  } catch (err) {
    // Two people registering the same name at the same instant: the unique index decides
    if (isDuplicateKeyError(err)) {
      throw ApiError.conflict('Username or email is already in use', { code: 'ALREADY_EXISTS' });
    }
    throw err;
  }

  const token = await createVerificationToken(user);
  void sendVerificationEmail(user.email, user.displayName, token); // never throws; not awaited so the response is fast

  return toSelfUserDTO(user);
}

/** Single-use: the token is deleted the moment it is claimed. */
export async function verifyEmail(token: string): Promise<SelfUserDTO> {
  const invalid = (): ApiError =>
    ApiError.badRequest('This verification link is invalid or has expired', { code: 'INVALID_VERIFICATION_TOKEN' });

  const record = await EmailVerificationToken.findOneAndDelete({
    tokenHash: hashToken(token),
    expiresAt: { $gt: new Date() },
  }).lean<IEmailVerificationToken>();
  if (!record) throw invalid();

  // The address must still be the one that was verified
  const user = await User.findOneAndUpdate(
    { _id: record.userId, email: record.email, deletedAt: null },
    { $set: { emailVerified: true, emailVerifiedAt: new Date() } },
    { new: true },
  ).lean<IUser>();
  if (!user) throw invalid();

  await EmailVerificationToken.deleteMany({ userId: user._id });
  return toSelfUserDTO(user);
}

export async function resendVerificationEmail(userId: string): Promise<void> {
  const user = await User.findOne({ _id: userId, deletedAt: null })
    .select('email displayName emailVerified')
    .lean<IUser>();
  if (!user) throw ApiError.notFound('Account not found');
  if (user.emailVerified) {
    throw ApiError.conflict('Your email is already verified', { code: 'ALREADY_VERIFIED' });
  }

  const last = await EmailVerificationToken.findOne({ userId })
    .sort({ createdAt: -1 })
    .select('createdAt')
    .lean<{ createdAt: Date }>();
  if (last && Date.now() - last.createdAt.getTime() < EMAIL_COOLDOWN_MS) {
    throw ApiError.tooManyRequests('Please wait a minute before requesting another email', {
      code: 'EMAIL_COOLDOWN',
    });
  }

  const token = await createVerificationToken(user);
  void sendVerificationEmail(user.email, user.displayName, token);
}

// ---------- Login ----------

async function registerFailedLogin(user: IUser, ctx: RequestContext): Promise<void> {
  const updated = await User.findOneAndUpdate(
    { _id: user._id },
    { $inc: { failedLoginAttempts: 1 } },
    { new: true },
  )
    .select('failedLoginAttempts')
    .lean<Pick<IUser, 'failedLoginAttempts'>>();

  const locked = (updated?.failedLoginAttempts ?? 0) >= MAX_FAILED_LOGINS;
  if (locked) {
    await User.updateOne(
      { _id: user._id },
      { $set: { lockUntil: new Date(Date.now() + LOCK_MINUTES * MINUTE_MS), failedLoginAttempts: 0 } },
    );
  }

  await recordSecurityEvent({
    action: 'security.login_failed',
    targetUserId: String(user._id),
    metadata: { accountLocked: locked },
    ipAddress: ctx.ipAddress,
    userAgent: ctx.userAgent,
  });
}

export async function login(input: LoginInput, ctx: RequestContext): Promise<AuthResult> {
  const filter = input.identifier.includes('@') ? { email: input.identifier } : { username: input.identifier };

  const user = await User.findOne({ ...filter, deletedAt: null })
    .select('+passwordHash')
    .lean<IUser>();

  if (!user) {
    await verifyPassword(await getDummyHash(), input.password); // spend the same time as a real check
    logger.warn({ ip: ctx.ipAddress }, 'Login attempt for an unknown account');
    throw invalidCredentials();
  }

  // While locked, the password is NOT even checked, so guessing cannot continue
  const now = new Date();
  if (user.lockUntil && user.lockUntil > now) {
    throw ApiError.tooManyRequests('Too many failed attempts. Please try again later.', {
      code: 'ACCOUNT_LOCKED',
      details: { retryAfterSeconds: Math.ceil((user.lockUntil.getTime() - now.getTime()) / 1000) },
    });
  }

  if (!(await verifyPassword(user.passwordHash, input.password))) {
    await registerFailedLogin(user, ctx);
    throw invalidCredentials();
  }

  // Only someone who knows the password learns the account is banned or suspended
  if (user.status === 'banned') throw ApiError.forbidden('Your account has been banned', { code: 'ACCOUNT_BANNED' });
  if (user.status === 'suspended') {
    throw ApiError.forbidden('Your account is suspended', { code: 'ACCOUNT_SUSPENDED' });
  }

  await User.updateOne(
    { _id: user._id },
    { $set: { failedLoginAttempts: 0, lockUntil: null, lastLoginAt: now } },
  );

  const session = await startSession(String(user._id), ctx);

  if (user.role !== 'user') {
    await recordSecurityEvent({
      action: 'security.admin_login',
      targetUserId: String(user._id),
      metadata: { role: user.role },
      ipAddress: ctx.ipAddress,
      userAgent: ctx.userAgent,
    });
  }

  return { user: toSelfUserDTO(user), ...session };
}

// ---------- Refresh-token rotation ----------

async function handleTokenReuse(payload: RefreshTokenPayload, ctx: RequestContext): Promise<void> {
  await revokeSessions([payload.sid], 'refresh_token_reuse');
  await recordSecurityEvent({
    action: 'security.token_reuse_detected',
    targetUserId: payload.sub,
    metadata: { sessionId: payload.sid },
    ipAddress: ctx.ipAddress,
    userAgent: ctx.userAgent,
  });
  logger.warn({ userId: payload.sub, sessionId: payload.sid }, 'Refresh token reuse detected: session revoked');
}

/**
 * Exchanges a refresh token for a NEW pair of tokens. Every refresh token works exactly once.
 * If an already-used token shows up again, someone copied it: the whole session is revoked.
 */
export async function refreshTokens(rawToken: string, ctx: RequestContext): Promise<RefreshResult> {
  const payload = verifyRefreshToken(rawToken); // throws 401 if the signature is bad or the token expired
  const invalid = (): ApiError => ApiError.unauthorized('Invalid token', { code: 'INVALID_TOKEN' });

  const record = await RefreshToken.findOne({ jti: payload.jti }).lean<IRefreshToken>();
  if (
    !record ||
    String(record.userId) !== payload.sub ||
    String(record.sessionId) !== payload.sid ||
    !safeEqual(record.tokenHash, hashToken(rawToken))
  ) {
    throw invalid();
  }

  // Claim the token atomically. If two requests race, only one of them can win.
  const now = new Date();
  const claimed = await RefreshToken.findOneAndUpdate(
    { jti: payload.jti, usedAt: null },
    { $set: { usedAt: now } },
  ).lean<IRefreshToken>();

  if (!claimed) {
    const current = await RefreshToken.findOne({ jti: payload.jti }).select('usedAt').lean<Pick<IRefreshToken, 'usedAt'>>();
    if (!current) throw invalid(); // the session was just ended

    if (current.usedAt && now.getTime() - current.usedAt.getTime() <= REFRESH_REUSE_GRACE_MS) {
      // Almost certainly two tabs refreshing together. Not theft, so the session survives.
      throw ApiError.unauthorized('This token was just refreshed. Retry with the new one.', {
        code: 'REFRESH_IN_PROGRESS',
      });
    }

    await handleTokenReuse(payload, ctx);
    throw ApiError.unauthorized('Your session has been ended for security reasons. Please log in again.', {
      code: 'TOKEN_REUSED',
    });
  }

  const session = await Session.findOne({
    _id: payload.sid,
    userId: payload.sub,
    revokedAt: null,
    expiresAt: { $gt: now },
  })
    .select('_id')
    .lean();
  if (!session) {
    throw ApiError.unauthorized('Your session has ended. Please log in again.', { code: 'SESSION_INVALID' });
  }

  const user = await User.findById(payload.sub).select('status deletedAt').lean<Pick<IUser, 'status' | 'deletedAt'>>();
  if (!user || user.deletedAt) throw ApiError.unauthorized('Account not found', { code: 'USER_NOT_FOUND' });
  if (user.status === 'banned') throw ApiError.forbidden('Your account has been banned', { code: 'ACCOUNT_BANNED' });
  if (user.status === 'suspended') {
    throw ApiError.forbidden('Your account is suspended', { code: 'ACCOUNT_SUSPENDED' });
  }

  const next = await issueTokens(payload.sub, payload.sid);

  await Promise.all([
    RefreshToken.updateOne({ jti: payload.jti }, { $set: { replacedByJti: next.jti } }),
    // The session lives as long as its newest refresh token ("sliding" expiry)
    Session.updateOne(
      { _id: payload.sid },
      {
        $set: {
          lastActiveAt: now,
          expiresAt: next.refreshExpiresAt,
          ...(ctx.ipAddress ? { ipAddress: clip(ctx.ipAddress, 64) } : {}),
        },
      },
    ),
  ]);

  return { accessToken: next.accessToken, refreshToken: next.refreshToken };
}

// ---------- Logout and session management ----------

export async function logoutSession(sessionId: string): Promise<void> {
  await revokeSessions([sessionId], 'logout');
}

/** For when the access token already expired: the refresh cookie still identifies the session. Never throws. */
export async function logoutWithRefreshToken(rawToken: string): Promise<void> {
  try {
    const payload = verifyRefreshToken(rawToken);
    await revokeSessions([payload.sid], 'logout');
  } catch {
    // An invalid or expired token means there is nothing left to end
  }
}

export async function logoutOtherSessions(userId: string, currentSessionId: string): Promise<number> {
  return revokeAllUserSessions(userId, { reason: 'logout_others', exceptSessionId: currentSessionId });
}

export async function listSessions(userId: string, currentSessionId: string): Promise<SessionDTO[]> {
  const sessions = await Session.find({ userId, revokedAt: null, expiresAt: { $gt: new Date() } })
    .sort({ lastActiveAt: -1 })
    .lean<ISession[]>();

  return sessions.map((s) => ({
    id: String(s._id),
    deviceLabel: s.deviceLabel,
    ipAddress: s.ipAddress,
    lastActiveAt: s.lastActiveAt.toISOString(),
    createdAt: s.createdAt.toISOString(),
    current: String(s._id) === currentSessionId,
  }));
}

/** A user can only end their OWN sessions. Someone else's session id looks like "not found". */
export async function revokeSession(userId: string, sessionId: string): Promise<void> {
  const session = await Session.exists({ _id: sessionId, userId, revokedAt: null });
  if (!session) throw ApiError.notFound('Session not found');
  await revokeSessions([sessionId], 'revoked_by_user');
}

// ---------- Password reset and change ----------

/**
 * Does the real work of a "forgot password" request. Silent when the email is unknown.
 * Exported separately so tests can wait for it to finish.
 */
export async function processPasswordResetRequest(email: string, ipAddress: string | null): Promise<void> {
  const user = await User.findOne({ email, deletedAt: null }).select('email displayName').lean<IUser>();
  if (!user) return;

  // At most one reset email per minute per account, so nobody can flood a victim's inbox
  const recent = await PasswordResetToken.exists({
    userId: user._id,
    createdAt: { $gt: new Date(Date.now() - EMAIL_COOLDOWN_MS) },
  });
  if (recent) return;

  await PasswordResetToken.deleteMany({ userId: user._id });

  const token = generateSecureToken();
  await PasswordResetToken.create({
    userId: user._id,
    tokenHash: hashToken(token),
    expiresAt: new Date(Date.now() + env.PASSWORD_RESET_EXPIRES_MINUTES * MINUTE_MS),
    requestedFromIp: clip(ipAddress, 64),
  });

  await sendPasswordResetEmail(user.email, user.displayName, token);
}

/**
 * "Forgot password". Returns immediately and does the work in the background, so the response
 * (and its timing) is identical whether or not the email belongs to an account.
 */
export function requestPasswordReset(email: string, ipAddress: string | null): void {
  void processPasswordResetRequest(email, ipAddress).catch((err) =>
    logger.error({ err }, 'Password reset request failed'),
  );
}

export async function resetPassword(input: ResetPasswordInput): Promise<void> {
  const invalid = (): ApiError =>
    ApiError.badRequest('This reset link is invalid or has expired', { code: 'INVALID_RESET_TOKEN' });
  const tokenHash = hashToken(input.token);

  // Look first, consume later: a rejected new password must not burn the link
  const record = await PasswordResetToken.findOne({
    tokenHash,
    usedAt: null,
    expiresAt: { $gt: new Date() },
  }).lean<IPasswordResetToken>();
  if (!record) throw invalid();

  const user = await User.findOne({ _id: record.userId, deletedAt: null })
    .select('username email displayName')
    .lean<IUser>();
  if (!user) throw invalid();

  if (input.newPassword.toLowerCase().includes(user.username)) {
    throw ApiError.badRequest('Password must not contain your username', { code: 'WEAK_PASSWORD' });
  }

  const passwordHash = await hashPassword(input.newPassword);

  // Now claim the link. If two requests race, only one gets it.
  const claimed = await PasswordResetToken.findOneAndUpdate(
    { _id: record._id, usedAt: null },
    { $set: { usedAt: new Date() } },
  );
  if (!claimed) throw invalid();

  await User.updateOne(
    { _id: user._id },
    { $set: { passwordHash, passwordChangedAt: new Date(), failedLoginAttempts: 0, lockUntil: null } },
  );
  await PasswordResetToken.deleteMany({ userId: user._id });
  await revokeAllUserSessions(String(user._id), { reason: 'password_reset' }); // anyone who had access is out

  void sendPasswordChangedEmail(user.email, user.displayName);
}

export async function changePassword(
  userId: string,
  currentSessionId: string,
  input: ChangePasswordInput,
): Promise<void> {
  const user = await User.findOne({ _id: userId, deletedAt: null })
    .select('+passwordHash username email displayName')
    .lean<IUser>();
  if (!user) throw ApiError.notFound('Account not found');

  if (!(await verifyPassword(user.passwordHash, input.currentPassword))) {
    // 403 (not 401) so a client never mistakes a typo for an expired login
    throw ApiError.forbidden('Current password is incorrect', { code: 'INVALID_PASSWORD' });
  }
  if (input.newPassword.toLowerCase().includes(user.username)) {
    throw ApiError.badRequest('Password must not contain your username', { code: 'WEAK_PASSWORD' });
  }

  const passwordHash = await hashPassword(input.newPassword);
  await User.updateOne({ _id: user._id }, { $set: { passwordHash, passwordChangedAt: new Date() } });

  // This device stays signed in; every other device is signed out
  await revokeAllUserSessions(userId, { reason: 'password_changed', exceptSessionId: currentSessionId });

  void sendPasswordChangedEmail(user.email, user.displayName);
}