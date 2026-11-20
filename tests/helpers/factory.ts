import { ChatRoom } from '../../src/models/ChatRoom.model';
import { PrivacySettings } from '../../src/models/PrivacySettings.model';
import { Session } from '../../src/models/Session.model';
import { User } from '../../src/models/User.model';
import { signAccessToken } from '../../src/utils/token';

export interface TestUser {
  id: string;
  username: string;
  sessionId: string;
  /** A valid access token. Send it as "Authorization: Bearer <token>". */
  token: string;
}

/** Creates a verified user with a live session and a login token, without the (slow) password hashing. */
export async function createUser(username: string, extra: Record<string, unknown> = {}): Promise<TestUser> {
  const user = await User.create({
    username,
    email: `${username}@example.com`,
    passwordHash: 'not-a-real-hash',
    displayName: username,
    emailVerified: true,
    ...extra,
  });
  const session = await Session.create({
    userId: user._id,
    expiresAt: new Date(Date.now() + 60 * 60 * 1000),
  });

  return {
    id: user.id as string,
    username,
    sessionId: session.id as string,
    token: signAccessToken(user.id as string, session.id as string),
  };
}

export const bearer = (user: TestUser): Record<string, string> => ({ Authorization: `Bearer ${user.token}` });

export async function createRoom(a: TestUser, b: TestUser): Promise<string> {
  const room = await ChatRoom.create({ participants: [a.id, b.id], createdBy: a.id });
  return room.id as string;
}

export async function setPrivacy(userId: string, changes: Record<string, unknown>): Promise<void> {
  await PrivacySettings.findOneAndUpdate(
    { userId },
    { $set: changes },
    { upsert: true, setDefaultsOnInsert: true },
  );
}