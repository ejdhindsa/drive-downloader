import { readBoundedText, safeFetch } from '../../utils/security';
import type { ResolverContext, ResolverOutput, UrlResolver } from '../types';
import {
  DEFAULT_USER_AGENT,
  decodeHtmlEntities,
  detectCaptchaOrAntiBot,
  mergeRequestHeaders,
  normalizeHosterFilename,
  parseHumanSize,
} from './helpers';

function matchesOnefichierUrl(url: URL): boolean {
  const host = url.hostname.toLowerCase();
  if (host !== '1fichier.com' && host !== 'www.1fichier.com') return false;
  if (url.pathname !== '/') return false;
  return /^\?[A-Za-z0-9]{6,}(?:&.*)?$/.test(url.search);
}

function extractTagAttr(tag: string, attrName: string): string | undefined {
  const regex = new RegExp(`\\b${attrName}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i');
  const match = regex.exec(tag);
  if (!match) return undefined;
  return match[1] ?? match[2] ?? match[3];
}

function detectCooldownError(html: string): string | null {
  if (
    /You must wait|Without premium status|vous devez attendre|already downloading|ct_warn/i.test(
      html,
    )
  ) {
    const waitMatch = /wait\s+(?:at\s+least\s+)?(\d+\s*(?:minutes?|mins?|seconds?|secs?|hours?))/i.exec(
      html,
    );
    return waitMatch
      ? `1fichier free-tier cooldown active (wait ${waitMatch[1]})`
      : '1fichier free-tier cooldown or concurrent download limit is active';
  }
  return null;
}

function extractPageMetadata(html: string): { filename?: string; sizeBytes?: number } {
  let filename: string | undefined;
  const nameMatch =
    /(?:Filename|Nom du fichier)\s*<\/td>\s*<td[^>]*>\s*([^<]+)\s*<\/td>/i.exec(html);
  if (nameMatch) {
    filename = normalizeHosterFilename(decodeHtmlEntities(nameMatch[1]));
  }

  let sizeBytes: number | undefined;
  const sizeMatch = /(?:Size|Taille)\s*<\/td>\s*<td[^>]*>\s*([^<]+)\s*<\/td>/i.exec(html);
  if (sizeMatch) {
    sizeBytes = parseHumanSize(decodeHtmlEntities(sizeMatch[1]));
  }

  return { filename, sizeBytes };
}

function extractDirectDownloadLink(html: string): string | undefined {
  const anchorRegex = /<a\b[^>]*>/gi;
  let match: RegExpExecArray | null;
  while ((match = anchorRegex.exec(html)) !== null) {
    const tag = match[0];
    const cls = extractTagAttr(tag, 'class') ?? '';
    const href = extractTagAttr(tag, 'href');
    if (!href) continue;
    if (/\bok\b/i.test(cls) && /^https?:\/\/[^/]*1fichier\.com\//i.test(href)) {
      return decodeHtmlEntities(href.trim());
    }
  }
  return undefined;
}

function extractAdzToken(html: string): string | undefined {
  const inputRegex = /<input\b[^>]*>/gi;
  let match: RegExpExecArray | null;
  while ((match = inputRegex.exec(html)) !== null) {
    const tag = match[0];
    const name = extractTagAttr(tag, 'name');
    if (name === 'adz') {
      return extractTagAttr(tag, 'value') ?? '';
    }
  }
  return undefined;
}

function checkPageErrors(html: string): void {
  const captchaReason = detectCaptchaOrAntiBot(html);
  if (captchaReason) {
    throw new Error(`1fichier blocked by ${captchaReason}`);
  }
  if (
    /file not found|requested file could not be found|file has been deleted|fichier demandé n'existe pas/i.test(
      html,
    )
  ) {
    throw new Error('1fichier file not found or has been deleted');
  }
  if (/\bname\s*=\s*["']pass["']/i.test(html)) {
    throw new Error('1fichier file is password-protected');
  }
  const cooldown = detectCooldownError(html);
  if (cooldown) {
    throw new Error(cooldown);
  }
}

export const onefichierResolver: UrlResolver = {
  id: 'onefichier',
  label: '1fichier',

  canHandle(url: URL): boolean {
    return matchesOnefichierUrl(url);
  },

  async resolve(url: URL, ctx: ResolverContext): Promise<ResolverOutput> {
    const reqHeaders = mergeRequestHeaders(ctx.headers, {
      'User-Agent': DEFAULT_USER_AGENT,
    });

    const getRes = await safeFetch(url.toString(), {
      method: 'GET',
      headers: reqHeaders,
      signal: ctx.signal,
      proxyUrl: ctx.proxyUrl,
      fetchFn: ctx.fetchFn,
      lookupFn: ctx.lookupFn,
    });

    if (getRes.response.status === 404 || getRes.response.status === 410) {
      await getRes.response.body?.cancel().catch(() => {});
      throw new Error(`1fichier file not found or removed (HTTP ${getRes.response.status})`);
    }

    const html = await readBoundedText(getRes.response);
    checkPageErrors(html);

    const meta = extractPageMetadata(html);
    const existingLink = extractDirectDownloadLink(html);
    if (existingLink) {
      return {
        items: [
          {
            downloadUrl: existingLink,
            filename: meta.filename,
            sizeBytes: meta.sizeBytes,
            sourceUrl: url.toString(),
            hoster: '1fichier',
          },
        ],
      };
    }

    const adz = extractAdzToken(html);
    if (adz === undefined) {
      throw new Error('1fichier download token was not found on page');
    }

    const postHeaders = mergeRequestHeaders(reqHeaders, {
      'Content-Type': 'application/x-www-form-urlencoded',
      Referer: getRes.finalUrl,
    });
    const body = `adz=${encodeURIComponent(adz)}&dl_no_ssl=off&dlinline=off`;

    const postRes = await safeFetch(getRes.finalUrl, {
      method: 'POST',
      headers: postHeaders,
      body,
      signal: ctx.signal,
      proxyUrl: ctx.proxyUrl,
      fetchFn: ctx.fetchFn,
      lookupFn: ctx.lookupFn,
    });
    const postHtml = await readBoundedText(postRes.response);
    checkPageErrors(postHtml);

    const directLink = extractDirectDownloadLink(postHtml);
    if (!directLink) {
      throw new Error('1fichier did not return a direct download link');
    }

    return {
      items: [
        {
          downloadUrl: directLink,
          filename: meta.filename,
          sizeBytes: meta.sizeBytes,
          sourceUrl: url.toString(),
          hoster: '1fichier',
        },
      ],
    };
  },
};
