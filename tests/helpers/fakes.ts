import { v2 as cloudinary } from 'cloudinary';

export interface FakeStorage {
  /** Everything "uploaded", by storage id */
  files: Map<string, Buffer>;
  /** While true, every upload fails */
  failUploads: boolean;
  /** Deleting these storage ids fails */
  failDeletesFor: Set<string>;
  /** Puts the real functions back */
  restore: () => void;
}

/** Replaces the Cloudinary calls, so tests store files in memory and nothing leaves your computer. */
export function installFakeStorage(): FakeStorage {
  const uploader = cloudinary.uploader as unknown as Record<string, unknown>;
  const originalUpload = uploader.upload_stream;
  const originalDestroy = uploader.destroy;
  const originalFetch = globalThis.fetch;

  const state: FakeStorage = {
    files: new Map(),
    failUploads: false,
    failDeletesFor: new Set(),
    restore: () => {
      uploader.upload_stream = originalUpload;
      uploader.destroy = originalDestroy;
      globalThis.fetch = originalFetch;
    },
  };

  uploader.upload_stream = (
    options: { public_id: string },
    callback: (error: unknown, result?: unknown) => void,
  ) => ({
    end: (buffer: Buffer) => {
      if (state.failUploads) return callback({ message: 'storage is down' });
      state.files.set(options.public_id, buffer);
      callback(undefined, { public_id: options.public_id, bytes: buffer.length });
    },
  });

  uploader.destroy = async (publicId: string) => {
    if (state.failDeletesFor.has(publicId)) throw new Error('storage is down');
    state.files.delete(publicId);
    return { result: 'ok' };
  };

  // Private files are read through a signed storage URL: answer it from memory
  globalThis.fetch = (async (input: unknown) => {
    const url = String(input);
    for (const [id, buffer] of state.files) {
      if (url.includes(id)) {
        return new Response(buffer, { status: 200, headers: { 'content-type': 'application/octet-stream' } });
      }
    }
    return new Response('not found', { status: 404 });
  }) as typeof globalThis.fetch;

  return state;
}