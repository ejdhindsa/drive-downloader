import { readBoundedText, safeFetch } from '../../utils/security';
import { parseContentDispositionFilename, parseContentSize } from '../direct';
import type { ResolverContext, ResolverOutput, UrlResolver } from '../types';
import {
  DEFAULT_USER_AGENT,
  decodeHtmlEntities,
  detectCaptchaOrAntiBot,
  mergeRequestHeaders,
  normalizeHosterFilename,
  parseHumanSize,
} from './helpers';

function matchesMediafireUrl(url: URL): boolean {
  const host = url.hostname.toLowerCase();
  if (host !== 'mediafire.com' && host !== 'www.mediafire.com') return false;
  return /^\/(?:file|file_premium|download)\/([A-Za-z0-9]+)(?:\/|$)/.test(url.pathname);
}

function extractTagAttr(tag: string, attrName: string): string | undefined {
  const regex = new RegExp(`\\b${attrName}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i');
  const match = regex.exec(tag);
  if (!match) return undefined;
  return match[1] ?? match[2] ?? match[3];
}

function extractDirectLink(html: string): string | undefined {
  const anchorRegex = /<a\b[^>]*\bid\s*=\s*["']downloadButton["'][^>]*>/i;
  const anchorMatch = anchorRegex.exec(html);
  if (anchorMatch) {
    const tag = anchorMatch[0];
    const href = extractTagAttr(tag, 'href');
    if (href && /^https?:\/\//i.test(href.trim())) {
      return decodeHtmlEntities(href.trim());
    }
    const scrambled = extractTagAttr(tag, 'data-scrambled-url');
    if (scrambled) {
      try {
        const decoded = Buffer.from(scrambled.trim(), 'base64').toString('utf8').trim();
        if (/^https?:\/\//i.test(decoded)) {
          return decoded;
        }
      } catch {
        // Ignore invalid base64 and fall back to CDN URL scan.
      }
    }
  }

  const cdnMatch = /https?:\/\/download\d*\.mediafire\.com\/[^\s"'<>]+/i.exec(html);
  if (cdnMatch) {
    return decodeHtmlEntities(cdnMatch[0]);
  }

  return undefined;
}

function extractMetadata(html: string, downloadUrl: string): { filename?: string; sizeBytes?: number } {
  let filename: string | undefined;

  const btnLabelMatch = /<div\b[^>]*class=["'][^"']*dl-btn-label[^"']*["'][^>]*>/i.exec(html);
  if (btnLabelMatch) {
    const title = extractTagAttr(btnLabelMatch[0], 'title');
    if (title) {
      filename = normalizeHosterFilename(decodeHtmlEntities(title));
    }
  }

  if (!filename) {
    const filenameDiv = /<div\b[^>]*class=["'][^"']*filename[^"']*["'][^>]*>([^<]+)<\/div>/i.exec(
      html,
    );
    if (filenameDiv) {
      filename = normalizeHosterFilename(decodeHtmlEntities(filenameDiv[1]));
    }
  }

  if (!filename) {
    const labelText = /class=["'][^"']*dl-btn-label[^"']*["'][^>]*>([^<]+)</i.exec(html);
    if (labelText) {
      filename = normalizeHosterFilename(decodeHtmlEntities(labelText[1]));
    }
  }

  if (!filename) {
    try {
      const seg = new URL(downloadUrl).pathname.split('/').filter(Boolean).pop();
      if (seg) filename = normalizeHosterFilename(decodeURIComponent(seg));
    } catch {
      // Ignore malformed URL fallback.
    }
  }

  let sizeBytes: number | undefined;
  const downloadLabelSize = /Download\s*\(([^)]+)\)/i.exec(html);
  if (downloadLabelSize) {
    sizeBytes = parseHumanSize(downloadLabelSize[1]);
  }
  if (!sizeBytes) {
    const fileSizeBlock = /File size:\s*<[^>]*>([^<]+)</i.exec(html);
    if (fileSizeBlock) {
      sizeBytes = parseHumanSize(fileSizeBlock[1]);
    }
  }

  return { filename, sizeBytes };
}

export const mediafireResolver: UrlResolver = {
  id: 'mediafire',
  label: 'MediaFire',

  canHandle(url: URL): boolean {
    return matchesMediafireUrl(url);
  },

  async resolve(url: URL, ctx: ResolverContext): Promise<ResolverOutput> {
    const reqHeaders = mergeRequestHeaders(ctx.headers, {
      'User-Agent': DEFAULT_USER_AGENT,
    });

    const { response, finalUrl } = await safeFetch(url.toString(), {
      method: 'GET',
      headers: reqHeaders,
      signal: ctx.signal,
      proxyUrl: ctx.proxyUrl,
      fetchFn: ctx.fetchFn,
      lookupFn: ctx.lookupFn,
    });

    if (response.status === 404 || response.status === 410) {
      await response.body?.cancel().catch(() => {});
      throw new Error(`MediaFire file not found or removed (HTTP ${response.status})`);
    }

    const rawMime = response.headers.get('content-type');
    const mimeType = rawMime ? rawMime.split(';')[0].trim().toLowerCase() : undefined;
    if (mimeType && mimeType !== 'text/html' && mimeType !== 'application/xhtml+xml') {
      await response.body?.cancel().catch(() => {});
      if (response.status >= 400) {
        throw new Error(`MediaFire returned HTTP ${response.status}`);
      }
      return {
        items: [
          {
            downloadUrl: finalUrl,
            filename: normalizeHosterFilename(
              parseContentDispositionFilename(response.headers.get('content-disposition')),
            ),
            sizeBytes: parseContentSize(response.headers),
            mimeType,
            sourceUrl: url.toString(),
            hoster: 'MediaFire',
          },
        ],
      };
    }

    const html = await readBoundedText(response);

    const captchaReason = detectCaptchaOrAntiBot(html);
    if (captchaReason) {
      throw new Error(`MediaFire blocked by ${captchaReason}`);
    }

    if (
      /File Removed for Violation|Invalid or Deleted File|The file you requested has been blocked|Dangerous File Blocked/i.test(
        html,
      )
    ) {
      throw new Error('MediaFire file was removed or blocked');
    }

    const downloadUrl = extractDirectLink(html);
    if (!downloadUrl) {
      throw new Error('MediaFire direct download link not found on page');
    }

    const meta = extractMetadata(html, downloadUrl);

    return {
      items: [
        {
          downloadUrl,
          filename: meta.filename,
          sizeBytes: meta.sizeBytes,
          sourceUrl: url.toString(),
          hoster: 'MediaFire',
        },
      ],
    };
  },
};
