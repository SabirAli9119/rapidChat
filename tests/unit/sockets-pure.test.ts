import { describe, expect, it } from 'vitest';
import { isAllowedOrigin } from '../../src/sockets';
import { extractSocketToken, isSessionProblem } from '../../src/sockets/socketAuth';

describe('where a socket takes its login token from', () => {
  it('reads the handshake auth first', () => {
    expect(
      extractSocketToken({
        headers: { authorization: 'Bearer from-header', cookie: 'access_token=from-cookie' },
        auth: { token: 'from-auth' },
      }),
    ).toBe('from-auth');
  });

  it('then the Authorization header', () => {
    expect(extractSocketToken({ headers: { authorization: 'Bearer from-header', cookie: 'access_token=from-cookie' }, auth: {} })).toBe('from-header');
  });

  it('then the login cookie, among other cookies', () => {
    expect(extractSocketToken({ headers: { cookie: 'theme=dark; access_token=abc.def; other=1' }, auth: {} })).toBe('abc.def');
  });

  it('decodes encoded cookie values', () => {
    expect(extractSocketToken({ headers: { cookie: 'access_token=abc%2Bdef' }, auth: {} })).toBe('abc+def');
  });

  it('finds nothing when there is nothing', () => {
    expect(extractSocketToken({ headers: {}, auth: {} })).toBeNull();
    expect(extractSocketToken({ headers: { authorization: 'Bearer ' }, auth: { token: '' } })).toBeNull();
    expect(extractSocketToken({ headers: { authorization: 'Basic abc' }, auth: {} })).toBeNull();
  });
});

describe('session problems', () => {
  it('knows the four reasons a connection must be ended', () => {
    for (const code of ['SESSION_INVALID', 'USER_NOT_FOUND', 'ACCOUNT_BANNED', 'ACCOUNT_SUSPENDED']) {
      expect(isSessionProblem(code)).toBe(true);
    }
    expect(isSessionProblem('RATE_LIMITED')).toBe(false);
    expect(isSessionProblem('toString')).toBe(false);
  });
});

describe('which websites may open a chat connection', () => {
  it('allows your frontend and clients that send no Origin (apps, scripts)', () => {
    expect(isAllowedOrigin('http://localhost:5173')).toBe(true);
    expect(isAllowedOrigin(undefined)).toBe(true);
  });

  it('refuses every other website', () => {
    expect(isAllowedOrigin('http://evil.example')).toBe(false);
    expect(isAllowedOrigin('null')).toBe(false);
    expect(isAllowedOrigin('http://localhost:5174')).toBe(false);
  });
});