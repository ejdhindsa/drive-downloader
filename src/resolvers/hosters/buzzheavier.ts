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

const RESERVED_PATHS = new Set([
  'login',
  'register',
  'signup',
  'about',
  'privacy',
  'terms',
  'api',
  'notfound',
  'faq',
  'contact',
  'dmca',
]);

function parseBuzzheavierId(url: URL): string | null {
  const host = url.hostname.toLowerCase();
  if (host !== 'buzzheavier.com' && host !== 'www.buzzheavier.com') return null;
  const match = /^\/([A-Za-z0-9_-]{4,})\/?$/.exec(url.pathname);
  if (!match) return null;
  const id = match[1];
  if (RESERVED_PATHS.has(id.toLowerCase())) return null;
  return id;
}

function extractPageMetadata(html: string): { filename?: string; sizeBytes?: number } {
  let filename: string | undefined;
  const titleMatch = /<title[^>]*>([^<]+)<\/title>/i.exec(html);
  if (titleMatch) {
    const cleanedTitle = decodeHtmlEntities(titleMatch[1])
      .replace(/\s*[-|]\s*Buzzheavier\s*$/i, '')
      .trim();
    if (cleanedTitle && !/^buzzheavier$/i.test(cleanedTitle)) {
      filename = normalizeHosterFilename(cleanedTitle);
    }
  }
  if (!filename) {
    const h1Match = /<h1[^>]*>([^<]+)<\/h1>/i.exec(html);
    if (h1Match) {
      filename = normalizeHosterFilename(decodeHtmlEntities(h1Match[1]));
    }
  }
  const sizeBytes = parseHumanSize(html.replace(/<[^>]+>/g, ' '));
  return { filename, sizeBytes };
}

export const buzzheavierResolver: UrlResolver = {
  id: 'buzzheavier',
  label: 'Buzzheavier',

  canHandle(url: URL): boolean {
    return parseBuzzheavierId(url) !== null;
  },

  async resolve(url: URL, ctx: ResolverContext): Promise<ResolverOutput> {
    const id = parseBuzzheavierId(url);
    if (!id) {
      throw new Error(`Unsupported Buzzheavier URL: ${url.toString()}`);
    }

    const pageUrl = `https://buzzheavier.com/${id}`;
    const pageHeaders = mergeRequestHeaders(ctx.headers, {
      'User-Agent': DEFAULT_USER_AGENT,
    });

    const pageRes = await safeFetch(pageUrl, {
      method: 'GET',
      headers: pageHeaders,
      signal: ctx.signal,
      proxyUrl: ctx.proxyUrl,
      fetchFn: ctx.fetchFn,
      lookupFn: ctx.lookupFn,
    });
    const pageHtml = await readBoundedText(pageRes.response);

    if (pageRes.response.status === 404) {
      throw new Error('Buzzheavier file not found or deleted (HTTP 404)');
    }

    const pageCaptcha = detectCaptchaOrAntiBot(pageHtml);
    if (pageCaptcha) {
      throw new Error(`Buzzheavier blocked by ${pageCaptcha}`);
    }

    if (/File not found|This file does not exist|has been deleted/i.test(pageHtml)) {
      throw new Error('Buzzheavier file not found or deleted');
    }

    const pageMeta = extractPageMetadata(pageHtml);

    const dlEndpoint = `https://buzzheavier.com/${id}/download`;
    const dlHeaders = mergeRequestHeaders(ctx.headers, {
      'User-Agent': DEFAULT_USER_AGENT,
      'HX-Request': 'true',
      'HX-Current-URL': pageUrl,
      Referer: pageUrl,
    });

    const dlRes = await safeFetch(dlEndpoint, {
      method: 'GET',
      headers: dlHeaders,
      followRedirects: false,
      signal: ctx.signal,
      proxyUrl: ctx.proxyUrl,
      fetchFn: ctx.fetchFn,
      lookupFn: ctx.lookupFn,
    });

    const redirectHeader =
      dlRes.response.headers.get('hx-redirect') || dlRes.response.headers.get('location');

    if (!redirectHeader) {
      const dlType = (dlRes.response.headers.get('content-type') ?? '').toLowerCase();
      if (dlType.includes('text/html')) {
        const dlHtml = await readBoundedText(dlRes.response);
        const dlCaptcha = detectCaptchaOrAntiBot(dlHtml);
        if (dlCaptcha) {
          throw new Error(`Buzzheavier blocked by ${dlCaptcha}`);
        }
      } else {
        await dlRes.response.body?.cancel().catch(() => {});
      }
      throw new Error('Buzzheavier did not return a direct download redirect');
    }

    await dlRes.response.body?.cancel().catch(() => {});
    let targetUrl = new URL(redirectHeader.trim(), dlRes.finalUrl).toString();
    let filename = pageMeta.filename;
    let sizeBytes = pageMeta.sizeBytes;
    let mimeType: string | undefined;

    if (!filename || !sizeBytes) {
      try {
        const head = await safeFetch(targetUrl, {
          method: 'HEAD',
          headers: pageHeaders,
          signal: ctx.signal,
          proxyUrl: ctx.proxyUrl,
          fetchFn: ctx.fetchFn,
          lookupFn: ctx.lookupFn,
        });
        await head.response.body?.cancel().catch(() => {});
        if (head.response.status >= 200 && head.response.status < 300) {
          targetUrl = head.finalUrl;
          filename =
            filename ??
            normalizeHosterFilename(
              parseContentDispositionFilename(head.response.headers.get('content-disposition')),
            );
          sizeBytes = sizeBytes ?? parseContentSize(head.response.headers);
          const rawMime = head.response.headers.get('content-type');
          if (rawMime) {
            mimeType = rawMime.split(';')[0].trim().toLowerCase() || undefined;
          }
        }
      } catch {
        // Keep the resolved redirect target even if HEAD enrichment fails.
      }
    }

    return {
      items: [
        {
          downloadUrl: targetUrl,
          filename,
          sizeBytes,
          mimeType,
          sourceUrl: url.toString(),
          hoster: 'Buzzheavier',
        },
      ],
    };
  },
};
