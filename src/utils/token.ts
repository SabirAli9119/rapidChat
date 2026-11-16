import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import { env } from '../config/env';
import { ApiError } from './ApiError';

const TOKEN_ISSUER = 'nearby-chat-api';
const ALGORITHM = 'HS256';

/** What is stored inside an access token. */
export interface AccessTokenPayload {
  /** User id */
  sub: string;
  /** Session id (one per logged-in device) */
  sid: string;
}

/** What is stored inside a refresh token. */
export interface RefreshTokenPayload extends AccessTokenPayload {
  /** Unique id of this exact refresh token (used for rotation + reuse detection) */
  jti: string;
}

// ---------- JWT ----------

/** Short-lived token (default 15 minutes) sent with every API request. */
export function signAccessToken(userId: string, sessionId: string): string {
  return jwt.sign({ sid: sessionId }, env.JWT_ACCESS_SECRET, {
    algorithm: ALGORITHM,
    issuer: TOKEN_ISSUER,
    subject: userId,
    expiresIn: env.JWT_ACCESS_EXPIRES_IN_MINUTES * 60,
  });
}

/** Long-lived token (default 7 days), used only to get a new access token. */
export function signRefreshToken(
  userId: string,
  sessionId: string,
): { token: string; jti: string; expiresAt: Date } {
  const jti = crypto.randomUUID();
  const expiresInSeconds = env.JWT_REFRESH_EXPIRES_IN_DAYS * 24 * 60 * 60;

  const token = jwt.sign({ sid: sessionId }, env.JWT_REFRESH_SECRET, {
    algorithm: ALGORITHM,
    issuer: TOKEN_ISSUER,
    subject: userId,
    jwtid: jti,
    expiresIn: expiresInSeconds,
  });

  return { token, jti, expiresAt: new Date(Date.now() + expiresInSeconds * 1000) };
}

/** Verifies a token and returns its payload, or throws a 401 ApiError. */
function verifyToken(token: string, secret: string): jwt.JwtPayload {
  try {
    const decoded = jwt.verify(token, secret, {
      algorithms: [ALGORITHM], // only accept the algorithm we use
      issuer: TOKEN_ISSUER,
    });

    if (typeof decoded === 'string') {
      throw ApiError.unauthorized('Invalid token', { code: 'INVALID_TOKEN' });
    }
    return decoded;
  } catch (err) {
    if (err instanceof ApiError) throw err;
    if (err instanceof jwt.TokenExpiredError) {
      // The frontend watches for this code and calls the refresh endpoint
      throw ApiError.unauthorized('Token has expired', { code: 'TOKEN_EXPIRED' });
    }
    throw ApiError.unauthorized('Invalid token', { code: 'INVALID_TOKEN' });
  }
}

export function verifyAccessToken(token: string): AccessTokenPayload {
  const payload = verifyToken(token, env.JWT_ACCESS_SECRET);
  if (typeof payload.sub !== 'string' || typeof payload.sid !== 'string') {
    throw ApiError.unauthorized('Invalid token', { code: 'INVALID_TOKEN' });
  }
  return { sub: payload.sub, sid: payload.sid };
}

export function verifyRefreshToken(token: string): RefreshTokenPayload {
  const payload = verifyToken(token, env.JWT_REFRESH_SECRET);
  if (
    typeof payload.sub !== 'string' ||
    typeof payload.sid !== 'string' ||
    typeof payload.jti !== 'string'
  ) {
    throw ApiError.unauthorized('Invalid token', { code: 'INVALID_TOKEN' });
  }
  return { sub: payload.sub, sid: payload.sid, jti: payload.jti };
}

// ---------- Random tokens (email verification, password reset) ----------

/** Cryptographically secure random token, e.g. for the link in an email. */
export function generateSecureToken(bytes = 32): string {
  return crypto.randomBytes(bytes).toString('hex');
}

/** SHA-256 hash. We store only the hash of a token, never the token itself. */
export function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

/** Compares two strings in constant time (prevents timing attacks). */
export function safeEqual(a: string, b: string): boolean {
  const bufferA = Buffer.from(a);
  const bufferB = Buffer.from(b);
  if (bufferA.length !== bufferB.length) return false;
  return crypto.timingSafeEqual(bufferA, bufferB);
}