import { readBoundedText, safeFetch } from '../../utils/security';
import type { ResolvedTarget } from '../../types';
import type { ResolverContext, ResolverOutput, UrlResolver } from '../types';
import { DEFAULT_USER_AGENT, mergeRequestHeaders, normalizeHosterFilename } from './helpers';

interface GitHubReleaseAsset {
  name?: string;
  size?: number;
  content_type?: string;
  browser_download_url?: string;
}

interface GitHubReleaseResponse {
  message?: string;
  assets?: GitHubReleaseAsset[];
}

function parseGitHubReleaseUrl(
  url: URL,
): { owner: string; repo: string; tag?: string } | null {
  const host = url.hostname.toLowerCase();
  if (host !== 'github.com' && host !== 'www.github.com') return null;
  const match = /^\/([^/]+)\/([^/]+)\/releases\/(?:latest\/?|tag\/([^/]+)\/?)$/.exec(
    url.pathname,
  );
  if (!match) return null;
  return {
    owner: decodeURIComponent(match[1]),
    repo: decodeURIComponent(match[2]),
    tag: match[3] ? decodeURIComponent(match[3]) : undefined,
  };
}

export const githubResolver: UrlResolver = {
  id: 'github',
  label: 'GitHub',

  canHandle(url: URL): boolean {
    return parseGitHubReleaseUrl(url) !== null;
  },

  async resolve(url: URL, ctx: ResolverContext): Promise<ResolverOutput> {
    const parsed = parseGitHubReleaseUrl(url);
    if (!parsed) {
      throw new Error(`Unsupported GitHub Release URL: ${url.toString()}`);
    }

    const apiUrl = parsed.tag
      ? `https://api.github.com/repos/${encodeURIComponent(parsed.owner)}/${encodeURIComponent(parsed.repo)}/releases/tags/${encodeURIComponent(parsed.tag)}`
      : `https://api.github.com/repos/${encodeURIComponent(parsed.owner)}/${encodeURIComponent(parsed.repo)}/releases/latest`;

    const headers = mergeRequestHeaders(ctx.headers, {
      Accept: 'application/vnd.github+json',
      'User-Agent': DEFAULT_USER_AGENT,
      'X-GitHub-Api-Version': '2022-11-28',
    });

    const { response } = await safeFetch(apiUrl, {
      method: 'GET',
      headers,
      signal: ctx.signal,
      proxyUrl: ctx.proxyUrl,
      fetchFn: ctx.fetchFn,
      lookupFn: ctx.lookupFn,
    });

    const text = await readBoundedText(response);

    if (response.status === 404) {
      throw new Error('GitHub release not found');
    }

    if (
      (response.status === 403 || response.status === 429) &&
      response.headers.get('x-ratelimit-remaining') === '0'
    ) {
      throw new Error('GitHub API rate limit exceeded; retry later');
    }

    let data: GitHubReleaseResponse;
    try {
      data = JSON.parse(text) as GitHubReleaseResponse;
    } catch {
      throw new Error(`GitHub API returned invalid JSON (HTTP ${response.status})`);
    }

    if (!response.ok) {
      throw new Error(`GitHub API: ${data.message || `HTTP ${response.status}`}`);
    }

    const items: ResolvedTarget[] = [];
    for (const asset of data.assets ?? []) {
      if (!asset.browser_download_url) continue;
      items.push({
        downloadUrl: asset.browser_download_url,
        filename: normalizeHosterFilename(asset.name),
        sizeBytes:
          typeof asset.size === 'number' && Number.isFinite(asset.size) && asset.size > 0
            ? asset.size
            : undefined,
        mimeType: typeof asset.content_type === 'string' ? asset.content_type : undefined,
        sourceUrl: url.toString(),
        hoster: 'GitHub',
      });
    }

    if (items.length === 0) {
      throw new Error('GitHub release has no downloadable assets');
    }

    return { items };
  },
};
