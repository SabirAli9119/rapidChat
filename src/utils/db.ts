import type { PageResult } from '../types';

/** How many documents to skip for page-number pagination. */
export const skipFor = (page: number, limit: number): number => (page - 1) * limit;

export function buildPageResult<T>(
  items: T[],
  total: number,
  page: number,
  limit: number,
): PageResult<T> {
  return { items, page, limit, total, totalPages: Math.ceil(total / limit) };
}

/** True when MongoDB rejected a write because a unique index would be violated. */
export function isDuplicateKeyError(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: unknown }).code === 11000;
}

/** Escapes characters that have a special meaning inside regular expressions. */
export function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}