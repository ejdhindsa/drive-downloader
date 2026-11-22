import { describe, expect, it } from 'vitest';
import { githubResolver } from './github';

const PUBLIC_LOOKUP = async () => [{ address: '93.184.216.34' }];

describe('githubResolver', () => {
  it('matches release tag/latest URLs and leaves direct asset download URLs to Direct', () => {
    expect(githubResolver.canHandle(new URL('https://github.com/org/repo/releases/latest'))).toBe(
      true,
    );
    expect(
      githubResolver.canHandle(new URL('https://github.com/org/repo/releases/tag/v1.2.3')),
    ).toBe(true);
    expect(
      githubResolver.canHandle(
        new URL('https://github.com/org/repo/releases/download/v1.2.3/app.tar.gz'),
      ),
    ).toBe(false);
  });

  it('queries GitHub API with required headers and expands all release assets', async () => {
    let seenUrl = '';
    let seenHeaders: Record<string, string> = {};
    const mockFetch: typeof fetch = async (input, init) => {
      seenUrl = String(input);
      seenHeaders = (init?.headers as Record<string, string>) ?? {};
      return new Response(
        JSON.stringify({
          assets: [
            {
              name: 'tool-linux-amd64.tar.gz',
              size: 12_345_678,
              content_type: 'application/gzip',
              browser_download_url:
                'https://github.com/org/repo/releases/download/v1.2.3/tool-linux-amd64.tar.gz',
            },
            {
              name: 'tool-darwin-arm64.tar.gz',
              size: 11_000_000,
              content_type: 'application/gzip',
              browser_download_url:
                'https://github.com/org/repo/releases/download/v1.2.3/tool-darwin-arm64.tar.gz',
            },
          ],
        }),
        { status: 200 },
      );
    };

    const res = await githubResolver.resolve(
      new URL('https://github.com/org/repo/releases/tag/v1.2.3'),
      {
        headers: [],
        signal: new AbortController().signal,
        fetchFn: mockFetch,
        lookupFn: PUBLIC_LOOKUP,
      },
    );

    expect(seenUrl).toBe('https://api.github.com/repos/org/repo/releases/tags/v1.2.3');
    expect(seenHeaders.Accept).toBe('application/vnd.github+json');
    expect(seenHeaders['User-Agent']).toBe('drive-downloader/1.0');
    expect(res.items).toHaveLength(2);
    expect(res.items[0].hoster).toBe('GitHub');
    expect(res.items[0].filename).toBe('tool-linux-amd64.tar.gz');
    expect(res.items[1].filename).toBe('tool-darwin-arm64.tar.gz');
  });

  it('handles 404, rate-limit, and empty-asset releases clearly', async () => {
    const notFound: typeof fetch = async () =>
      new Response(JSON.stringify({ message: 'Not Found' }), { status: 404 });

    await expect(
      githubResolver.resolve(new URL('https://github.com/org/repo/releases/latest'), {
        headers: [],
        signal: new AbortController().signal,
        fetchFn: notFound,
        lookupFn: PUBLIC_LOOKUP,
      }),
    ).rejects.toThrow(/release not found/);

    const rateLimited: typeof fetch = async () =>
      new Response(JSON.stringify({ message: 'API rate limit exceeded' }), {
        status: 403,
        headers: { 'x-ratelimit-remaining': '0' },
      });

    await expect(
      githubResolver.resolve(new URL('https://github.com/org/repo/releases/latest'), {
        headers: [],
        signal: new AbortController().signal,
        fetchFn: rateLimited,
        lookupFn: PUBLIC_LOOKUP,
      }),
    ).rejects.toThrow(/rate limit exceeded/);

    const noAssets: typeof fetch = async () =>
      new Response(JSON.stringify({ assets: [] }), { status: 200 });

    await expect(
      githubResolver.resolve(new URL('https://github.com/org/repo/releases/latest'), {
        headers: [],
        signal: new AbortController().signal,
        fetchFn: noAssets,
        lookupFn: PUBLIC_LOOKUP,
      }),
    ).rejects.toThrow(/no downloadable assets/);
  });
});
