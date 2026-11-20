import jwt from 'jsonwebtoken';
import { describe, expect, it } from 'vitest';
import { env } from '../../src/config/env';
import { ApiError } from '../../src/utils/ApiError';
import {
  generateSecureToken,
  hashToken,
  safeEqual,
  signAccessToken,
  signRefreshToken,
  verifyAccessToken,
  verifyRefreshToken,
} from '../../src/utils/token';

const ISSUER = 'nearby-chat-api';
const nowSeconds = (): number => Math.floor(Date.now() / 1000);
const base64url = (value: object): string => Buffer.from(JSON.stringify(value)).toString('base64url');

function thrown(fn: () => unknown): ApiError {
  try {
    fn();
  } catch (err) {
    if (err instanceof ApiError) return err;
    throw err;
  }
  throw new Error('Expected the function to throw');
}

describe('access tokens', () => {
  it('carry the user id and the session id', () => {
    expect(verifyAccessToken(signAccessToken('user1', 'session1'))).toEqual({ sub: 'user1', sid: 'session1' });
  });

  it('live for the configured time', () => {
    const decoded = jwt.decode(signAccessToken('u', 's')) as { iat: number; exp: number };
    expect(decoded.exp - decoded.iat).toBe(env.JWT_ACCESS_EXPIRES_IN_MINUTES * 60);
  });

  it('are rejected when they are garbage', () => {
    const err = thrown(() => verifyAccessToken('garbage'));
    expect(err.statusCode).toBe(401);
    expect(err.code).toBe('INVALID_TOKEN');
  });

  it('are rejected after they expire, with a code the frontend can react to', () => {
    const expired = jwt.sign({ sid: 's', exp: nowSeconds() - 60 }, env.JWT_ACCESS_SECRET, {
      algorithm: 'HS256',
      issuer: ISSUER,
      subject: 'u',
    });
    const err = thrown(() => verifyAccessToken(expired));
    expect(err.statusCode).toBe(401);
    expect(err.code).toBe('TOKEN_EXPIRED');
  });

  it('are rejected when the signature was changed', () => {
    const [header, payload, signature] = signAccessToken('u', 's').split('.');
    const flipped = signature.slice(0, 10) + (signature[10] === 'A' ? 'B' : 'A') + signature.slice(11);
    expect(thrown(() => verifyAccessToken(`${header}.${payload}.${flipped}`)).code).toBe('INVALID_TOKEN');
  });

  it('are rejected when the algorithm is "none" (unsigned)', () => {
    const forged = `${base64url({ alg: 'none', typ: 'JWT' })}.${base64url({
      sub: 'u',
      sid: 's',
      iss: ISSUER,
      exp: nowSeconds() + 600,
    })}.`;
    expect(thrown(() => verifyAccessToken(forged)).code).toBe('INVALID_TOKEN');
  });

  it('are rejected when someone else issued them', () => {
    const foreign = jwt.sign({ sid: 's' }, env.JWT_ACCESS_SECRET, {
      algorithm: 'HS256',
      issuer: 'someone-else',
      subject: 'u',
      expiresIn: 60,
    });
    expect(thrown(() => verifyAccessToken(foreign)).code).toBe('INVALID_TOKEN');
  });

  it('are rejected when they have no session id', () => {
    const noSession = jwt.sign({}, env.JWT_ACCESS_SECRET, {
      algorithm: 'HS256',
      issuer: ISSUER,
      subject: 'u',
      expiresIn: 60,
    });
    expect(thrown(() => verifyAccessToken(noSession)).code).toBe('INVALID_TOKEN');
  });

  it('cannot be made from a refresh token', () => {
    const refresh = signRefreshToken('u', 's').token;
    expect(thrown(() => verifyAccessToken(refresh)).code).toBe('INVALID_TOKEN');
  });
});

describe('refresh tokens', () => {
  it('carry user, session and a unique id', () => {
    const first = signRefreshToken('user1', 'session1');
    const second = signRefreshToken('user1', 'session1');

    expect(verifyRefreshToken(first.token)).toEqual({ sub: 'user1', sid: 'session1', jti: first.jti });
    expect(first.jti).not.toBe(second.jti);
    expect(first.token).not.toBe(second.token);
  });

  it('expire after the configured number of days', () => {
    const { expiresAt } = signRefreshToken('u', 's');
    const expected = Date.now() + env.JWT_REFRESH_EXPIRES_IN_DAYS * 24 * 60 * 60 * 1000;
    expect(Math.abs(expiresAt.getTime() - expected)).toBeLessThan(5000);
  });

  it('cannot be made from an access token', () => {
    expect(thrown(() => verifyRefreshToken(signAccessToken('u', 's'))).code).toBe('INVALID_TOKEN');
  });

  it('are rejected after they expire', () => {
    const expired = jwt.sign({ sid: 's', exp: nowSeconds() - 60 }, env.JWT_REFRESH_SECRET, {
      algorithm: 'HS256',
      issuer: ISSUER,
      subject: 'u',
      jwtid: 'j1',
    });
    expect(thrown(() => verifyRefreshToken(expired)).code).toBe('TOKEN_EXPIRED');
  });
});

describe('random tokens and hashing', () => {
  it('are 64 hex characters and never repeat', () => {
    const a = generateSecureToken();
    const b = generateSecureToken();
    expect(a).toMatch(/^[a-f0-9]{64}$/);
    expect(a).not.toBe(b);
  });

  it('hash to the same value every time, and never to the original', () => {
    const token = generateSecureToken();
    expect(hashToken(token)).toBe(hashToken(token));
    expect(hashToken(token)).toMatch(/^[a-f0-9]{64}$/);
    expect(hashToken(token)).not.toBe(token);
    expect(hashToken('a')).not.toBe(hashToken('b'));
  });

  it('are compared safely', () => {
    expect(safeEqual('abc', 'abc')).toBe(true);
    expect(safeEqual('abc', 'abd')).toBe(false);
    expect(safeEqual('abc', 'abcd')).toBe(false);
  });
});