import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app';
import { BlockedUser } from '../../src/models/BlockedUser.model';
import { ChatRoom } from '../../src/models/ChatRoom.model';
import { Location } from '../../src/models/Location.model';
import { Message } from '../../src/models/Message.model';
import { Notification } from '../../src/models/Notification.model';
import { PrivacySettings } from '../../src/models/PrivacySettings.model';
import { Session } from '../../src/models/Session.model';
import { User } from '../../src/models/User.model';
import { hashPassword } from '../../src/services/auth.service';
import { clearDb, connectTestDb, disconnectTestDb } from '../helpers/db';
import { bearer, createRoom, createUser, setPrivacy } from '../helpers/factory';
import { installFakeStorage, type FakeStorage } from '../helpers/fakes';
import { V1 } from '../helpers/http';

const app = createApp();
const PASSWORD = 'Sup3rSecret99';
const jpeg = Buffer.concat([
  Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01]),
  Buffer.alloc(100),
]);

let storage: FakeStorage;

beforeAll(async () => {
  storage = installFakeStorage();
  await connectTestDb();
});
afterAll(async () => {
  storage.restore();
  await disconnectTestDb();
});
beforeEach(async () => {
  await clearDb();
  storage.files.clear();
  storage.failUploads = false;
});

describe('your own profile', () => {
  it('shows your account, without the password hash', async () => {
    const alice = await createUser('alice');
    const res = await request(app).get(`${V1}/users/me`).set(bearer(alice));

    expect(res.status).toBe(200);
    expect(res.body.data.user).toMatchObject({ username: 'alice', email: 'alice@example.com', role: 'user', emailVerified: true });
    expect(JSON.stringify(res.body)).not.toContain('passwordHash');
  });

  it('updates the display name and bio, and ignores fields it does not know', async () => {
    const alice = await createUser('alice');
    const res = await request(app)
      .patch(`${V1}/users/me`)
      .set(bearer(alice))
      .send({ displayName: '  Alice A.  ', bio: 'Hello', role: 'admin' });

    expect(res.status).toBe(200);
    expect(res.body.data.user).toMatchObject({ displayName: 'Alice A.', bio: 'Hello', role: 'user' });
    expect((await User.findById(alice.id).lean())?.role).toBe('user');
  });

  it('refuses an empty update', async () => {
    const alice = await createUser('alice');
    const res = await request(app).patch(`${V1}/users/me`).set(bearer(alice)).send({});
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });
});

describe('privacy settings', () => {
  it('start private: nobody can find you until you opt in', async () => {
    const alice = await createUser('alice');
    const res = await request(app).get(`${V1}/privacy`).set(bearer(alice));
    expect(res.body.data.settings).toEqual({
      nearbyDiscoverable: false,
      showOnlineStatus: true,
      showLastSeen: false,
      allowNewChats: true,
    });
  });

  it('can be changed, but not with an empty or non-boolean request', async () => {
    const alice = await createUser('alice');

    const empty = await request(app).patch(`${V1}/privacy`).set(bearer(alice)).send({});
    expect(empty.status).toBe(400);
    const text = await request(app).patch(`${V1}/privacy`).set(bearer(alice)).send({ nearbyDiscoverable: 'true' });
    expect(text.status).toBe(400);

    const res = await request(app).patch(`${V1}/privacy`).set(bearer(alice)).send({ nearbyDiscoverable: true, showLastSeen: true });
    expect(res.status).toBe(200);
    expect(res.body.data.settings).toMatchObject({ nearbyDiscoverable: true, showLastSeen: true, showOnlineStatus: true });
  });

  it('delete your stored location the moment you opt out of discovery', async () => {
    const bob = await createUser('bob');
    await setPrivacy(bob.id, { nearbyDiscoverable: true });
    await Location.create({ userId: bob.id, location: { type: 'Point', coordinates: [77.2, 28.6] }, expiresAt: new Date(Date.now() + 600_000) });

    const res = await request(app).patch(`${V1}/privacy`).set(bearer(bob)).send({ nearbyDiscoverable: false });
    expect(res.status).toBe(200);
    expect(await Location.countDocuments({ userId: bob.id })).toBe(0);
  });
});

describe("other people's profiles", () => {
  it('are hidden (404) until the person opts in to discovery', async () => {
    const alice = await createUser('alice');
    const bob = await createUser('bob');

    const hidden = await request(app).get(`${V1}/users/${bob.id}`).set(bearer(alice));
    expect(hidden.status).toBe(404);
    expect(hidden.body.message).toBe('User not found');

    await setPrivacy(bob.id, { nearbyDiscoverable: true });
    const visible = await request(app).get(`${V1}/users/${bob.id}`).set(bearer(alice));
    expect(visible.status).toBe(200);
    expect(visible.body.data.user).toMatchObject({ username: 'bob', displayName: 'bob', isOnline: false, lastSeenAt: null });
  });

  it('never show an email address or a role', async () => {
    const alice = await createUser('alice');
    const bob = await createUser('bob');
    await setPrivacy(bob.id, { nearbyDiscoverable: true });

    const res = await request(app).get(`${V1}/users/${bob.id}`).set(bearer(alice));
    expect(Object.keys(res.body.data.user).sort()).toEqual(['avatarUrl', 'bio', 'displayName', 'id', 'isOnline', 'lastSeenAt', 'username']);
  });

  it('are visible to someone you already chat with, even if you are not discoverable', async () => {
    const alice = await createUser('alice');
    const bob = await createUser('bob');
    await createRoom(alice, bob);

    const res = await request(app).get(`${V1}/users/${bob.id}`).set(bearer(alice));
    expect(res.status).toBe(200);
  });

  it('look like "not found" when blocked, banned or deleted', async () => {
    const alice = await createUser('alice');
    const blocked = await createUser('blocked');
    const banned = await createUser('banned', { status: 'banned' });
    const deleted = await createUser('deleted', { deletedAt: new Date() });
    for (const user of [blocked, banned, deleted]) await setPrivacy(user.id, { nearbyDiscoverable: true });
    await BlockedUser.create({ blockerId: blocked.id, blockedId: alice.id });

    for (const user of [blocked, banned, deleted]) {
      const res = await request(app).get(`${V1}/users/${user.id}`).set(bearer(alice));
      expect(res.status).toBe(404);
    }
  });

  it('need a verified email to look at, and a real id', async () => {
    const eve = await createUser('eve', { emailVerified: false });
    const alice = await createUser('alice');

    const unverified = await request(app).get(`${V1}/users/${alice.id}`).set(bearer(eve));
    expect(unverified.status).toBe(403);
    expect(unverified.body.code).toBe('EMAIL_NOT_VERIFIED');

    const malformed = await request(app).get(`${V1}/users/not-an-id`).set(bearer(alice));
    expect(malformed.status).toBe(400);
  });

  it('let you look at your own profile by id', async () => {
    const alice = await createUser('alice');
    const res = await request(app).get(`${V1}/users/${alice.id}`).set(bearer(alice));
    expect(res.status).toBe(200);
  });
});

describe('profile picture', () => {
  it('uploads a real image to public storage and returns its address', async () => {
    const alice = await createUser('alice');
    const res = await request(app).post(`${V1}/users/me/avatar`).set(bearer(alice)).attach('file', jpeg, 'me.jpg');

    expect(res.status).toBe(200);
    expect(String(res.body.data.user.avatarUrl)).toMatch(/^https:\/\/res\.cloudinary\.com\/test-cloud\//);
    expect(storage.files.size).toBe(1);
    expect([...storage.files.keys()][0]).toMatch(/^avatars\//);
  });

  it('replaces the old picture instead of keeping both', async () => {
    const alice = await createUser('alice');
    await request(app).post(`${V1}/users/me/avatar`).set(bearer(alice)).attach('file', jpeg, 'one.jpg');
    await request(app).post(`${V1}/users/me/avatar`).set(bearer(alice)).attach('file', jpeg, 'two.jpg');
    expect(storage.files.size).toBe(1);
  });

  it('removes the picture and deletes the stored file', async () => {
    const alice = await createUser('alice');
    await request(app).post(`${V1}/users/me/avatar`).set(bearer(alice)).attach('file', jpeg, 'me.jpg');

    const res = await request(app).delete(`${V1}/users/me/avatar`).set(bearer(alice));
    expect(res.status).toBe(200);
    expect(res.body.data.user.avatarUrl).toBeNull();
    expect(storage.files.size).toBe(0);
  });

  it('refuses anything that is not really an image, whatever its name says', async () => {
    const alice = await createUser('alice');

    const text = await request(app).post(`${V1}/users/me/avatar`).set(bearer(alice)).attach('file', Buffer.from('hello'), { filename: 'a.txt', contentType: 'text/plain' });
    expect(text.status).toBe(415);
    expect(text.body.code).toBe('FILE_TYPE_NOT_ALLOWED');

    const fake = await request(app).post(`${V1}/users/me/avatar`).set(bearer(alice)).attach('file', Buffer.from('not really an image'), 'fake.jpg');
    expect(fake.status).toBe(415);

    const none = await request(app).post(`${V1}/users/me/avatar`).set(bearer(alice)).field('x', 'y');
    expect(none.status).toBe(400);
    expect(none.body.code).toBe('NO_FILE');
    expect(storage.files.size).toBe(0);
  });

  it('fails cleanly when storage is down, and changes nothing', async () => {
    const alice = await createUser('alice');
    storage.failUploads = true;

    const res = await request(app).post(`${V1}/users/me/avatar`).set(bearer(alice)).attach('file', jpeg, 'me.jpg');
    expect(res.status).toBe(502);
    expect(res.body.code).toBe('STORAGE_UPLOAD_FAILED');
    expect((await User.findById(alice.id).lean())?.avatarPublicId).toBeNull();
  });
});

describe('deleting an account', () => {
  async function userWithPassword(username: string) {
    return createUser(username, { passwordHash: await hashPassword(PASSWORD) });
  }

  it('needs the right password and the typed word DELETE', async () => {
    const carol = await userWithPassword('carol');

    const wrongPassword = await request(app).delete(`${V1}/users/me`).set(bearer(carol)).send({ password: 'wrong-password-1', confirmation: 'DELETE' });
    expect(wrongPassword.status).toBe(403);
    expect(wrongPassword.body.code).toBe('INVALID_PASSWORD');

    const wrongWord = await request(app).delete(`${V1}/users/me`).set(bearer(carol)).send({ password: PASSWORD, confirmation: 'delete' });
    expect(wrongWord.status).toBe(400);
    expect((await User.findById(carol.id).lean())?.deletedAt).toBeNull();
  });

  it('blanks the account and erases everything personal', async () => {
    const carol = await userWithPassword('carol');
    const dave = await createUser('dave');
    const roomId = await createRoom(carol, dave);
    await Message.create({ roomId, senderId: carol.id, type: 'text', content: 'hello' });
    await setPrivacy(carol.id, { nearbyDiscoverable: true });
    await Location.create({ userId: carol.id, location: { type: 'Point', coordinates: [77.2, 28.6] }, expiresAt: new Date(Date.now() + 600_000) });
    await Notification.create({ userId: carol.id, type: 'system', title: 't', body: 'b' });
    await BlockedUser.create({ blockerId: dave.id, blockedId: carol.id });

    const res = await request(app).delete(`${V1}/users/me`).set(bearer(carol)).send({ password: PASSWORD, confirmation: 'DELETE' });
    expect(res.status).toBe(200);

    const stored = await User.findById(carol.id).lean();
    expect(stored?.deletedAt).toBeTruthy();
    expect(stored?.displayName).toBe('Deleted user');
    expect(stored?.username.startsWith('del_')).toBe(true);
    expect(stored?.email).toMatch(/^deleted-[a-f0-9]{24}@deleted\.invalid$/);

    expect(await Session.countDocuments({ userId: carol.id })).toBe(0);
    expect(await PrivacySettings.countDocuments({ userId: carol.id })).toBe(0);
    expect(await Location.countDocuments({ userId: carol.id })).toBe(0);
    expect(await Notification.countDocuments({ userId: carol.id })).toBe(0);
    expect(await BlockedUser.countDocuments()).toBe(0);
    expect(await ChatRoom.countDocuments()).toBe(0);
    expect(await Message.countDocuments()).toBe(0);
  });

  it('ends all access, and the name can never log in again', async () => {
    const carol = await userWithPassword('carol');
    await request(app).delete(`${V1}/users/me`).set(bearer(carol)).send({ password: PASSWORD, confirmation: 'DELETE' });

    expect((await request(app).get(`${V1}/users/me`).set(bearer(carol))).status).toBe(401);
    const login = await request(app).post(`${V1}/auth/login`).send({ identifier: 'carol', password: PASSWORD });
    expect(login.status).toBe(401);
    expect(login.body.code).toBe('INVALID_CREDENTIALS');
  });
});