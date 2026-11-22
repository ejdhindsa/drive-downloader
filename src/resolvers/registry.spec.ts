import { describe, expect, it } from 'vitest';
import { directResolver, parseContentDispositionFilename, parseContentSize } from './direct';
import { createResolverRegistry } from './registry';
import type { UrlResolver } from './types';

const PUBLIC_LOOKUP = async () => [{ address: '93.184.216.34' }];

describe('directResolver & header parsing', () => {
  it('parses RFC 5987 filename* and quoted filename from Content-Disposition', () => {
    expect(
      parseContentDispositionFilename(
        `attachment; filename="fallback.mkv"; filename*=UTF-8''Movie%20%282024%29.mkv`,
      ),
    ).toBe('Movie (2024).mkv');
    expect(parseContentDispositionFilename(`attachment; filename="Show.S01E01.mkv"`)).toBe(
      'Show.S01E01.mkv',
    );
    expect(parseContentDispositionFilename(`attachment; filename=../../evil.txt`)).toBe('evil.txt');
    expect(parseContentDispositionFilename(null)).toBeUndefined();
  });

  it('extracts total size from Content-Range or Content-Length', () => {
    const rangeHeaders = new Headers({
      'content-length': '1',
      'content-range': 'bytes 0-0/4294967296',
    });
    expect(parseContentSize(rangeHeaders)).toBe(4294967296);

    const lenHeaders = new Headers({ 'content-length': '1048576' });
    expect(parseContentSize(lenHeaders)).toBe(1048576);
  });

  it('falls back from 405 HEAD to Range GET and collects metadata', async () => {
    const methods: string[] = [];
    const mockFetch: typeof fetch = async (_url, init) => {
      methods.push(init?.method ?? 'GET');
      if (init?.method === 'HEAD') {
        return new Response(null, { status: 405 });
      }
      return new Response('x', {
        status: 206,
        headers: {
          'content-disposition': `attachment; filename="Archive.7z"`,
          'content-range': 'bytes 0-0/52428800',
          'content-type': 'application/x-7z-compressed; charset=binary',
        },
      });
    };

    const result = await directResolver.resolve(new URL('https://cdn.example.com/dl/123'), {
      headers: [],
      signal: new AbortController().signal,
      inspectOnly: true,
      fetchFn: mockFetch,
      lookupFn: PUBLIC_LOOKUP,
    });

    expect(methods).toEqual(['HEAD', 'GET']);
    expect(result.items).toEqual([
      {
        downloadUrl: 'https://cdn.example.com/dl/123',
        filename: 'Archive.7z',
        sizeBytes: 52428800,
        mimeType: 'application/x-7z-compressed',
        sourceUrl: 'https://cdn.example.com/dl/123',
        hoster: 'Direct',
        note: undefined,
      },
    ]);
  });
});

describe('ResolverRegistry', () => {
  it('dispatches to matching hoster resolver and falls back to Direct', async () => {
    const customResolver: UrlResolver = {
      id: 'fakehost',
      label: 'FakeHost',
      canHandle: (url) => url.hostname === 'fakehost.example',
      resolve: async (url) => ({
        items: [
          {
            downloadUrl: `https://cdn.fakehost.example/raw${url.pathname}`,
            filename: 'Episode.01.mkv',
            sizeBytes: 1_500_000_000,
            hoster: 'FakeHost',
          },
        ],
      }),
    };

    const mockFetch: typeof fetch = async () =>
      new Response(null, {
        status: 200,
        headers: { 'content-length': '2048', 'content-type': 'video/x-matroska' },
      });

    const registry = createResolverRegistry([customResolver]);
    const batch = await registry.inspectUrls(
      ['https://fakehost.example/file/abc', 'https://files.example.com/clip.mkv'],
      {
        headers: [],
        signal: new AbortController().signal,
        fetchFn: mockFetch,
        lookupFn: PUBLIC_LOOKUP,
      },
    );

    expect(batch.warnings).toEqual([]);
    expect(batch.items).toHaveLength(2);
    expect(batch.items[0].hoster).toBe('FakeHost');
    expect(batch.items[0].downloadUrl).toBe('https://cdn.fakehost.example/raw/file/abc');
    expect(batch.items[1].hoster).toBe('Direct');
    expect(batch.items[1].filename).toBe('clip.mkv');
  });

  it('blocks SSRF when a resolver attempts to return a private IP downloadUrl', async () => {
    const maliciousResolver: UrlResolver = {
      id: 'evil',
      label: 'Evil',
      canHandle: (url) => url.hostname === 'evil.example',
      resolve: async () => ({
        items: [
          {
            downloadUrl: 'http://127.0.0.1:8080/internal-secret',
            hoster: 'Evil',
          },
        ],
      }),
    };

    const registry = createResolverRegistry([maliciousResolver]);
    await expect(
      registry.resolveUrl('https://evil.example/a', {
        headers: [],
        signal: new AbortController().signal,
        lookupFn: PUBLIC_LOOKUP,
      }),
    ).rejects.toThrow(/Blocked private or reserved IP/);
  });

  it('collects per-URL failures as warnings during batch inspect without failing valid URLs', async () => {
    const mockFetch: typeof fetch = async () =>
      new Response(null, { status: 200, headers: { 'content-length': '1024' } });

    const registry = createResolverRegistry();
    const result = await registry.inspectUrls(
      ['http://127.0.0.1/private', 'https://cdn.example.com/ok.zip'],
      {
        headers: [],
        signal: new AbortController().signal,
        fetchFn: mockFetch,
        lookupFn: PUBLIC_LOOKUP,
      },
    );

    expect(result.items).toHaveLength(1);
    expect(result.items[0].filename).toBe('ok.zip');
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toMatch(/Blocked private or reserved IP/);
  });

  it('registers all 10 built-in hoster resolvers plus Direct fallback and enforces SSRF on resolved targets', async () => {
    const registry = createResolverRegistry();
    const ids = registry.listResolvers().map((r) => r.id);

    expect(ids).toEqual([
      'pixeldrain',
      'gdrive',
      'gofile',
      'mediafire',
      'dropbox',
      'github',
      'huggingface',
      'archiveorg',
      'buzzheavier',
      'onefichier',
      'direct',
    ]);

    const maliciousHosterFetch: typeof fetch = async () =>
      new Response(
        JSON.stringify({
          status: 'ok',
          data: { token: 'tok' },
        }),
        { status: 200 },
      );

    let step = 0;
    const ssrfGofileFetch: typeof fetch = async () => {
      step += 1;
      if (step === 1) return maliciousHosterFetch(new Request('https://api.gofile.io/accounts'));
      return new Response(
        JSON.stringify({
          status: 'ok',
          data: {
            children: {
              f1: {
                id: 'f1',
                type: 'file',
                name: 'evil.mkv',
                link: 'http://169.254.169.254/latest/meta-data/',
              },
            },
          },
        }),
        { status: 200 },
      );
    };

    await expect(
      registry.resolveUrl('https://gofile.io/d/Evil123', {
        headers: [],
        signal: new AbortController().signal,
        fetchFn: ssrfGofileFetch,
        lookupFn: PUBLIC_LOOKUP,
      }),
    ).rejects.toThrow(/Blocked private or reserved IP/);
  });
});
