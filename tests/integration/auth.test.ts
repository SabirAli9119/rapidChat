import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../../src/app';
import { AdminAuditLog } from '../../src/models/AdminAuditLog.model';
import { EmailVerificationToken } from '../../src/models/EmailVerificationToken.model';
import { RefreshToken } from '../../src/models/RefreshToken.model';
import { Session } from '../../src/models/Session.model';
import { User } from '../../src/models/User.model';
import { generateSecureToken, verifyRefreshToken } from '../../src/utils/token';
import { clearDb, connectTestDb, disconnectTestDb } from '../helpers/db';
import { V1, cookieOf, cookieValue, errorFields, isCleared } from '../helpers/http';
import { sleep, waitUntil } from '../helpers/wait';

// Emails are captured here instead of being sent
const mail = vi.hoisted(() => ({
  verification: [] as { to: string; name: string; token: string }[],
  reset: [] as { to: string; name: string; token: string }[],
  changed: [] as { to: string }[],
}));

vi.mock('../../src/services/email.service', () => ({
  sendVerificationEmail: async (to: string, name: string, token: string) => {
    mail.verification.push({ to, name, token });
    return true;
  },
  sendPasswordResetEmail: async (to: string, name: string, token: string) => {
    mail.reset.push({ to, name, token });
    return true;
  },
  sendPasswordChangedEmail: async (to: string) => {
    mail.changed.push({ to });
    return true;
  },
}));

const app = createApp();
const PASSWORD = 'Sup3rSecret99';
const NEW_PASSWORD = 'Brand9NewPassword';
const WRONG = 'wrong-password-1';

beforeAll(connectTestDb);
afterAll(disconnectTestDb);
beforeEach(async () => {
  await clearDb();
  mail.verification.length = 0;
  mail.reset.length = 0;
  mail.changed.length = 0;
});

const register = (username: string, extra: Record<string, unknown> = {}) =>
  request(app)
    .post(`${V1}/auth/register`)
    .send({ username, email: `${username}@example.com`, password: PASSWORD, displayName: username, ...extra });

const login = (identifier: string, password = PASSWORD) =>
  request(app).post(`${V1}/auth/login`).send({ identifier, password });

/** Registers, confirms the email through the emailed link, and logs in with a cookie-keeping agent. */
async function signUp(username: string) {
  const agent = request.agent(app);
  expect((await register(username)).status).toBe(201);
  const { token } = mail.verification[mail.verification.length - 1];
  expect((await request(app).post(`${V1}/auth/verify-email`).send({ token })).status).toBe(200);
  const res = await agent.post(`${V1}/auth/login`).send({ identifier: username, password: PASSWORD });
  expect(res.status).toBe(200);
  return { agent, id: res.body.data.user.id as string, loginResponse: res };
}

describe('registration', () => {
  it('creates an account with a cleaned-up name and email', async () => {
    const res = await register(' Alice ', { email: ' Alice@Example.com ', role: 'admin' });

    expect(res.status).toBe(201);
    expect(res.body.data.user).toMatchObject({ username: 'alice', email: 'alice@example.com', role: 'user', emailVerified: false });
    expect(JSON.stringify(res.body)).not.toContain('passwordHash');
  });

  it('stores only an Argon2id hash of the password', async () => {
    await register('alice');
    const stored = await User.findOne({ username: 'alice' }).select('+passwordHash').lean();
    expect(stored?.passwordHash.startsWith('$argon2id$')).toBe(true);
    expect(stored?.passwordHash).not.toContain(PASSWORD);
  });

  it('emails a verification link', async () => {
    await register('alice');
    expect(mail.verification).toHaveLength(1);
    expect(mail.verification[0].to).toBe('alice@example.com');
    expect(mail.verification[0].token).toMatch(/^[a-f0-9]{64}$/);
  });

  it('refuses a taken username or email', async () => {
    await register('alice');

    const sameName = await register('alice', { email: 'other@example.com' });
    expect(sameName.status).toBe(409);
    expect(sameName.body.code).toBe('USERNAME_TAKEN');

    const sameEmail = await register('alice2', { email: 'alice@example.com' });
    expect(sameEmail.status).toBe(409);
    expect(sameEmail.body.code).toBe('EMAIL_TAKEN');
  });

  it('lists every problem in an invalid request', async () => {
    const res = await request(app)
      .post(`${V1}/auth/register`)
      .send({ username: 'bad name', email: 'nope', password: 'short', displayName: '' });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
    expect(errorFields(res)).toEqual(expect.arrayContaining(['body.username', 'body.email', 'body.password', 'body.displayName']));
  });
});

describe('email verification', () => {
  it('verifies an address once, with the emailed token', async () => {
    await register('alice');
    const { token } = mail.verification[0];

    const first = await request(app).post(`${V1}/auth/verify-email`).send({ token });
    expect(first.status).toBe(200);
    expect(first.body.data.user.emailVerified).toBe(true);

    const second = await request(app).post(`${V1}/auth/verify-email`).send({ token });
    expect(second.status).toBe(400);
    expect(second.body.code).toBe('INVALID_VERIFICATION_TOKEN');
  });

  it('refuses unknown and malformed tokens', async () => {
    const unknown = await request(app).post(`${V1}/auth/verify-email`).send({ token: generateSecureToken() });
    expect(unknown.body.code).toBe('INVALID_VERIFICATION_TOKEN');

    const malformed = await request(app).post(`${V1}/auth/verify-email`).send({ token: 'abc' });
    expect(malformed.status).toBe(400);
    expect(malformed.body.code).toBe('VALIDATION_ERROR');
  });

  it('refuses an expired token', async () => {
    await register('alice');
    await EmailVerificationToken.collection.updateMany({}, { $set: { expiresAt: new Date(Date.now() - 1000) } });
    const res = await request(app).post(`${V1}/auth/verify-email`).send({ token: mail.verification[0].token });
    expect(res.body.code).toBe('INVALID_VERIFICATION_TOKEN');
  });

  it('lets an unverified user ask for a new link, but only once a minute, and the old link then dies', async () => {
    await register('carol');
    const agent = request.agent(app);
    expect((await agent.post(`${V1}/auth/login`).send({ identifier: 'carol', password: PASSWORD })).status).toBe(200);

    const tooSoon = await agent.post(`${V1}/auth/resend-verification`);
    expect(tooSoon.status).toBe(429);
    expect(tooSoon.body.code).toBe('EMAIL_COOLDOWN');

    await EmailVerificationToken.collection.updateMany({}, { $set: { createdAt: new Date(Date.now() - 5 * 60_000) } });
    expect((await agent.post(`${V1}/auth/resend-verification`)).status).toBe(200);
    expect(mail.verification).toHaveLength(2);

    const oldLink = await request(app).post(`${V1}/auth/verify-email`).send({ token: mail.verification[0].token });
    expect(oldLink.body.code).toBe('INVALID_VERIFICATION_TOKEN');
    const newLink = await request(app).post(`${V1}/auth/verify-email`).send({ token: mail.verification[1].token });
    expect(newLink.status).toBe(200);
  });

  it('does not resend to an address that is already verified', async () => {
    const { agent } = await signUp('alice');
    const res = await agent.post(`${V1}/auth/resend-verification`);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('ALREADY_VERIFIED');
  });
});

describe('login', () => {
  it('answers a wrong password and an unknown account in exactly the same way', async () => {
    await register('alice');
    const wrong = await login('alice', WRONG);
    const unknown = await login('nobody', WRONG);

    expect(wrong.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(wrong.body).toEqual(unknown.body);
    expect(wrong.body.code).toBe('INVALID_CREDENTIALS');
  });

  it('logs in with a username or an email, in any capitalisation', async () => {
    await register('alice');
    expect((await login('ALICE')).status).toBe(200);
    expect((await login('Alice@Example.com')).status).toBe(200);
  });

  it('lets unverified users log in (so they can ask for a new link)', async () => {
    await register('alice');
    const res = await login('alice');
    expect(res.status).toBe(200);
    expect(res.body.data.user.emailVerified).toBe(false);
  });

  it('sets two HttpOnly cookies and never puts a token in the response body', async () => {
    await register('alice');
    const res = await login('alice');
    const access = cookieOf(res, 'access_token') ?? '';
    const refresh = cookieOf(res, 'refresh_token') ?? '';

    expect(access).toMatch(/HttpOnly/i);
    expect(refresh).toMatch(/HttpOnly/i);
    expect(access).toMatch(/SameSite=Lax/i);
    expect(access).toMatch(/Max-Age=900(;|$)/);
    expect(access).toMatch(/Path=\/(;|$)/);
    expect(refresh).toMatch(/Max-Age=604800(;|$)/);
    expect(refresh).toMatch(/Path=\/api\/v1\/auth(;|$)/);
    expect(access).not.toMatch(/;\s*Secure/i); // only production requires https
    expect(JSON.stringify(res.body)).not.toMatch(/token/i);
  });

  it('authenticates later requests with the cookies or with a Bearer header', async () => {
    const { agent, loginResponse } = await signUp('alice');

    const withCookies = await agent.get(`${V1}/users/me`);
    expect(withCookies.status).toBe(200);
    expect(withCookies.body.data.user.username).toBe('alice');

    const accessToken = cookieValue(loginResponse, 'access_token');
    const withHeader = await request(app).get(`${V1}/users/me`).set('Authorization', `Bearer ${accessToken}`);
    expect(withHeader.status).toBe(200);

    const nothing = await request(app).get(`${V1}/users/me`);
    expect(nothing.status).toBe(401);
    expect(nothing.body.code).toBe('NO_TOKEN');
  });

  it('refuses a banned account after the right password, and says nothing special after a wrong one', async () => {
    await register('baddie');
    await User.updateOne({ username: 'baddie' }, { $set: { status: 'banned' } });

    const right = await login('baddie');
    expect(right.status).toBe(403);
    expect(right.body.code).toBe('ACCOUNT_BANNED');

    const wrong = await login('baddie', WRONG);
    expect(wrong.status).toBe(401);
    expect(wrong.body.code).toBe('INVALID_CREDENTIALS');
  });

  it('locks an account for 15 minutes after 5 wrong passwords, even for the right password', async () => {
    await register('lockme');
    for (let attempt = 1; attempt <= 5; attempt++) {
      const res = await login('lockme', WRONG);
      expect(res.status).toBe(401);
    }

    const locked = await login('lockme');
    expect(locked.status).toBe(429);
    expect(locked.body.code).toBe('ACCOUNT_LOCKED');
    expect(locked.body.details.retryAfterSeconds).toBeGreaterThan(0);
    expect(await AdminAuditLog.countDocuments({ action: 'security.login_failed' })).toBe(5);

    await User.updateOne({ username: 'lockme' }, { $set: { lockUntil: new Date(Date.now() - 1000) } });
    expect((await login('lockme')).status).toBe(200);
  });
});

describe('refresh tokens', () => {
  it('give a new pair each time, and the user stays logged in', async () => {
    const { agent, loginResponse } = await signUp('alice');
    const oldRefresh = cookieValue(loginResponse, 'refresh_token');

    const res = await agent.post(`${V1}/auth/refresh`);
    expect(res.status).toBe(200);
    expect(cookieValue(res, 'refresh_token')).toBeTruthy();
    expect(cookieValue(res, 'refresh_token')).not.toBe(oldRefresh);
    expect((await agent.get(`${V1}/users/me`)).status).toBe(200);
  });

  it('survive two tabs refreshing at once (the old token, just used, is not treated as theft)', async () => {
    const { agent, loginResponse } = await signUp('alice');
    const oldRefresh = cookieValue(loginResponse, 'refresh_token');
    await agent.post(`${V1}/auth/refresh`);

    const replay = await request(app).post(`${V1}/auth/refresh`).set('Cookie', [`refresh_token=${oldRefresh}`]);
    expect(replay.status).toBe(401);
    expect(replay.body.code).toBe('REFRESH_IN_PROGRESS');
    expect((await agent.get(`${V1}/users/me`)).status).toBe(200); // the session is untouched
  });

  it('end the whole session when an old token is replayed later (theft)', async () => {
    const { agent, loginResponse } = await signUp('alice');
    const oldRefresh = cookieValue(loginResponse, 'refresh_token') ?? '';
    await agent.post(`${V1}/auth/refresh`);

    // Pretend the old token was used a minute ago
    await RefreshToken.collection.updateOne({ jti: verifyRefreshToken(oldRefresh).jti }, { $set: { usedAt: new Date(Date.now() - 60_000) } });

    const replay = await request(app).post(`${V1}/auth/refresh`).set('Cookie', [`refresh_token=${oldRefresh}`]);
    expect(replay.status).toBe(401);
    expect(replay.body.code).toBe('TOKEN_REUSED');
    expect(await AdminAuditLog.countDocuments({ action: 'security.token_reuse_detected' })).toBe(1);

    const afterTheft = await agent.get(`${V1}/users/me`);
    expect(afterTheft.status).toBe(401);
    expect(afterTheft.body.code).toBe('SESSION_INVALID');

    const newestToken = await agent.post(`${V1}/auth/refresh`);
    expect(newestToken.status).toBe(401);
    expect(newestToken.body.code).toBe('INVALID_TOKEN');
  });

  it('refuse missing and garbage cookies, and clear the garbage ones', async () => {
    const none = await request(app).post(`${V1}/auth/refresh`);
    expect(none.status).toBe(401);
    expect(none.body.code).toBe('NO_REFRESH_TOKEN');

    const garbage = await request(app).post(`${V1}/auth/refresh`).set('Cookie', ['refresh_token=garbage']);
    expect(garbage.status).toBe(401);
    expect(garbage.body.code).toBe('INVALID_TOKEN');
    expect(isCleared(garbage, 'access_token')).toBe(true);
    expect(isCleared(garbage, 'refresh_token')).toBe(true);
  });
});

describe('logout and sessions', () => {
  it('logs out, clears both cookies, and ends the session', async () => {
    const { agent } = await signUp('alice');
    const res = await agent.post(`${V1}/auth/logout`);

    expect(res.status).toBe(200);
    expect(isCleared(res, 'access_token')).toBe(true);
    expect(isCleared(res, 'refresh_token')).toBe(true);
    const after = await agent.get(`${V1}/users/me`);
    expect(after.status).toBe(401);
    expect(await Session.countDocuments({ revokedAt: null })).toBe(0);
  });

  it('always succeeds, even with no cookies at all', async () => {
    expect((await request(app).post(`${V1}/auth/logout`)).status).toBe(200);
  });

  it('works with only a Bearer access token, and ends that session', async () => {
    const { loginResponse } = await signUp('alice');
    const token = cookieValue(loginResponse, 'access_token');

    expect((await request(app).post(`${V1}/auth/logout`).set('Authorization', `Bearer ${token}`)).status).toBe(200);
    const after = await request(app).get(`${V1}/users/me`).set('Authorization', `Bearer ${token}`);
    expect(after.status).toBe(401);
    expect(after.body.code).toBe('SESSION_INVALID');
  });

  it('lists devices, and ends one device without touching the others', async () => {
    const { agent: laptop } = await signUp('alice');
    const phone = request.agent(app);
    await phone.post(`${V1}/auth/login`).send({ identifier: 'alice', password: PASSWORD });

    const list = await laptop.get(`${V1}/auth/sessions`);
    expect(list.status).toBe(200);
    expect(list.body.data).toHaveLength(2);
    expect(list.body.data.filter((s: { current: boolean }) => s.current)).toHaveLength(1);

    const other = list.body.data.find((s: { current: boolean }) => !s.current);
    expect((await laptop.delete(`${V1}/auth/sessions/${other.id}`)).status).toBe(200);

    const phoneAfter = await phone.get(`${V1}/users/me`);
    expect(phoneAfter.status).toBe(401);
    expect(phoneAfter.body.code).toBe('SESSION_INVALID');
    expect((await laptop.get(`${V1}/users/me`)).status).toBe(200);
  });

  it('can log out every other device at once', async () => {
    const { agent: laptop } = await signUp('alice');
    const phone = request.agent(app);
    const tablet = request.agent(app);
    await phone.post(`${V1}/auth/login`).send({ identifier: 'alice', password: PASSWORD });
    await tablet.post(`${V1}/auth/login`).send({ identifier: 'alice', password: PASSWORD });

    const res = await laptop.delete(`${V1}/auth/sessions`);
    expect(res.status).toBe(200);
    expect(res.body.data.sessionsRevoked).toBe(2);
    expect((await phone.get(`${V1}/users/me`)).status).toBe(401);
    expect((await tablet.get(`${V1}/users/me`)).status).toBe(401);
    expect((await laptop.get(`${V1}/users/me`)).status).toBe(200);
  });

  it('only ever lets people end their own sessions', async () => {
    const { agent } = await signUp('alice');
    expect((await agent.delete(`${V1}/auth/sessions/${'a'.repeat(24)}`)).status).toBe(404);
    expect((await agent.delete(`${V1}/auth/sessions/xyz`)).status).toBe(400);
  });

  it('clears the cookies when someone ends their own current session', async () => {
    const { agent } = await signUp('alice');
    const list = await agent.get(`${V1}/auth/sessions`);
    const mine = list.body.data.find((s: { current: boolean }) => s.current);

    const res = await agent.delete(`${V1}/auth/sessions/${mine.id}`);
    expect(res.status).toBe(200);
    expect(isCleared(res, 'access_token')).toBe(true);
  });
});

describe('changing a password', () => {
  it('needs the current password, and a different new one', async () => {
    const { agent } = await signUp('alice');

    const wrong = await agent.post(`${V1}/auth/change-password`).send({ currentPassword: WRONG, newPassword: NEW_PASSWORD });
    expect(wrong.status).toBe(403);
    expect(wrong.body.code).toBe('INVALID_PASSWORD');

    const same = await agent.post(`${V1}/auth/change-password`).send({ currentPassword: PASSWORD, newPassword: PASSWORD });
    expect(same.status).toBe(400);
    expect(same.body.code).toBe('VALIDATION_ERROR');
  });

  it('keeps this device logged in, logs the others out, and tells the owner', async () => {
    const { agent: laptop } = await signUp('alice');
    const phone = request.agent(app);
    await phone.post(`${V1}/auth/login`).send({ identifier: 'alice', password: PASSWORD });

    const res = await laptop.post(`${V1}/auth/change-password`).send({ currentPassword: PASSWORD, newPassword: NEW_PASSWORD });
    expect(res.status).toBe(200);

    expect((await laptop.get(`${V1}/users/me`)).status).toBe(200);
    const phoneAfter = await phone.get(`${V1}/users/me`);
    expect(phoneAfter.status).toBe(401);
    expect(phoneAfter.body.code).toBe('SESSION_INVALID');

    expect((await login('alice', PASSWORD)).status).toBe(401);
    expect((await login('alice', NEW_PASSWORD)).status).toBe(200);
    expect(mail.changed).toEqual([{ to: 'alice@example.com' }]);
  });
});

describe('resetting a forgotten password', () => {
  it('emails a reset link for a known address', async () => {
    await register('frank');
    const res = await request(app).post(`${V1}/auth/forgot-password`).send({ email: 'frank@example.com' });

    expect(res.status).toBe(200);
    expect(await waitUntil(() => mail.reset.length === 1)).toBe(true);
    expect(mail.reset[0].to).toBe('frank@example.com');
    expect(mail.reset[0].token).toMatch(/^[a-f0-9]{64}$/);
  });

  it('answers an unknown address identically, and sends nothing', async () => {
    await register('frank');
    const known = await request(app).post(`${V1}/auth/forgot-password`).send({ email: 'frank@example.com' });
    const unknown = await request(app).post(`${V1}/auth/forgot-password`).send({ email: 'nobody@example.com' });

    expect(unknown.status).toBe(known.status);
    expect(unknown.body).toEqual(known.body);
    await waitUntil(() => mail.reset.length === 1);
    await sleep(300);
    expect(mail.reset).toHaveLength(1); // only for the known address
  });

  it('sets a new password with the link, logs out every device, and works once', async () => {
    const { agent } = await signUp('frank');
    await request(app).post(`${V1}/auth/forgot-password`).send({ email: 'frank@example.com' });
    await waitUntil(() => mail.reset.length === 1);
    const { token } = mail.reset[0];

    const res = await request(app).post(`${V1}/auth/reset-password`).send({ token, newPassword: NEW_PASSWORD });
    expect(res.status).toBe(200);
    expect(isCleared(res, 'access_token')).toBe(true);

    const oldDevice = await agent.get(`${V1}/users/me`);
    expect(oldDevice.status).toBe(401);
    expect(oldDevice.body.code).toBe('SESSION_INVALID');
    expect((await login('frank', PASSWORD)).status).toBe(401);
    expect((await login('frank', NEW_PASSWORD)).status).toBe(200);

    const again = await request(app).post(`${V1}/auth/reset-password`).send({ token, newPassword: 'Another9Password' });
    expect(again.status).toBe(400);
    expect(again.body.code).toBe('INVALID_RESET_TOKEN');
  });

  it('does not use up the link when the new password is rejected', async () => {
    await register('frank');
    await request(app).post(`${V1}/auth/forgot-password`).send({ email: 'frank@example.com' });
    await waitUntil(() => mail.reset.length === 1);
    const { token } = mail.reset[0];

    const weak = await request(app).post(`${V1}/auth/reset-password`).send({ token, newPassword: 'Frank12345!!' });
    expect(weak.status).toBe(400);
    expect(weak.body.code).toBe('WEAK_PASSWORD');

    const good = await request(app).post(`${V1}/auth/reset-password`).send({ token, newPassword: NEW_PASSWORD });
    expect(good.status).toBe(200);
  });

  it('refuses malformed and unknown tokens', async () => {
    const malformed = await request(app).post(`${V1}/auth/reset-password`).send({ token: 'zzz', newPassword: NEW_PASSWORD });
    expect(malformed.body.code).toBe('VALIDATION_ERROR');

    const unknown = await request(app).post(`${V1}/auth/reset-password`).send({ token: generateSecureToken(), newPassword: NEW_PASSWORD });
    expect(unknown.body.code).toBe('INVALID_RESET_TOKEN');
  });
});