import type { Response } from 'supertest';

export const V1 = '/api/v1';

export function setCookieLines(res: Response): string[] {
  const header = res.headers['set-cookie'] as unknown;
  if (Array.isArray(header)) return header as string[];
  return typeof header === 'string' ? [header] : [];
}

/** The full Set-Cookie line for one cookie, or undefined. */
export const cookieOf = (res: Response, name: string): string | undefined =>
  setCookieLines(res).find((line) => line.startsWith(`${name}=`));

/** The value of one cookie (without its attributes). */
export const cookieValue = (res: Response, name: string): string | undefined =>
  cookieOf(res, name)?.split(';')[0].slice(name.length + 1);

/** True when the response tells the browser to delete this cookie. */
export function isCleared(res: Response, name: string): boolean {
  const line = cookieOf(res, name);
  return Boolean(line && /^[^=]+=;/.test(line) && /Expires=Thu, 01 Jan 1970/i.test(line));
}

/** The field names listed in a validation error. */
export const errorFields = (res: Response): string[] =>
  ((res.body.details ?? []) as { field: string }[]).map((detail) => detail.field);