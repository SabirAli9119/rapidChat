/** The personal channel of one user: every device they have connected is in it. */
export const userRoom = (userId: string): string => `user:${userId}`;

/** The channel of one chat room. A socket enters it with join_room. */
export const roomChannel = (roomId: string): string => `room:${roomId}`;

export const ROOM_CHANNEL_PREFIX = 'room:';