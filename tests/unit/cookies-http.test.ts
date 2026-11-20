import type { Response } from 'express';
import { describe, expect, it } from 'vitest';
import { ACCESS_COOKIE_NAME, REFRESH_COOKIE_NAME, clearAuthCookies, setAuthCookies } from '../../src/utils/cookies';
import { buildContentDisposition } from '../../src/utils/http';

type Options = Record<string, unknown>;

function fakeResponse() {
  const set: { name: string; value: string; options: Options }[] = [];
  const cleared: { name: string; options: Options }[] = [];
  const res = {
    cookie: (name: string, value: string, options: Options) => {
      set.push({ name, value, options });
    },
    clearCookie: (name: string, options: Options) => {
      cleared.push({ name, options });
    },
  } as unknown as Response;
  return { res, set, cleared };
}

describe('auth cookies', () => {
  it('are HttpOnly and SameSite=Lax', () => {
    const { res, set } = fakeResponse();
    setAuthCookies(res, { accessToken: 'access-value', refreshToken: 'refresh-value' });

    expect(set.map((c) => c.name)).toEqual([ACCESS_COOKIE_NAME, REFRESH_COOKIE_NAME]);
    for (const cookie of set) {
      expect(cookie.options.httpOnly).toBe(true);
      expect(cookie.options.sameSite).toBe('lax');
      expect(cookie.options.secure).toBe(false); // only production requires https
      expect('domain' in cookie.options).toBe(false); // no COOKIE_DOMAIN configured
    }
  });

  it('give the access cookie 15 minutes for the whole site', () => {
    const { res, set } = fakeResponse();
    setAuthCookies(res, { accessToken: 'a', refreshToken: 'r' });

    expect(set[0].value).toBe('a');
    expect(set[0].options.path).toBe('/');
    expect(set[0].options.maxAge).toBe(15 * 60 * 1000);
  });

  it('give the refresh cookie 7 days, sent only to the auth endpoints', () => {
    const { res, set } = fakeResponse();
    setAuthCookies(res, { accessToken: 'a', refreshToken: 'r' });

    expect(set[1].value).toBe('r');
    expect(set[1].options.path).toBe('/api/v1/auth');
    expect(set[1].options.maxAge).toBe(7 * 24 * 60 * 60 * 1000);
  });

  it('are cleared with the same path they were set with', () => {
    const { res, cleared } = fakeResponse();
    clearAuthCookies(res);

    expect(cleared.map((c) => c.name)).toEqual([ACCESS_COOKIE_NAME, REFRESH_COOKIE_NAME]);
    expect(cleared[0].options.path).toBe('/');
    expect(cleared[1].options.path).toBe('/api/v1/auth');
    expect(cleared.every((c) => c.options.httpOnly === true)).toBe(true);
  });
});

describe('Content-Disposition for downloads', () => {
  it('shows images, video and audio inline, and downloads documents', () => {
    expect(buildContentDisposition('image', 'a.png')).toMatch(/^inline;/);
    expect(buildContentDisposition('video', 'a.mp4')).toMatch(/^inline;/);
    expect(buildContentDisposition('audio', 'a.mp3')).toMatch(/^inline;/);
    expect(buildContentDisposition('document', 'a.pdf')).toMatch(/^attachment;/);
  });

  it('keeps the real name for modern browsers and a safe fallback for old ones', () => {
    expect(buildContentDisposition('document', 'résumé "final".txt')).toBe(
      `attachment; filename="r_sum_ _final_.txt"; filename*=UTF-8''r%C3%A9sum%C3%A9%20%22final%22.txt`,
    );
    expect(buildContentDisposition('image', "it's (1).png")).toBe(
      `inline; filename="it_s _1_.png"; filename*=UTF-8''it%27s%20%281%29.png`,
    );
  });

  it('cannot be used to inject another header', () => {
    const header = buildContentDisposition('video', 'x\r\nSet-Cookie: a=b');
    expect(header).not.toMatch(/[\r\n]/);
    expect(header).toContain('%0D%0ASet-Cookie');
  });

  it('shortens very long names and falls back to "file" for empty ones', () => {
    const long = buildContentDisposition('document', `${'a'.repeat(300)}.txt`);
    expect(long.split('filename="')[1].split('"')[0].length).toBeLessThanOrEqual(100);
    expect(buildContentDisposition('image', '')).toContain('filename="file"');
  });
});