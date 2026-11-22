import { readBoundedText, safeFetch } from '../../utils/security';
import type { ResolvedTarget } from '../../types';
import type { ResolverContext, ResolverOutput, UrlResolver } from '../types';
import { DEFAULT_USER_AGENT, hostMatches, mergeRequestHeaders, normalizeHosterFilename } from './helpers';

interface PixeldrainFileInfo {
  id?: string;
  name?: string;
  size?: number;
  mime_type?: string;
  can_download?: boolean;
  availability?: string;
  success?: boolean;
  message?: string;
}

interface PixeldrainListResponse {
  id?: string;
  title?: string;
  files?: PixeldrainFileInfo[];
  success?: boolean;
  message?: string;
}

function parsePixeldrainPath(url: URL): { kind: 'u' | 'l'; id: string } | null {
  if (!hostMatches(url.hostname, 'pixeldrain.com')) return null;
  const match = /^\/(u|l)\/([A-Za-z0-9_-]+)\/?$/.exec(url.pathname);
  if (!match) return null;
  return { kind: match[1] as 'u' | 'l', id: match[2] };
}

export const pixeldrainResolver: UrlResolver = {
  id: 'pixeldrain',
  label: 'Pixeldrain',

  canHandle(url: URL): boolean {
    return parsePixeldrainPath(url) !== null;
  },

  async resolve(url: URL, ctx: ResolverContext): Promise<ResolverOutput> {
    const parsed = parsePixeldrainPath(url);
    if (!parsed) {
      throw new Error(`Unsupported Pixeldrain URL: ${url.toString()}`);
    }

    const reqHeaders = mergeRequestHeaders(ctx.headers, {
      'User-Agent': DEFAULT_USER_AGENT,
      Accept: 'application/json',
    });

    if (parsed.kind === 'u') {
      const infoUrl = `https://pixeldrain.com/api/file/${encodeURIComponent(parsed.id)}/info`;
      const { response } = await safeFetch(infoUrl, {
        headers: reqHeaders,
        signal: ctx.signal,
        proxyUrl: ctx.proxyUrl,
        fetchFn: ctx.fetchFn,
        lookupFn: ctx.lookupFn,
      });
      const text = await readBoundedText(response);
      let data: PixeldrainFileInfo;
      try {
        data = JSON.parse(text) as PixeldrainFileInfo;
      } catch {
        throw new Error(`Pixeldrain returned invalid JSON (HTTP ${response.status})`);
      }

      if (!response.ok || data.success === false) {
        throw new Error(`Pixeldrain: ${data.message || `HTTP ${response.status}`}`);
      }
      if (data.can_download === false) {
        throw new Error(
          `Pixeldrain file is not downloadable (${data.availability || 'unavailable'})`,
        );
      }

      return {
        items: [
          {
            downloadUrl: `https://pixeldrain.com/api/file/${encodeURIComponent(parsed.id)}`,
            filename: normalizeHosterFilename(data.name),
            sizeBytes:
              typeof data.size === 'number' && Number.isFinite(data.size) && data.size > 0
                ? data.size
                : undefined,
            mimeType: typeof data.mime_type === 'string' ? data.mime_type : undefined,
            sourceUrl: url.toString(),
            hoster: 'Pixeldrain',
          },
        ],
      };
    }

    const listUrl = `https://pixeldrain.com/api/list/${encodeURIComponent(parsed.id)}`;
    const { response } = await safeFetch(listUrl, {
      headers: reqHeaders,
      signal: ctx.signal,
      proxyUrl: ctx.proxyUrl,
      fetchFn: ctx.fetchFn,
      lookupFn: ctx.lookupFn,
    });
    const text = await readBoundedText(response);
    let data: PixeldrainListResponse;
    try {
      data = JSON.parse(text) as PixeldrainListResponse;
    } catch {
      throw new Error(`Pixeldrain returned invalid JSON (HTTP ${response.status})`);
    }

    if (!response.ok || data.success === false) {
      throw new Error(`Pixeldrain: ${data.message || `HTTP ${response.status}`}`);
    }

    const items: ResolvedTarget[] = [];
    const warnings: string[] = [];
    for (const file of data.files ?? []) {
      if (!file.id || file.can_download === false) {
        warnings.push(`Skipped unavailable Pixeldrain item: ${file.name || file.id || 'unknown'}`);
        continue;
      }
      items.push({
        downloadUrl: `https://pixeldrain.com/api/file/${encodeURIComponent(file.id)}`,
        filename: normalizeHosterFilename(file.name),
        sizeBytes:
          typeof file.size === 'number' && Number.isFinite(file.size) && file.size > 0
            ? file.size
            : undefined,
        mimeType: typeof file.mime_type === 'string' ? file.mime_type : undefined,
        sourceUrl: url.toString(),
        hoster: 'Pixeldrain',
      });
    }

    if (items.length === 0) {
      throw new Error('Pixeldrain list contains no downloadable files');
    }

    return { items, warnings };
  },
};
