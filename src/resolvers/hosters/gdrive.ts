import { readBoundedText, safeFetch } from '../../utils/security';
import { parseContentDispositionFilename, parseContentSize } from '../direct';
import type { ResolverContext, ResolverOutput, UrlResolver } from '../types';
import {
  decodeHtmlEntities,
  normalizeHosterFilename,
  parseHumanSize,
} from './helpers';

const FILE_ID_PATTERN = /^[A-Za-z0-9_-]{10,}$/;

export function extractGdriveFileId(url: URL): string | null {
  const host = url.hostname.toLowerCase();

  if (host === 'drive.google.com') {
    const fileMatch = /^\/file\/d\/([^/]+)(?:\/|$)/.exec(url.pathname);
    if (fileMatch && FILE_ID_PATTERN.test(fileMatch[1])) {
      return fileMatch[1];
    }
    if (url.pathname === '/open' || url.pathname === '/uc') {
      const id = url.searchParams.get('id')?.trim();
      if (id && FILE_ID_PATTERN.test(id)) return id;
    }
    return null;
  }

  if (host === 'docs.google.com' && url.pathname === '/uc') {
    const id = url.searchParams.get('id')?.trim();
    return id && FILE_ID_PATTERN.test(id) ? id : null;
  }

  if (host === 'drive.usercontent.google.com' && url.pathname === '/download') {
    const id = url.searchParams.get('id')?.trim();
    return id && FILE_ID_PATTERN.test(id) ? id : null;
  }

  return null;
}

function extractTagAttr(tag: string, attrName: string): string | undefined {
  const regex = new RegExp(`\\b${attrName}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i');
  const match = regex.exec(tag);
  if (!match) return undefined;
  return match[1] ?? match[2] ?? match[3];
}

function parseConfirmationForm(html: string, baseUrl: string): URL | null {
  const byId = /<form\b[^>]*\bid\s*=\s*["']download-form["'][^>]*>([\s\S]*?)<\/form>/i.exec(html);
  const byAction =
    byId ??
    /<form\b[^>]*\baction\s*=\s*["'][^"']*download[^"']*["'][^>]*>([\s\S]*?)<\/form>/i.exec(html);
  if (!byAction) return null;

  const formHtml = byAction[0];
  const openTagMatch = /<form\b[^>]*>/i.exec(formHtml);
  if (!openTagMatch) return null;

  const rawAction = extractTagAttr(openTagMatch[0], 'action');
  if (!rawAction) return null;

  const confirmedUrl = new URL(decodeHtmlEntities(rawAction), baseUrl);
  const inputRegex = /<input\b[^>]*>/gi;
  let inputMatch: RegExpExecArray | null;
  while ((inputMatch = inputRegex.exec(byAction[1])) !== null) {
    const tag = inputMatch[0];
    const type = extractTagAttr(tag, 'type')?.toLowerCase();
    if (type && type !== 'hidden') continue;
    const name = extractTagAttr(tag, 'name');
    if (!name) continue;
    const value = extractTagAttr(tag, 'value') ?? '';
    confirmedUrl.searchParams.set(decodeHtmlEntities(name), decodeHtmlEntities(value));
  }

  return confirmedUrl;
}

function parseHtmlMetadata(html: string): { filename?: string; sizeBytes?: number } {
  const nameBlock =
    /<span\b[^>]*class=["'][^"']*uc-name-size[^"']*["'][^>]*>([\s\S]*?)<\/span>/i.exec(html);
  let filename: string | undefined;
  let sizeBytes: number | undefined;

  if (nameBlock) {
    const anchorMatch = /<a\b[^>]*>([^<]+)<\/a>/i.exec(nameBlock[1]);
    if (anchorMatch) {
      filename = normalizeHosterFilename(decodeHtmlEntities(anchorMatch[1]));
    }
    const afterAnchor = nameBlock[1].replace(/<[^>]+>/g, ' ');
    sizeBytes = parseHumanSize(afterAnchor);
  }

  if (!filename) {
    const openLink = /<a\b[^>]*href=["']\/open\?id=[^"']*["'][^>]*>([^<]+)<\/a>/i.exec(html);
    if (openLink) {
      filename = normalizeHosterFilename(decodeHtmlEntities(openLink[1]));
    }
  }

  return { filename, sizeBytes };
}

function getMimeType(headers: Headers): string | undefined {
  const raw = headers.get('content-type');
  if (!raw) return undefined;
  return raw.split(';')[0].trim().toLowerCase() || undefined;
}

export const gdriveResolver: UrlResolver = {
  id: 'gdrive',
  label: 'Google Drive',

  canHandle(url: URL): boolean {
    return extractGdriveFileId(url) !== null;
  },

  async resolve(url: URL, ctx: ResolverContext): Promise<ResolverOutput> {
    const fileId = extractGdriveFileId(url);
    if (!fileId) {
      throw new Error(`Unsupported Google Drive URL: ${url.toString()}`);
    }

    const candidateUrl = `https://drive.usercontent.google.com/download?id=${encodeURIComponent(fileId)}&export=download&confirm=t`;

    const head = await safeFetch(candidateUrl, {
      method: 'HEAD',
      headers: ctx.headers,
      signal: ctx.signal,
      proxyUrl: ctx.proxyUrl,
      fetchFn: ctx.fetchFn,
      lookupFn: ctx.lookupFn,
    });
    await head.response.body?.cancel().catch(() => {});

    const headMime = getMimeType(head.response.headers);
    const headFilename = normalizeHosterFilename(
      parseContentDispositionFilename(head.response.headers.get('content-disposition')),
    );
    const headSize = parseContentSize(head.response.headers);

    if (
      head.response.status >= 200 &&
      head.response.status < 300 &&
      headMime !== 'text/html' &&
      (Boolean(headFilename) || (headSize ?? 0) > 0)
    ) {
      return {
        items: [
          {
            downloadUrl: head.finalUrl,
            filename: headFilename,
            sizeBytes: headSize,
            mimeType: headMime,
            sourceUrl: url.toString(),
            hoster: 'Google Drive',
          },
        ],
      };
    }

    const get = await safeFetch(candidateUrl, {
      method: 'GET',
      headers: ctx.headers,
      signal: ctx.signal,
      proxyUrl: ctx.proxyUrl,
      fetchFn: ctx.fetchFn,
      lookupFn: ctx.lookupFn,
    });

    if (get.response.status === 404) {
      await get.response.body?.cancel().catch(() => {});
      throw new Error('Google Drive file not found or not publicly shared (HTTP 404)');
    }

    const getMime = getMimeType(get.response.headers);
    if (getMime !== 'text/html') {
      await get.response.body?.cancel().catch(() => {});
      if (get.response.status >= 400) {
        throw new Error(`Google Drive returned HTTP ${get.response.status}`);
      }
      return {
        items: [
          {
            downloadUrl: get.finalUrl,
            filename: normalizeHosterFilename(
              parseContentDispositionFilename(get.response.headers.get('content-disposition')),
            ),
            sizeBytes: parseContentSize(get.response.headers),
            mimeType: getMime,
            sourceUrl: url.toString(),
            hoster: 'Google Drive',
          },
        ],
      };
    }

    const html = await readBoundedText(get.response);
    const lower = html.toLowerCase();

    if (
      lower.includes('accounts.google.com') ||
      lower.includes('servicelogin') ||
      lower.includes('you need access') ||
      lower.includes('request access')
    ) {
      throw new Error(
        'Google Drive file is private or requires sign-in (anonymous download only supports public links)',
      );
    }

    if (
      lower.includes('too many users have viewed or downloaded this file recently') ||
      lower.includes('quota exceeded')
    ) {
      throw new Error('Google Drive download quota exceeded for this file');
    }

    const confirmedUrl = parseConfirmationForm(html, get.finalUrl);
    if (!confirmedUrl) {
      throw new Error(
        'Google Drive returned an HTML page instead of a downloadable file (verify the link is shared as "Anyone with the link")',
      );
    }

    const htmlMeta = parseHtmlMetadata(html);
    let finalDownloadUrl = confirmedUrl.toString();
    let finalFilename = htmlMeta.filename;
    let finalSize = htmlMeta.sizeBytes;
    let finalMime: string | undefined;

    try {
      const confirmedHead = await safeFetch(finalDownloadUrl, {
        method: 'HEAD',
        headers: ctx.headers,
        signal: ctx.signal,
        proxyUrl: ctx.proxyUrl,
        fetchFn: ctx.fetchFn,
        lookupFn: ctx.lookupFn,
      });
      await confirmedHead.response.body?.cancel().catch(() => {});
      const probeMime = getMimeType(confirmedHead.response.headers);
      if (
        confirmedHead.response.status >= 200 &&
        confirmedHead.response.status < 300 &&
        probeMime !== 'text/html'
      ) {
        finalDownloadUrl = confirmedHead.finalUrl;
        finalFilename =
          normalizeHosterFilename(
            parseContentDispositionFilename(
              confirmedHead.response.headers.get('content-disposition'),
            ),
          ) ?? finalFilename;
        finalSize = parseContentSize(confirmedHead.response.headers) ?? finalSize;
        finalMime = probeMime;
      }
    } catch {
      // Fall back to the parsed confirmation URL and HTML metadata when HEAD fails.
    }

    return {
      items: [
        {
          downloadUrl: finalDownloadUrl,
          filename: finalFilename,
          sizeBytes: finalSize,
          mimeType: finalMime,
          sourceUrl: url.toString(),
          hoster: 'Google Drive',
        },
      ],
    };
  },
};
