import path from 'node:path';
import { safeFetch } from '../utils/security';
import type { ResolverContext, ResolverOutput, UrlResolver } from './types';

function cleanCandidateFilename(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const trimmed = raw.trim().replace(/^["']|["']$/g, '');
  if (!trimmed) return undefined;
  const base = path.posix.basename(trimmed.replace(/\\/g, '/'));
  const safe = base.replace(/[\x00-\x1f\x7f]/g, '').trim();
  if (!safe || safe === '.' || safe === '..') return undefined;
  return safe;
}

export function parseContentDispositionFilename(header: string | null): string | undefined {
  if (!header) return undefined;

  const starMatch = /filename\*\s*=\s*(?:UTF-8''|utf-8'')([^;]+)/i.exec(header);
  if (starMatch) {
    try {
      const decoded = decodeURIComponent(starMatch[1].trim());
      const cleaned = cleanCandidateFilename(decoded);
      if (cleaned) return cleaned;
    } catch {
      // Fall through to standard filename parameter.
    }
  }

  const quotedMatch = /filename\s*=\s*"([^"]+)"/i.exec(header);
  if (quotedMatch) {
    const cleaned = cleanCandidateFilename(quotedMatch[1]);
    if (cleaned) return cleaned;
  }

  const plainMatch = /filename\s*=\s*([^;\s]+)/i.exec(header);
  if (plainMatch) {
    const cleaned = cleanCandidateFilename(plainMatch[1]);
    if (cleaned) return cleaned;
  }

  return undefined;
}

export function parseContentSize(headers: Headers): number | undefined {
  const contentRange = headers.get('content-range');
  if (contentRange) {
    const match = /\/\s*(\d+)$/.exec(contentRange.trim());
    if (match) {
      const total = Number.parseInt(match[1], 10);
      if (Number.isFinite(total) && total > 0) return total;
    }
  }

  const contentLength = headers.get('content-length');
  if (contentLength) {
    const size = Number.parseInt(contentLength.trim(), 10);
    if (Number.isFinite(size) && size > 0) return size;
  }

  return undefined;
}

function filenameFromUrl(rawUrl: string): string | undefined {
  try {
    const parsed = new URL(rawUrl);
    const seg = parsed.pathname.split('/').filter(Boolean).pop();
    if (!seg) return undefined;
    return cleanCandidateFilename(decodeURIComponent(seg));
  } catch {
    return undefined;
  }
}

export const directResolver: UrlResolver = {
  id: 'direct',
  label: 'Direct',

  canHandle(): boolean {
    return true;
  },

  async resolve(url: URL, ctx: ResolverContext): Promise<ResolverOutput> {
    const head = await safeFetch(url.toString(), {
      method: 'HEAD',
      headers: ctx.headers,
      signal: ctx.signal,
      proxyUrl: ctx.proxyUrl,
      fetchFn: ctx.fetchFn,
      lookupFn: ctx.lookupFn,
    });
    await head.response.body?.cancel().catch(() => {});

    let response = head.response;
    let finalUrl = head.finalUrl;

    if (response.status === 403 || response.status === 405 || response.status === 501) {
      const probeHeaders = [...ctx.headers, { name: 'Range', value: 'bytes=0-0' }];
      const probe = await safeFetch(finalUrl, {
        method: 'GET',
        headers: probeHeaders,
        signal: ctx.signal,
        proxyUrl: ctx.proxyUrl,
        fetchFn: ctx.fetchFn,
        lookupFn: ctx.lookupFn,
      });
      await probe.response.body?.cancel().catch(() => {});
      response = probe.response;
      finalUrl = probe.finalUrl;
    }

    const filename =
      parseContentDispositionFilename(response.headers.get('content-disposition')) ??
      filenameFromUrl(finalUrl);
    const sizeBytes = parseContentSize(response.headers);
    const rawMime = response.headers.get('content-type');
    const mimeType = rawMime ? rawMime.split(';')[0].trim().toLowerCase() : undefined;
    const note =
      ctx.inspectOnly && response.status >= 400
        ? `Remote server returned HTTP ${response.status} during pre-flight check`
        : undefined;

    return {
      items: [
        {
          downloadUrl: finalUrl,
          filename,
          sizeBytes,
          mimeType,
          sourceUrl: url.toString(),
          hoster: 'Direct',
          note,
        },
      ],
    };
  },
};
