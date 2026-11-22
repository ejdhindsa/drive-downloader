import { readBoundedText, safeFetch } from '../../utils/security';
import type { ResolvedTarget } from '../../types';
import type { ResolverContext, ResolverOutput, UrlResolver } from '../types';
import { DEFAULT_USER_AGENT, mergeRequestHeaders, normalizeHosterFilename } from './helpers';

interface ArchiveOrgFile {
  name?: string;
  size?: number | string;
  format?: string;
  private?: boolean | string;
}

interface ArchiveOrgMetadata {
  is_dark?: boolean;
  files?: ArchiveOrgFile[];
}

const INTERNAL_SUFFIXES = [
  '_meta.xml',
  '_files.xml',
  '_meta.sqlite',
  '_reviews.xml',
  '_archive.torrent',
  '__ia_thumb.jpg',
  '_scandata.xml',
];

const INTERNAL_FORMATS = new Set([
  'metadata',
  'archive bittorrent',
  'item tile',
  'thumbnail',
  'sqlite',
]);

function parseArchiveOrgId(url: URL): string | null {
  const host = url.hostname.toLowerCase();
  if (host !== 'archive.org' && host !== 'www.archive.org') return null;
  const match = /^\/details\/([^/]+)(?:\/.*)?$/.exec(url.pathname);
  return match ? decodeURIComponent(match[1]) : null;
}

function isInternalFile(file: ArchiveOrgFile): boolean {
  const name = file.name?.trim();
  if (!name) return true;
  if (file.private === true || file.private === 'true') return true;

  const lowerName = name.toLowerCase();
  if (lowerName.startsWith('.thumbs/')) return true;
  if (INTERNAL_SUFFIXES.some((suffix) => lowerName.endsWith(suffix))) return true;

  const lowerFormat = file.format?.trim().toLowerCase();
  if (lowerFormat && INTERNAL_FORMATS.has(lowerFormat)) return true;

  return false;
}

function parseFileSize(raw: number | string | undefined): number | undefined {
  if (typeof raw === 'number') {
    return Number.isFinite(raw) && raw > 0 ? Math.round(raw) : undefined;
  }
  if (typeof raw === 'string') {
    const parsed = Number.parseInt(raw.trim(), 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
  }
  return undefined;
}

export const archiveOrgResolver: UrlResolver = {
  id: 'archiveorg',
  label: 'Archive.org',

  canHandle(url: URL): boolean {
    return parseArchiveOrgId(url) !== null;
  },

  async resolve(url: URL, ctx: ResolverContext): Promise<ResolverOutput> {
    const id = parseArchiveOrgId(url);
    if (!id) {
      throw new Error(`Unsupported Archive.org URL: ${url.toString()}`);
    }

    const metadataUrl = `https://archive.org/metadata/${encodeURIComponent(id)}`;
    const headers = mergeRequestHeaders(ctx.headers, {
      'User-Agent': DEFAULT_USER_AGENT,
      Accept: 'application/json',
    });

    const { response } = await safeFetch(metadataUrl, {
      method: 'GET',
      headers,
      signal: ctx.signal,
      proxyUrl: ctx.proxyUrl,
      fetchFn: ctx.fetchFn,
      lookupFn: ctx.lookupFn,
    });
    const text = await readBoundedText(response);
    if (!response.ok) {
      throw new Error(`Archive.org metadata request failed (HTTP ${response.status})`);
    }

    let data: ArchiveOrgMetadata;
    try {
      data = JSON.parse(text) as ArchiveOrgMetadata;
    } catch {
      throw new Error(`Archive.org returned invalid JSON (HTTP ${response.status})`);
    }

    if (data.is_dark) {
      throw new Error(`Archive.org item "${id}" is unavailable`);
    }

    const items: ResolvedTarget[] = [];
    for (const file of data.files ?? []) {
      if (isInternalFile(file) || !file.name) continue;
      const encodedPath = file.name
        .split('/')
        .filter(Boolean)
        .map((seg) => encodeURIComponent(seg))
        .join('/');
      if (!encodedPath) continue;

      items.push({
        downloadUrl: `https://archive.org/download/${encodeURIComponent(id)}/${encodedPath}`,
        filename: normalizeHosterFilename(file.name),
        sizeBytes: parseFileSize(file.size),
        sourceUrl: url.toString(),
        hoster: 'Archive.org',
      });
    }

    if (items.length === 0) {
      throw new Error(`Archive.org item "${id}" contains no downloadable files`);
    }

    return { items };
  },
};
