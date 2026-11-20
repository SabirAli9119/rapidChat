import { describe, expect, it } from 'vitest';
import { buildParticipantKey } from '../../src/models/ChatRoom.model';
import { notExpiredFilter } from '../../src/models/Message.model';
import { describeDevice } from '../../src/services/auth.service';
import { visiblePresence } from '../../src/services/privacy.service';
import { FixedWindowLimiter } from '../../src/sockets/rateLimiter';
import { ApiError } from '../../src/utils/ApiError';
import { buildPageResult, escapeRegex, isDuplicateKeyError, skipFor } from '../../src/utils/db';

describe('ApiError', () => {
  it('has a helper for every status the API uses', () => {
    expect(ApiError.badRequest().statusCode).toBe(400);
    expect(ApiError.unauthorized().statusCode).toBe(401);
    expect(ApiError.forbidden().statusCode).toBe(403);
    expect(ApiError.notFound().statusCode).toBe(404);
    expect(ApiError.conflict().statusCode).toBe(409);
    expect(ApiError.gone().statusCode).toBe(410);
    expect(ApiError.payloadTooLarge().statusCode).toBe(413);
    expect(ApiError.unprocessable().statusCode).toBe(422);
    expect(ApiError.tooManyRequests().statusCode).toBe(429);
    expect(ApiError.internal().statusCode).toBe(500);
  });

  it('carries a code and details, and is a real Error', () => {
    const err = ApiError.badRequest('Nope', { code: 'NOPE', details: [{ field: 'a' }] });
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toBe('Nope');
    expect(err.code).toBe('NOPE');
    expect(err.details).toEqual([{ field: 'a' }]);
  });
});

describe('database helpers', () => {
  it('works out which documents to skip', () => {
    expect(skipFor(1, 20)).toBe(0);
    expect(skipFor(3, 20)).toBe(40);
  });

  it('builds a page result', () => {
    expect(buildPageResult(['a', 'b'], 45, 2, 20)).toEqual({ items: ['a', 'b'], page: 2, limit: 20, total: 45, totalPages: 3 });
    expect(buildPageResult([], 0, 1, 20).totalPages).toBe(0);
  });

  it('escapes search text so it can never act as a pattern', () => {
    expect(escapeRegex('a.b*c(d)')).toBe('a\\.b\\*c\\(d\\)');
    expect(new RegExp(escapeRegex('a.b')).test('axb')).toBe(false);
    expect(new RegExp(escapeRegex('a.b')).test('a.b')).toBe(true);
    expect(new RegExp(escapeRegex('.*'), 'i').test('anything')).toBe(false);
  });

  it('recognises duplicate-key errors', () => {
    expect(isDuplicateKeyError({ code: 11000 })).toBe(true);
    expect(isDuplicateKeyError(new Error('x'))).toBe(false);
    expect(isDuplicateKeyError(null)).toBe(false);
  });

  it('builds the same room key whichever user comes first', () => {
    expect(buildParticipantKey('b', 'a')).toBe('a:b');
    expect(buildParticipantKey('a', 'b')).toBe('a:b');
  });

  it('filters out messages whose time is up', () => {
    const filter = notExpiredFilter();
    expect(filter.expiresAt.$gt).toBeInstanceOf(Date);
    expect(Math.abs(filter.expiresAt.$gt.getTime() - Date.now())).toBeLessThan(1000);
  });
});

describe('online status privacy', () => {
  const seen = new Date('2026-01-01T10:00:00.000Z');

  it('shows what the person allows', () => {
    expect(visiblePresence({ isOnline: true, lastSeenAt: seen }, { showOnlineStatus: true, showLastSeen: false })).toEqual({
      isOnline: true,
      lastSeenAt: null,
    });
    expect(visiblePresence({ isOnline: false, lastSeenAt: seen }, { showOnlineStatus: true, showLastSeen: true })).toEqual({
      isOnline: false,
      lastSeenAt: '2026-01-01T10:00:00.000Z',
    });
  });

  it('shows null (hidden), not "offline", when the person hides their status', () => {
    expect(visiblePresence({ isOnline: true, lastSeenAt: seen }, { showOnlineStatus: false, showLastSeen: false })).toEqual({
      isOnline: null,
      lastSeenAt: null,
    });
  });

  it('shows no last-seen time when there is none', () => {
    expect(visiblePresence({ isOnline: false, lastSeenAt: null }, { showOnlineStatus: true, showLastSeen: true }).lastSeenAt).toBeNull();
  });
});

describe('device names for the session list', () => {
  it.each([
    [null, 'Unknown device'],
    ['curl/8.0', 'Unknown device'],
    ['PostmanRuntime/7.36.0', 'Postman'],
    ['Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36', 'Chrome on Windows'],
    ['Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36 Edg/120.0', 'Edge on Windows'],
    ['Mozilla/5.0 (X11; Linux x86_64; rv:109.0) Gecko/20100101 Firefox/115.0', 'Firefox on Linux'],
    ['Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1', 'Safari on iOS'],
    ['Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15', 'Safari on macOS'],
    ['Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Mobile Safari/537.36', 'Chrome on Android'],
  ])('describes %s', (userAgent, expected) => {
    expect(describeDevice(userAgent)).toBe(expected);
  });
});

describe('the send-speed limiter used by sockets', () => {
  it('allows a number of actions per window, then refuses with a retry time', () => {
    const limiter = new FixedWindowLimiter(2, 1000);
    expect(limiter.consume('a', 0)).toEqual({ allowed: true, retryAfterMs: 0 });
    expect(limiter.consume('a', 10).allowed).toBe(true);
    expect(limiter.consume('a', 20)).toEqual({ allowed: false, retryAfterMs: 980 });
  });

  it('counts every key separately', () => {
    const limiter = new FixedWindowLimiter(1, 1000);
    expect(limiter.consume('a', 0).allowed).toBe(true);
    expect(limiter.consume('a', 1).allowed).toBe(false);
    expect(limiter.consume('b', 1).allowed).toBe(true);
  });

  it('starts a fresh window when the time is up', () => {
    const limiter = new FixedWindowLimiter(1, 1000);
    limiter.consume('a', 0);
    expect(limiter.consume('a', 999).allowed).toBe(false);
    expect(limiter.consume('a', 1000).allowed).toBe(true);
  });
});