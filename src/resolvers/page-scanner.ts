import net from 'node:net';
import * as cheerio from 'cheerio';
import { MIB } from '../consts';
import type { FileCategory, ResolvedTarget } from '../types';
import { isPrivateOrReservedIp, readBoundedText, safeFetch } from '../utils/security';
import {
  DEFAULT_USER_AGENT,
  mergeRequestHeaders,
  normalizeHosterFilename,
  parseHumanSize,
} from './hosters/helpers';
import type { ResolverContext, UrlResolver } from './types';

export const MAX_SCANNED_LINKS = 500;

const VIDEO_EXTS = new Set([
  '.mp4',
  '.mkv',
  '.avi',
  '.mov',
  '.webm',
  '.m4v',
  '.flv',
  '.wmv',
  '.ts',
  '.m2ts',
  '.mpg',
  '.mpeg',
  '.iso',
]);

const ARCHIVE_EXTS = new Set([
  '.zip',
  '.7z',
  '.rar',
  '.tar',
  '.gz',
  '.tgz',
  '.bz2',
  '.tbz2',
  '.xz',
  '.txz',
  '.zst',
  '.cab',
  '.lz',
]);

const AUDIO_EXTS = new Set([
  '.mp3',
  '.flac',
  '.aac',
  '.m4a',
  '.ogg',
  '.opus',
  '.wav',
  '.wma',
  '.alac',
  '.aiff',
]);

const BOOK_EXTS = new Set([
  '.epub',
  '.pdf',
  '.mobi',
  '.azw',
  '.azw3',
  '.cbz',
  '.cbr',
  '.djvu',
  '.fb2',
]);

const OTHER_DOWNLOAD_EXTS = new Set([
  '.exe',
  '.msi',
  '.dmg',
  '.pkg',
  '.deb',
  '.rpm',
  '.appimage',
  '.apk',
  '.bin',
  '.img',
  '.gguf',
  '.safetensors',
  '.onnx',
  '.parquet',
  '.csv',
  '.srt',
  '.ass',
  '.vtt',
]);

const ARCHIVE_MIME_TYPES = new Set([
  'application/zip',
  'application/x-zip-compressed',
  'application/x-7z-compressed',
  'application/x-rar-compressed',
  'application/vnd.rar',
  'application/x-tar',
  'application/gzip',
  'application/x-gzip',
  'application/x-bzip2',
  'application/x-xz',
]);

const BLOCKED_LOCAL_HOSTS = new Set([
  'localhost',
  'ip6-localhost',
  'ip6-loopback',
  'metadata.google.internal',
]);

const BLOCKED_LOCAL_SUFFIXES = ['.localhost', '.local', '.internal', '.home.arpa'];

function extractExt(lowerName: string): string {
  const dot = lowerName.lastIndexOf('.');
  if (dot <= 0) return '';
  return lowerName.slice(dot);
}

function isMultipartArchiveName(lowerName: string): boolean {
  return (
    /\.part\d+\.rar$/i.test(lowerName) ||
    /\.(?:7z|zip|rar)\.\d{3,}$/i.test(lowerName) ||
    /\.(?:r\d{2,3}|z\d{2,3})$/i.test(lowerName)
  );
}

export function categorizeFilename(nameOrPath: string, mimeType?: string): FileCategory {
  if (mimeType) {
    const cleanMime = mimeType.split(';')[0].trim().toLowerCase();
    if (cleanMime.startsWith('video/')) return 'video';
    if (cleanMime.startsWith('audio/')) return 'audio';
    if (
      cleanMime === 'application/pdf' ||
      cleanMime === 'application/epub+zip' ||
      cleanMime === 'application/x-mobipocket-ebook'
    ) {
      return 'book';
    }
    if (ARCHIVE_MIME_TYPES.has(cleanMime)) return 'archive';
  }

  let clean = nameOrPath.split(/[?#]/)[0].trim();
  try {
    clean = decodeURIComponent(clean);
  } catch {
    // Keep raw segment if percent-encoding is malformed.
  }
  const base = clean.split('/').filter(Boolean).pop()?.toLowerCase() ?? '';
  if (!base) return 'other';

  if (isMultipartArchiveName(base)) return 'archive';
  const ext = extractExt(base);
  if (VIDEO_EXTS.has(ext)) return 'video';
  if (ARCHIVE_EXTS.has(ext)) return 'archive';
  if (AUDIO_EXTS.has(ext)) return 'audio';
  if (BOOK_EXTS.has(ext)) return 'book';
  return 'other';
}

export function isDownloadableFileUrl(url: URL): boolean {
  if (url.pathname.endsWith('/')) return false;
  let seg = url.pathname.split('/').filter(Boolean).pop() ?? '';
  try {
    seg = decodeURIComponent(seg);
  } catch {
    // Keep raw path segment when decoding fails.
  }
  const lower = seg.toLowerCase();
  if (!lower) return false;
  if (isMultipartArchiveName(lower)) return true;

  const ext = extractExt(lower);
  return (
    VIDEO_EXTS.has(ext) ||
    ARCHIVE_EXTS.has(ext) ||
    AUDIO_EXTS.has(ext) ||
    BOOK_EXTS.has(ext) ||
    OTHER_DOWNLOAD_EXTS.has(ext)
  );
}

function isObviousLocalHost(url: URL): boolean {
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (!host) return true;
  if (
    BLOCKED_LOCAL_HOSTS.has(host) ||
    BLOCKED_LOCAL_SUFFIXES.some((suffix) => host.endsWith(suffix))
  ) {
    return true;
  }
  if (net.isIP(host) !== 0) {
    return isPrivateOrReservedIp(host);
  }
  return false;
}

function isNavOrSortLink(href: string, linkText: string, parsed: URL, pageUrl: URL): boolean {
  const trimmedHref = href.trim();
  if (trimmedHref === './' || trimmedHref === '../' || trimmedHref === '..') return true;
  if (/^(parent directory|name|last modified|size|description|\.\.\/?)$/i.test(linkText)) {
    return true;
  }
  if (parsed.origin === pageUrl.origin && parsed.pathname === pageUrl.pathname) {
    if (!parsed.search || parsed.search === pageUrl.search) return true;
    if (/^\?(?:C=[NMSD];O=[AD]|sort=)/i.test(parsed.search)) return true;
  }
  return false;
}

function extractSizeFromContext($: cheerio.CheerioAPI, el: ReturnType<cheerio.CheerioAPI>): number | undefined {
  const row = el.closest('tr');
  if (row.length > 0) {
    const anchorCell = el.closest('td')[0];
    const cells = row.find('td');
    for (let i = 0; i < cells.length; i += 1) {
      if (cells[i] === anchorCell) continue;
      const parsed = parseHumanSize($(cells[i]).text().trim());
      if (parsed) return parsed;
    }
  }

  const node = el[0];
  const nextSibling = node && 'next' in node ? node.next : null;
  if (nextSibling && nextSibling.type === 'text' && typeof nextSibling.data === 'string') {
    const firstLine = nextSibling.data.split(/\r?\n/)[0] ?? '';
    const parsed = parseHumanSize(firstLine);
    if (parsed) return parsed;
  }

  return undefined;
}

function pickCandidateFilename(
  parsed: URL,
  linkText: string,
  isDirect: boolean,
): string | undefined {
  const rawSeg = parsed.pathname.split('/').filter(Boolean).pop();
  let pathName: string | undefined;
  if (rawSeg) {
    try {
      pathName = normalizeHosterFilename(decodeURIComponent(rawSeg));
    } catch {
      pathName = normalizeHosterFilename(rawSeg);
    }
  }

  if (isDirect) {
    return pathName;
  }

  const cleanText = linkText.trim();
  if (
    cleanText &&
    !/^https?:\/\//i.test(cleanText) &&
    !cleanText.includes('/') &&
    !/^(download|link|mirror|here|get|file|click here)$/i.test(cleanText)
  ) {
    return normalizeHosterFilename(cleanText) ?? pathName;
  }

  return pathName;
}

export function scanHtmlForLinks(
  html: string,
  pageUrl: URL,
  hosterResolvers: UrlResolver[],
): { items: ResolvedTarget[]; warnings: string[] } {
  const $ = cheerio.load(html);
  const items: ResolvedTarget[] = [];
  const warnings: string[] = [];
  const seen = new Set<string>();
  let truncated = false;

  $('a[href]').each((_, rawEl) => {
    const el = $(rawEl);
    const href = (el.attr('href') ?? '').trim();
    if (!href || href.startsWith('#')) return;
    if (/^(?:javascript|mailto|tel|data):/i.test(href)) return;

    let parsed: URL;
    try {
      parsed = new URL(href, pageUrl);
    } catch {
      return;
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return;
    parsed.hash = '';

    const linkText = el.text().trim();
    if (isNavOrSortLink(href, linkText, parsed, pageUrl)) return;
    if (isObviousLocalHost(parsed)) return;

    const matchedHoster = hosterResolvers.find((r) => r.canHandle(parsed));
    const directDownload = !matchedHoster && isDownloadableFileUrl(parsed);
    if (!matchedHoster && !directDownload) return;

    const normalizedUrl = parsed.toString();
    if (seen.has(normalizedUrl)) return;
    seen.add(normalizedUrl);

    if (items.length >= MAX_SCANNED_LINKS) {
      truncated = true;
      return false;
    }

    const hoster = matchedHoster ? matchedHoster.label : 'Direct';
    const filename = pickCandidateFilename(parsed, linkText, !matchedHoster);
    const sizeBytes = extractSizeFromContext($, el);
    const category = categorizeFilename(filename || parsed.pathname);

    items.push({
      downloadUrl: normalizedUrl,
      filename,
      sizeBytes,
      sourceUrl: pageUrl.toString(),
      hoster,
      category,
    });
  });

  if (truncated) {
    warnings.push(`Link scan capped at ${MAX_SCANNED_LINKS} items; remaining links were omitted`);
  }

  return { items, warnings };
}

export async function scanWebpage(
  url: URL,
  ctx: ResolverContext,
  hosterResolvers: UrlResolver[],
): Promise<{ items: ResolvedTarget[]; warnings: string[] }> {
  const headers = mergeRequestHeaders(ctx.headers, {
    'User-Agent': DEFAULT_USER_AGENT,
    Accept: 'text/html,application/xhtml+xml,*/*;q=0.8',
  });

  const { response, finalUrl } = await safeFetch(url.toString(), {
    method: 'GET',
    headers,
    signal: ctx.signal,
    proxyUrl: ctx.proxyUrl,
    fetchFn: ctx.fetchFn,
    lookupFn: ctx.lookupFn,
  });

  const html = await readBoundedText(response, 5 * MIB);
  if (!response.ok) {
    throw new Error(`Page scan returned HTTP ${response.status}`);
  }

  return scanHtmlForLinks(html, new URL(finalUrl), hosterResolvers);
}
