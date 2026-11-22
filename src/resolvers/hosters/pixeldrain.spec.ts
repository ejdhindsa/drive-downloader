import { describe, expect, it } from 'vitest';
import { pixeldrainResolver } from './pixeldrain';

const PUBLIC_LOOKUP = async () => [{ address: '93.184.216.34' }];

describe('pixeldrainResolver', () => {
  it('matches pixeldrain /u/ and /l/ URLs and ignores unrelated URLs', () => {
    expect(pixeldrainResolver.canHandle(new URL('https://pixeldrain.com/u/abc123'))).toBe(true);
    expect(pixeldrainResolver.canHandle(new URL('https://pixeldrain.com/l/listXYZ'))).toBe(true);
    expect(pixeldrainResolver.canHandle(new URL('https://pixeldrain.com/api/file/abc123'))).toBe(false);
    expect(pixeldrainResolver.canHandle(new URL('https://example.com/u/abc123'))).toBe(false);
  });

  it('resolves single file metadata to /api/file/{id}', async () => {
    const mockFetch: typeof fetch = async (input) => {
      expect(String(input)).toBe('https://pixeldrain.com/api/file/Abc123/info');
      return new Response(
        JSON.stringify({
          id: 'Abc123',
          name: 'Movie.2024.mkv',
          size: 2_500_000_000,
          mime_type: 'video/x-matroska',
          can_download: true,
        }),
        { status: 200 },
      );
    };

    const res = await pixeldrainResolver.resolve(new URL('https://pixeldrain.com/u/Abc123'), {
      headers: [],
      signal: new AbortController().signal,
      fetchFn: mockFetch,
      lookupFn: PUBLIC_LOOKUP,
    });

    expect(res.items).toEqual([
      {
        downloadUrl: 'https://pixeldrain.com/api/file/Abc123',
        filename: 'Movie.2024.mkv',
        sizeBytes: 2_500_000_000,
        mimeType: 'video/x-matroska',
        sourceUrl: 'https://pixeldrain.com/u/Abc123',
        hoster: 'Pixeldrain',
      },
    ]);
  });

  it('expands list links and warns on unavailable items', async () => {
    const mockFetch: typeof fetch = async (input) => {
      expect(String(input)).toBe('https://pixeldrain.com/api/list/List99');
      return new Response(
        JSON.stringify({
          success: true,
          files: [
            { id: 'f1', name: 'Ep01.mkv', size: 1000, mime_type: 'video/x-matroska', can_download: true },
            { id: 'f2', name: 'Ep02.mkv', size: 2000, can_download: false },
            { id: 'f3', name: 'Ep03.mkv', size: 3000, mime_type: 'video/mp4', can_download: true },
          ],
        }),
        { status: 200 },
      );
    };

    const res = await pixeldrainResolver.resolve(new URL('https://pixeldrain.com/l/List99'), {
      headers: [],
      signal: new AbortController().signal,
      fetchFn: mockFetch,
      lookupFn: PUBLIC_LOOKUP,
    });

    expect(res.items).toHaveLength(2);
    expect(res.items[0].downloadUrl).toBe('https://pixeldrain.com/api/file/f1');
    expect(res.items[1].downloadUrl).toBe('https://pixeldrain.com/api/file/f3');
    expect(res.warnings).toEqual(['Skipped unavailable Pixeldrain item: Ep02.mkv']);
  });

  it('throws on non-downloadable or 404 responses', async () => {
    const notDownloadable: typeof fetch = async () =>
      new Response(
        JSON.stringify({
          id: 'dead',
          can_download: false,
          availability: 'file_rate_limited_captcha_required',
        }),
        { status: 200 },
      );

    await expect(
      pixeldrainResolver.resolve(new URL('https://pixeldrain.com/u/dead'), {
        headers: [],
        signal: new AbortController().signal,
        fetchFn: notDownloadable,
        lookupFn: PUBLIC_LOOKUP,
      }),
    ).rejects.toThrow(/not downloadable/);

    const notFound: typeof fetch = async () =>
      new Response(JSON.stringify({ success: false, message: 'File not found' }), { status: 404 });

    await expect(
      pixeldrainResolver.resolve(new URL('https://pixeldrain.com/u/missing'), {
        headers: [],
        signal: new AbortController().signal,
        fetchFn: notFound,
        lookupFn: PUBLIC_LOOKUP,
      }),
    ).rejects.toThrow(/File not found/);
  });
});
