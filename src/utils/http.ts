import type { MediaKind } from '../types';

/** Kinds a browser may show directly on a page. Everything else is a download. */
const INLINE_KINDS: ReadonlySet<MediaKind> = new Set<MediaKind>(['image', 'video', 'audio']);

/** RFC 5987 encoding: like encodeURIComponent, but also escapes ' ( ) * */
function encodeRFC5987(value: string): string {
  return encodeURIComponent(value).replace(
    /['()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

/**
 * Builds a Content-Disposition header that cannot be broken by a hostile file name.
 * Images, video and audio are shown inline; documents are always downloaded.
 */
export function buildContentDisposition(kind: MediaKind, fileName: string): string {
  const disposition = INLINE_KINDS.has(kind) ? 'inline' : 'attachment';
  const fallback = fileName.replace(/[^A-Za-z0-9._ -]/g, '_').slice(0, 100) || 'file';
  return `${disposition}; filename="${fallback}"; filename*=UTF-8''${encodeRFC5987(fileName)}`;
}