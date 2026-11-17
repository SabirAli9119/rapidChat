import http from 'node:http';
import type { AddressInfo } from 'node:net';
import mongoose, { Types } from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { io as connectClient, type Socket } from 'socket.io-client';
import { env } from './config/env';
import { redis } from './config/redis';
import { ChatRoom } from './models/ChatRoom.model';
import { Media } from './models/Media.model';
import { Message } from './models/Message.model';
import { Notification } from './models/Notification.model';
import { PrivacySettings } from './models/PrivacySettings.model';
import { Session } from './models/Session.model';
import { User } from './models/User.model';
import * as blocks from './services/block.service';
import * as notifications from './services/notification.service';
import { isUserOnline } from './services/presence.service';
import { emitMessageExpired, initSockets, isAllowedOrigin } from './sockets';
import { SEND_LIMIT } from './sockets/chat.socket';
import { signAccessToken } from './utils/token';

// ---------- fake Redis (only what presence tracking uses) ----------
const sets = new Map<string, Set<string>>();
interface FakeMulti { sadd(k: string, m: string): FakeMulti; srem(k: string, m: string): FakeMulti; scard(k: string): FakeMulti; expire(...a: unknown[]): FakeMulti; exec(): Promise<[Error | null, number][]> }
const fakeRedis = redis as unknown as Record<string, unknown>;
fakeRedis.multi = (): FakeMulti => {
  const ops: (() => number)[] = [];
  const chain: FakeMulti = {
    sadd(key, member) { ops.push(() => { const s = sets.get(key) ?? new Set<string>(); sets.set(key, s); const had = s.has(member); s.add(member); return had ? 0 : 1; }); return chain; },
    srem(key, member) { ops.push(() => (sets.get(key)?.delete(member) ? 1 : 0)); return chain; },
    scard(key) { ops.push(() => sets.get(key)?.size ?? 0); return chain; },
    expire() { ops.push(() => 1); return chain; },
    async exec() { return ops.map((op) => [null, op()] as [Error | null, number]); },
  };
  return chain;
};
fakeRedis.scard = async (key: string) => sets.get(key)?.size ?? 0;

// ---------- tiny test framework ----------
let section = '', passed = 0, count = 0, grandPassed = 0, grandCount = 0;
const problems: string[] = [];
function begin(name: string) { section = name; passed = 0; count = 0; }
function must(what: string, condition: boolean, detail = '') {
  count++;
  if (condition) passed++; else problems.push(`  FAIL [${section}] ${what}${detail ? ` -> ${detail}` : ''}`);
}
function end() {
  console.log(`${section.padEnd(46)} ${passed === count ? 'PASS' : `FAIL (${count - passed} of ${count})`}`);
  grandPassed += passed; grandCount += count;
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;
const failed = (what: string, res: Any, code: string) => must(what, res?.ok === false && res.error?.code === code, JSON.stringify(res));
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const GAP = 300;
async function until(check: () => boolean | Promise<boolean>, ms = 2500): Promise<boolean> {
  const stop = Date.now() + ms;
  while (Date.now() < stop) { if (await check()) return true; await sleep(25); }
  return false;
}

// ---------- test client ----------
let url = '';
class TestClient {
  readonly events: { name: string; data: Any }[] = [];
  connectError: { message: string; code?: string } | null = null;
  disconnectReason: string | null = null;
  readonly socket: Socket;

  constructor(options: Record<string, unknown>) {
    this.socket = connectClient(url, { transports: ['websocket'], reconnection: false, forceNew: true, autoConnect: false, ...options });
    this.socket.onAny((name: string, data: Any) => { this.events.push({ name, data }); });
    this.socket.on('disconnect', (reason: string) => { this.disconnectReason = reason; });
  }
  connect(): Promise<boolean> {
    return new Promise((resolve) => {
      this.socket.once('connect', () => resolve(true));
      this.socket.once('connect_error', (err: Error & { data?: { code?: string } }) => {
        this.connectError = { message: err.message, code: err.data?.code };
        resolve(false);
      });
      this.socket.connect();
    });
  }
  async ack(event: string, payload?: unknown): Promise<Any> {
    try { return await this.socket.timeout(3000).emitWithAck(event, payload); }
    catch { return { ok: false, error: { code: 'TIMEOUT', message: 'no acknowledgement' } }; }
  }
  count(name: string, where: (d: Any) => boolean = () => true): number {
    return this.events.filter((e) => e.name === name && where(e.data)).length;
  }
  async waitFor(name: string, where: (d: Any) => boolean = () => true, ms = 2500): Promise<Any> {
    let found: { data: Any } | undefined;
    await until(() => { found = this.events.find((e) => e.name === name && where(e.data)); return Boolean(found); }, ms);
    return found ? found.data : null;
  }
  clear() { this.events.length = 0; }
  async close() { this.socket.close(); await sleep(60); }
}
const clients: TestClient[] = [];
const newClient = (options: Record<string, unknown> = {}): TestClient => { const c = new TestClient(options); clients.push(c); return c; };

// ---------- data helpers ----------
const makeUser = async (username: string, extra: Record<string, unknown> = {}) =>
  (await User.create({ username, email: `${username}@example.com`, passwordHash: 'x', displayName: username, emailVerified: true, ...extra })).id as string;
const makeSession = async (userId: string) => {
  const s = await Session.create({ userId, expiresAt: new Date(Date.now() + 3600_000) });
  return { sessionId: s.id as string, token: signAccessToken(userId, s.id as string) };
};
const login = async (username: string, extra: Record<string, unknown> = {}) => {
  const id = await makeUser(username, extra);
  return { id, ...(await makeSession(id)) };
};
type Login = Awaited<ReturnType<typeof login>>;
async function connectAs(user: Login, label: string, extra: Record<string, unknown> = {}): Promise<TestClient> {
  const c = newClient({ auth: { token: user.token }, ...extra });
  const ok = await c.connect();
  must(`${label} connects`, ok, JSON.stringify(c.connectError));
  return c;
}
  const setPrivacy = (userId: string, changes: Record<string, unknown>) =>
  PrivacySettings.findOneAndUpdate({ userId }, { $set: changes }, { upsert: true, setDefaultsOnInsert: true });

async function main() {
  const mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
  await Promise.all(Object.values(mongoose.models).map((m) => m.init()));

  const httpServer = http.createServer();
  const runtime = initSockets(httpServer, { sweepIntervalMs: 0, sessionRecheckMs: 0 });
  await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${(httpServer.address() as AddressInfo).port}`;

  const alice = await login('alice'), hank = await login('hank'), carol = await login('carol'), dan = await login('dan');
  const roomId = (await ChatRoom.create({ participants: [alice.id, hank.id], createdBy: alice.id })).id as string;
  let c: TestClient;

  // ===================== connecting =====================
  begin('connecting');
  c = newClient(); must('no token is refused', !(await c.connect()) && c.connectError?.code === 'NO_TOKEN', JSON.stringify(c.connectError));
  c = newClient({ auth: { token: 'garbage' } }); must('garbage token is refused', !(await c.connect()) && c.connectError?.code === 'INVALID_TOKEN', JSON.stringify(c.connectError));
  c = await connectAs(alice, 'token in handshake auth'); await c.close();
  c = newClient({ extraHeaders: { Authorization: `Bearer ${alice.token}` } }); must('Authorization header works', await c.connect(), JSON.stringify(c.connectError)); await c.close();
  c = newClient({ extraHeaders: { Cookie: `theme=dark; access_token=${alice.token}` } }); must('access_token cookie works', await c.connect(), JSON.stringify(c.connectError)); await c.close();

  const eve = await login('eve', { emailVerified: false });
  c = newClient({ auth: { token: eve.token } }); must('unverified email is refused', !(await c.connect()) && c.connectError?.code === 'EMAIL_NOT_VERIFIED', JSON.stringify(c.connectError));
  const bad = await login('baddie', { status: 'banned' });
  c = newClient({ auth: { token: bad.token } }); must('banned account is refused', !(await c.connect()) && c.connectError?.code === 'ACCOUNT_BANNED', JSON.stringify(c.connectError));
  const gone = await login('gone'); await Session.updateOne({ _id: gone.sessionId }, { $set: { revokedAt: new Date() } });
  c = newClient({ auth: { token: gone.token } }); must('revoked session is refused', !(await c.connect()) && c.connectError?.code === 'SESSION_INVALID', JSON.stringify(c.connectError));

  const many = await login('many');
  const open: TestClient[] = [];
  for (let i = 0; i < 10; i++) open.push(await connectAs(many, `connection ${i + 1} of 10`));
  c = newClient({ auth: { token: many.token } }); must('11th connection is refused', !(await c.connect()) && c.connectError?.code === 'TOO_MANY_CONNECTIONS', JSON.stringify(c.connectError));
  for (const o of open) await o.close();
  end();

  // ===================== origin check =====================
  begin('origin check');
  const front = new URL(env.FRONTEND_URL).origin;
  must('no Origin header (apps, scripts) is allowed', isAllowedOrigin(undefined));
  must('your frontend origin is allowed', isAllowedOrigin(front));
  must('another site is refused', !isAllowedOrigin('http://evil.example'));
  must('"null" origin is refused', !isAllowedOrigin('null'));
  c = newClient({ auth: { token: alice.token }, extraHeaders: { Origin: front } }); must('live: connection from your frontend', await c.connect(), JSON.stringify(c.connectError)); await c.close();
  c = newClient({ auth: { token: alice.token }, extraHeaders: { Origin: 'http://evil.example' } }); must('live: connection from another site is refused', !(await c.connect()), 'it connected');
  end();

  // ===================== presence =====================
  begin('presence (online / offline)');
  const a1 = await connectAs(alice, 'alice');
  let h = await connectAs(hank, 'hank (first device)');
  must('a contact sees user_online', !!(await a1.waitFor('user_online', (d) => d.userId === hank.id)));
  const h2 = await connectAs(hank, 'hank (second device)');
  await sleep(GAP);
  must('a second device does not repeat user_online', a1.count('user_online', (d) => d.userId === hank.id) === 1);
  const stranger = await connectAs(dan, 'dan (shares no chat with anyone)');
  await sleep(GAP);
  must('a stranger is not announced to alice', a1.count('user_online', (d) => d.userId === dan.id) === 0);
  await stranger.close();
  await h.close(); await sleep(GAP);
  must('closing one of two devices sends no user_offline', a1.count('user_offline') === 0);
  await h2.close();
  let off = await a1.waitFor('user_offline', (d) => d.userId === hank.id);
  must('last device closed -> user_offline, last seen hidden', !!off && off.lastSeenAt === null, JSON.stringify(off));
  must('presence tracking agrees', !(await until(() => isUserOnline(hank.id), 300)));

  await setPrivacy(hank.id, { showLastSeen: true }); a1.clear();
  h = await connectAs(hank, 'hank'); await a1.waitFor('user_online', (d) => d.userId === hank.id); await h.close();
  off = await a1.waitFor('user_offline', (d) => d.userId === hank.id);
  must('showLastSeen on -> a real timestamp', typeof off?.lastSeenAt === 'string' && !Number.isNaN(Date.parse(off.lastSeenAt)), JSON.stringify(off));

  await setPrivacy(hank.id, { showLastSeen: false, showOnlineStatus: false }); a1.clear();
  h = await connectAs(hank, 'hank (status hidden)'); await sleep(GAP); await h.close(); await sleep(GAP);
  must('hidden online status: nothing is announced', a1.count('user_online') === 0 && a1.count('user_offline') === 0);
  await setPrivacy(hank.id, { showOnlineStatus: true }); a1.clear();

  await blocks.blockUser(alice.id, hank.id);
  h = await connectAs(hank, 'hank (blocked by alice)'); await sleep(GAP); await h.close(); await sleep(GAP);
  must('a blocked user is not announced', a1.count('user_online') === 0 && a1.count('user_offline') === 0);
  await blocks.unblockUser(alice.id, hank.id);
  end();

  // ===================== join and leave =====================
  begin('join_room and leave_room');
  h = await connectAs(hank, 'hank');
  let r = await a1.ack('join_room', { roomId }); must('a member can join', r.ok === true && r.data.roomId === roomId, JSON.stringify(r));
  r = await h.ack('join_room', { roomId }); must('the other member can join', r.ok === true, JSON.stringify(r));
  const c1 = await connectAs(carol, 'carol');
  failed('a stranger cannot join', await c1.ack('join_room', { roomId }), 'ROOM_NOT_FOUND');
  failed('a malformed room id is refused', await a1.ack('join_room', { roomId: 'not-an-id' }), 'VALIDATION_ERROR');
  failed('a missing payload is refused', await a1.ack('join_room', null), 'VALIDATION_ERROR');
  a1.socket.emit('join_room', { roomId });
  r = await a1.ack('join_room', { roomId }); must('an event without a callback is tolerated', r.ok === true, JSON.stringify(r));
  r = await a1.ack('leave_room', { roomId }); must('leave_room works', r.ok === true, JSON.stringify(r));
  await a1.ack('join_room', { roomId });
  end();

  // ===================== typing =====================
  begin('typing indicators');
  a1.clear(); h.clear();
  a1.socket.emit('typing_start', { roomId });
  must('the other person sees typing_start', !!(await h.waitFor('typing_start', (d) => d.userId === alice.id && d.roomId === roomId)));
  await sleep(GAP);
  must('the sender does not see their own typing', a1.count('typing_start') === 0);
  a1.socket.emit('typing_stop', { roomId });
  must('typing_stop arrives', !!(await h.waitFor('typing_stop', (d) => d.userId === alice.id)));

  await h.ack('leave_room', { roomId }); h.clear();
  a1.socket.emit('typing_start', { roomId }); await sleep(GAP);
  must('someone who left the chat gets no typing events', h.count('typing_start') === 0);
  await h.ack('join_room', { roomId }); h.clear();
  await a1.ack('leave_room', { roomId });
  must('leaving while typing sends typing_stop', !!(await h.waitFor('typing_stop', (d) => d.userId === alice.id)));
  await a1.ack('join_room', { roomId });

  a1.clear(); h.clear();
  c1.socket.emit('typing_start', { roomId }); await sleep(GAP);
  must('a stranger cannot type into the chat', h.count('typing_start') === 0 && a1.count('typing_start') === 0);

  h.clear();
  a1.socket.emit('typing_start', { roomId });
  await h.waitFor('typing_start'); h.clear();
  await a1.close();
  must('disconnecting while typing sends typing_stop', !!(await h.waitFor('typing_stop', (d) => d.userId === alice.id)));
  const a2 = await connectAs(alice, 'alice (reconnected)');
  await a2.ack('join_room', { roomId });
  end();

  // ===================== sending =====================
  begin('send_message: delivery and notifications');
  a2.clear(); h.clear();
  let res = await a2.ack('send_message', { roomId, type: 'text', content: 'hello hank', senderId: hank.id, expiresAt: '2099-01-01' });
  must('the sender gets the saved message', res.ok === true && res.data.content === 'hello hank' && res.data.status === 'sent', JSON.stringify(res));
  must('the sender id comes from the login, not the client', res.data?.senderId === alice.id);
  const ttl = Math.round((Date.parse(res.data.expiresAt) - Date.parse(res.data.createdAt)) / 60000);
  must('the server sets the 30 minute expiry', ttl === env.MESSAGE_EXPIRY_MINUTES, `ttl ${ttl}`);
  await h.waitFor('message_sent', (d) => d.id === res.data.id); await sleep(GAP);
  must('the recipient receives message_sent exactly once', h.count('message_sent', (d) => d.id === res.data.id) === 1);
  must('the sender receives message_sent exactly once', a2.count('message_sent', (d) => d.id === res.data.id) === 1);
  must('the sender is told it was delivered', a2.count('message_delivered', (d) => d.messageId === res.data.id) === 1);
  must('the recipient gets no delivery event', h.count('message_delivered') === 0);
  must('delivered is stored', (await Message.findById(res.data.id).lean())?.status === 'delivered');
  must('no notification while the chat is open', (await Notification.countDocuments({ userId: hank.id })) === 0 && h.count('notification') === 0);

  await h.ack('leave_room', { roomId }); a2.clear(); h.clear();
  const second = await a2.ack('send_message', { roomId, type: 'text', content: 'second message' });
  const note = await h.waitFor('notification', (d) => d.type === 'new_message');
  must('a connected device that is not in the chat still gets the message', h.count('message_sent', (d) => d.id === second.data.id) === 1);
  must('and a live notification', !!note && note.data.roomId === roomId && note.read === false, JSON.stringify(note));
  must('the notification is generic (never the message text)', !JSON.stringify(note).includes('second message') && String(note?.body).includes('alice'));
  await sleep(GAP);
  must('the sender is told it was delivered', a2.count('message_delivered', (d) => d.messageId === second.data.id) === 1);
  await a2.ack('send_message', { roomId, type: 'text', content: 'third message' }); await sleep(GAP);
  must('one notification per chat, not one per message', h.count('notification') === 1 && (await Notification.countDocuments({ userId: hank.id, type: 'new_message' })) === 1);

  await h.close(); await until(async () => !(await isUserOnline(hank.id)));
  await Notification.updateMany({ userId: hank.id }, { $set: { read: true } }); a2.clear();
  const offlineMsg = await a2.ack('send_message', { roomId, type: 'text', content: 'sent while hank was away' }); await sleep(GAP);
  must('an offline recipient: stored as sent', (await Message.findById(offlineMsg.data.id).lean())?.status === 'sent');
  must('no delivery event yet', a2.count('message_delivered', (d) => d.messageId === offlineMsg.data.id) === 0);
  must('the notification is saved for later', (await Notification.countDocuments({ userId: hank.id, read: false, type: 'new_message' })) === 1);
  h = await connectAs(hank, 'hank (back online)');
  must('delivered the moment the recipient connects', !!(await a2.waitFor('message_delivered', (d) => d.messageId === offlineMsg.data.id)));
  must('and stored as delivered', (await Message.findById(offlineMsg.data.id).lean())?.status === 'delivered');

  const waiting = await Message.create({ roomId, senderId: alice.id, type: 'text', content: 'waiting', status: 'sent' });
  a2.clear();
  r = await h.ack('join_room', { roomId }); must('hank joins the chat', r.ok === true, JSON.stringify(r));
  must('joining delivers waiting messages', !!(await a2.waitFor('message_delivered', (d) => d.messageId === waiting.id)));
  must('joining marks that chat\'s notifications read', (await Notification.countDocuments({ userId: hank.id, type: 'new_message', read: false })) === 0);
  end();

  // ===================== validation and rules =====================
  begin('send_message: validation and rules');
  failed('text without content', await a2.ack('send_message', { roomId, type: 'text' }), 'VALIDATION_ERROR');
  failed('unknown message type', await a2.ack('send_message', { roomId, type: 'sticker', content: 'x' }), 'VALIDATION_ERROR');
  failed('malformed room id', await a2.ack('send_message', { roomId: 'nope', type: 'text', content: 'x' }), 'VALIDATION_ERROR');
  failed('2001 characters', await a2.ack('send_message', { roomId, type: 'text', content: 'x'.repeat(2001) }), 'VALIDATION_ERROR');
  failed('empty payload', await a2.ack('send_message', null), 'VALIDATION_ERROR');

  a2.clear(); h.clear();
  failed('a stranger cannot send', await c1.ack('send_message', { roomId, type: 'text', content: 'let me in' }), 'ROOM_NOT_FOUND');
  await sleep(GAP);
  must('and nobody receives anything', a2.count('message_sent') === 0 && h.count('message_sent') === 0);

  await blocks.blockUser(alice.id, hank.id); a2.clear(); h.clear();
  failed('the blocker cannot send', await a2.ack('send_message', { roomId, type: 'text', content: 'hi' }), 'INTERACTION_NOT_ALLOWED');
  failed('the blocked person cannot send', await h.ack('send_message', { roomId, type: 'text', content: 'hi' }), 'INTERACTION_NOT_ALLOWED');
  await sleep(GAP);
  must('nothing is delivered while blocked', a2.count('message_sent') === 0 && h.count('message_sent') === 0);
  await blocks.unblockUser(alice.id, hank.id);

  const media = await Media.create({ uploaderId: alice.id, roomId, kind: 'image', mimeType: 'image/png', sizeBytes: 10, originalName: 'p.png', storagePublicId: `chat-media/test-${new Types.ObjectId()}`, storageResourceType: 'image' });
  h.clear();
  res = await a2.ack('send_message', { roomId, type: 'image', mediaId: media.id, content: 'look' });
  must('a media message is sent', res.ok === true && res.data.media?.kind === 'image', JSON.stringify(res));
  must('without any storage details', !JSON.stringify(res).includes('chat-media'));
  must('the recipient receives it with the media', !!(await h.waitFor('message_sent', (d) => d.id === res.data.id && d.media?.kind === 'image')));
  failed('the same file cannot be sent twice', await a2.ack('send_message', { roomId, type: 'image', mediaId: media.id }), 'MEDIA_NOT_AVAILABLE');
  end();

  // ===================== rate limit =====================
  begin('rate limit');
  const rita = await login('rita'), sam = await login('sam');
  const rrRoom = (await ChatRoom.create({ participants: [rita.id, sam.id], createdBy: rita.id })).id as string;
  const rc = await connectAs(rita, 'rita');
  let okCount = 0;
  for (let i = 0; i < SEND_LIMIT.limit; i++) {
    const x = await rc.ack('send_message', { roomId: rrRoom, type: 'text', content: `m${i}` });
    if (x.ok) okCount++;
  }
  must(`the first ${SEND_LIMIT.limit} messages are accepted`, okCount === SEND_LIMIT.limit, `only ${okCount}`);
  const blockedSend = await rc.ack('send_message', { roomId: rrRoom, type: 'text', content: 'one too many' });
  failed('the next one is refused', blockedSend, 'RATE_LIMITED');
  must('with a retry time in the message', /Try again in \d+ seconds/.test(blockedSend?.error?.message ?? ''), JSON.stringify(blockedSend));
  res = await a2.ack('send_message', { roomId, type: 'text', content: 'alice is unaffected' });
  must('other users are not affected', res.ok === true, JSON.stringify(res));
  end();

  // ===================== kicked while connected =====================
  begin('session revoked or account banned while connected');
  const kay = await login('kay'), lee = await login('lee'), moe = await login('moe');
  const kayRoom = (await ChatRoom.create({ participants: [kay.id, lee.id], createdBy: kay.id })).id as string;
  const moeRoom = (await ChatRoom.create({ participants: [moe.id, lee.id], createdBy: moe.id })).id as string;
  const kc = await connectAs(kay, 'kay'), mc = await connectAs(moe, 'moe');
  must('kay can send before the change', (await kc.ack('send_message', { roomId: kayRoom, type: 'text', content: 'hi' })).ok === true);
  await Session.updateOne({ _id: kay.sessionId }, { $set: { revokedAt: new Date() } });
  failed('kay is refused after the session is revoked', await kc.ack('send_message', { roomId: kayRoom, type: 'text', content: 'again' }), 'SESSION_INVALID');
  must('kay is told why', !!(await kc.waitFor('session_ended', (d) => d.code === 'SESSION_INVALID')));
  must('and disconnected', await until(() => kc.disconnectReason !== null), String(kc.disconnectReason));
  await User.updateOne({ _id: moe.id }, { $set: { status: 'banned' } });
  failed('moe is refused after being banned', await mc.ack('send_message', { roomId: moeRoom, type: 'text', content: 'hi' }), 'ACCOUNT_BANNED');
  must('moe is told why', !!(await mc.waitFor('session_ended', (d) => d.code === 'ACCOUNT_BANNED')));
  must('and disconnected', await until(() => mc.disconnectReason !== null), String(mc.disconnectReason));
  end();

  // ===================== sweep =====================
  begin('periodic session sweep');
  const u1 = await login('sweep1'), u2 = await login('sweep2'), u3 = await login('sweep3'), u4 = await login('sweep4');
  const s1 = await connectAs(u1, 'sweep1'), s2 = await connectAs(u2, 'sweep2'), s3 = await connectAs(u3, 'sweep3'), s4 = await connectAs(u4, 'sweep4');
  must('before any change nothing is closed', (await runtime.sweepSessions()) === 0);
  await User.updateOne({ _id: u2.id }, { $set: { status: 'banned' } });
  await Session.updateOne({ _id: u3.sessionId }, { $set: { revokedAt: new Date() } });
  await Session.deleteOne({ _id: u4.sessionId });
  must('three connections are closed', (await runtime.sweepSessions()) === 3);
  must('the banned user is told ACCOUNT_BANNED', !!(await s2.waitFor('session_ended', (d) => d.code === 'ACCOUNT_BANNED')));
  must('the revoked session is told SESSION_INVALID', !!(await s3.waitFor('session_ended', (d) => d.code === 'SESSION_INVALID')));
  must('the deleted session is told SESSION_INVALID', !!(await s4.waitFor('session_ended', (d) => d.code === 'SESSION_INVALID')));
  must('all three are disconnected', await until(() => [s2, s3, s4].every((x) => x.disconnectReason !== null)));
  await sleep(GAP);
  must('the healthy connection stays open', s1.socket.connected === true);
  must('presence of the banned user is cleaned up', !(await isUserOnline(u2.id)));
  must('a second sweep finds nothing', (await runtime.sweepSessions()) === 0);
  end();

  // ===================== message_expired + live notification =====================
  begin('message_expired and live notifications');
  await h.ack('leave_room', { roomId }); a2.clear(); h.clear(); c1.clear();
  await emitMessageExpired([{ messageId: 'm-1', roomId }]);
  await sleep(GAP);
  must('a device that has the chat open is told', a2.count('message_expired', (d) => d.messageId === 'm-1' && d.roomId === roomId) === 1);
  must('the other person is told on any device', h.count('message_expired', (d) => d.messageId === 'm-1') === 1);
  must('a stranger is not told', c1.count('message_expired') === 0);
  await emitMessageExpired([{ messageId: 'x', roomId: new Types.ObjectId().toString() }]);
  must('an unknown room does not break anything', true);

  a2.clear();
  await notifications.createNotification({ userId: alice.id, type: 'system', title: 'Hello', body: 'Live' });
  must('any notification is pushed live', !!(await a2.waitFor('notification', (d) => d.title === 'Hello')));
  end();

  // ===================== shutdown =====================
  begin('shutdown');
  await runtime.close();
  must('open connections are closed', await until(() => !a2.socket.connected));
  let threw = false;
  try { await notifications.createNotification({ userId: alice.id, type: 'system', title: 'Later', body: 'No sockets' }); } catch { threw = true; }
  must('services keep working without a socket server', !threw);
  end();

  console.log('');
  if (problems.length === 0) console.log(`ALL SOCKET CHECKS PASSED (${grandPassed} checks)`);
  else { console.log(`${problems.length} PROBLEM(S) (${grandPassed}/${grandCount} checks passed):`); problems.forEach((p) => console.log(p)); }

  for (const x of clients) x.socket.close();
  await mongoose.disconnect();
  await mongod.stop();
  process.exit(problems.length === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
