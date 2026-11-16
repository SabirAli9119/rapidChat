import type { Request } from 'express';

export interface RequestContext {
  ipAddress: string | null;
  userAgent: string | null;
}

/**
 * Who is calling. req.ip is only the real client address when `trust proxy` is set
 * correctly in app.ts (we'll do that from TRUST_PROXY).
 */
export function getRequestContext(req: Request): RequestContext {
  return { ipAddress: req.ip ?? null, userAgent: req.get('user-agent') ?? null };
}