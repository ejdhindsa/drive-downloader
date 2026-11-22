import { readBoundedText, safeFetch } from '../../utils/security';
import type { ResolvedTarget } from '../../types';
import type { ResolverContext, ResolverOutput, UrlResolver } from '../types';
import {
  DEFAULT_USER_AGENT,
  hostMatches,
  mergeRequestHeaders,
  normalizeHosterFilename,
} from './helpers';

const GOFILE_WEBSITE_TOKEN = '4fd6sg89d7s6';

interface GofileAccountResponse {
  status?: string;
  data?: {
    token?: string;
  };
}

interface GofileChild {
  id?: string;
  type?: string;
  name?: string;
  size?: number;
  mimetype?: string;
  link?: string;
}

interface GofileContentsResponse {
  status?: string;
  data?: {
    password?: boolean | string;
    passwordStatus?: string;
    children?: Record<string, GofileChild> | GofileChild[];
  };
}

function parseGofileId(url: URL): string | null {
  if (!hostMatches(url.hostname, 'gofile.io')) return null;
  const match = /^\/d\/([A-Za-z0-9_-]+)\/?$/.exec(url.pathname);
  return match ? match[1] : null;
}

export const gofileResolver: UrlResolver = {
  id: 'gofile',
  label: 'Gofile',

  canHandle(url: URL): boolean {
    return parseGofileId(url) !== null;
  },

  async resolve(url: URL, ctx: ResolverContext): Promise<ResolverOutput> {
    const contentId = parseGofileId(url);
    if (!contentId) {
      throw new Error(`Unsupported Gofile URL: ${url.toString()}`);
    }

    const baseHeaders = mergeRequestHeaders(ctx.headers, {
      'User-Agent': DEFAULT_USER_AGENT,
      Accept: 'application/json',
    });

    const accountRes = await safeFetch('https://api.gofile.io/accounts', {
      method: 'POST',
      headers: baseHeaders,
      signal: ctx.signal,
      proxyUrl: ctx.proxyUrl,
      fetchFn: ctx.fetchFn,
      lookupFn: ctx.lookupFn,
    });
    const accountText = await readBoundedText(accountRes.response);
    let accountJson: GofileAccountResponse;
    try {
      accountJson = JSON.parse(accountText) as GofileAccountResponse;
    } catch {
      throw new Error(`Gofile returned invalid JSON from /accounts (HTTP ${accountRes.response.status})`);
    }

    const token = accountJson.data?.token;
    if (!accountRes.response.ok || accountJson.status !== 'ok' || !token) {
      throw new Error(`Gofile: failed to create guest session (${accountJson.status || `HTTP ${accountRes.response.status}`})`);
    }

    const contentHeaders = mergeRequestHeaders(baseHeaders, {
      Authorization: `Bearer ${token}`,
      'X-Website-Token': GOFILE_WEBSITE_TOKEN,
    });

    const contentUrl = `https://api.gofile.io/contents/${encodeURIComponent(contentId)}?wt=${GOFILE_WEBSITE_TOKEN}`;
    const contentRes = await safeFetch(contentUrl, {
      method: 'GET',
      headers: contentHeaders,
      signal: ctx.signal,
      proxyUrl: ctx.proxyUrl,
      fetchFn: ctx.fetchFn,
      lookupFn: ctx.lookupFn,
    });
    const contentText = await readBoundedText(contentRes.response);
    let contentJson: GofileContentsResponse;
    try {
      contentJson = JSON.parse(contentText) as GofileContentsResponse;
    } catch {
      throw new Error(
        `Gofile returned invalid JSON from /contents (HTTP ${contentRes.response.status})`,
      );
    }

    if (contentJson.status === 'error-notFound') {
      throw new Error('Gofile folder or file not found');
    }
    if (contentJson.status === 'error-notPublic') {
      throw new Error('Gofile folder is not public');
    }
    if (!contentRes.response.ok || contentJson.status !== 'ok' || !contentJson.data) {
      throw new Error(
        `Gofile: ${contentJson.status || `HTTP ${contentRes.response.status}`}`,
      );
    }

    const rawChildren = contentJson.data.children;
    const children: GofileChild[] = Array.isArray(rawChildren)
      ? rawChildren
      : rawChildren && typeof rawChildren === 'object'
        ? Object.values(rawChildren)
        : [];

    if (
      (contentJson.data.passwordStatus && contentJson.data.passwordStatus !== 'passwordOk') ||
      (contentJson.data.password === true && children.length === 0)
    ) {
      throw new Error('Gofile folder is password-protected');
    }

    const items: ResolvedTarget[] = [];
    const warnings: string[] = [];

    for (const child of children) {
      if (child.type === 'folder') {
        warnings.push(`Skipped nested Gofile subfolder "${child.name || child.id || 'folder'}"`);
        continue;
      }
      if (child.type === 'file' && typeof child.link === 'string' && child.link) {
        items.push({
          downloadUrl: child.link,
          filename: normalizeHosterFilename(child.name),
          sizeBytes:
            typeof child.size === 'number' && Number.isFinite(child.size) && child.size > 0
              ? child.size
              : undefined,
          mimeType: typeof child.mimetype === 'string' ? child.mimetype : undefined,
          headers: [{ name: 'Cookie', value: `accountToken=${token}` }],
          note: 'Requires Staged mode (uses session cookie)',
          sourceUrl: url.toString(),
          hoster: 'Gofile',
        });
      }
    }

    if (items.length === 0) {
      throw new Error('Gofile folder contains no downloadable files');
    }

    return { items, warnings };
  },
};
