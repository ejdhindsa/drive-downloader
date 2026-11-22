import { describe, expect, it } from 'vitest';
import { buzzheavierResolver } from './buzzheavier';

const PUBLIC_LOOKUP = async () => [{ address: '93.184.216.34' }];

describe('buzzheavierResolver', () => {
  it('matches buzzheavier file IDs and excludes reserved paths and CDN subdomains', () => {
    expect(buzzheavierResolver.canHandle(new URL('https://buzzheavier.com/abc12345'))).toBe(true);
    expect(buzzheavierResolver.canHandle(new URL('https://www.buzzheavier.com/xyz_9876/'))).toBe(
      true,
    );
    expect(buzzheavierResolver.canHandle(new URL('https://buzzheavier.com/login'))).toBe(false);
    expect(buzzheavierResolver.canHandle(new URL('https://dl.buzzheavier.com/abc12345'))).toBe(
      false,
    );
  });

  it('resolves HX-Redirect header (including relative paths) and enriches via HEAD', async () => {
    const mockFetch: typeof fetch = async (input, init) => {
      const url = String(input);
      if (url === 'https://buzzheavier.com/abc12345') {
        return new Response('<html><title>Buzzheavier</title></html>', { status: 200 });
      }
      if (url === 'https://buzzheavier.com/abc12345/download') {
        const hdrs = (init?.headers as Record<string, string>) ?? {};
        expect(hdrs['HX-Request']).toBe('true');
        expect(init?.redirect).toBe('manual');
        return new Response(null, {
          status: 200,
          headers: { 'hx-redirect': '/dl/signed-token/Pack.7z' },
        });
      }
      if (url === 'https://buzzheavier.com/dl/signed-token/Pack.7z' && init?.method === 'HEAD') {
        return new Response(null, {
          status: 200,
          headers: {
            'content-disposition': 'attachment; filename="Pack.7z"',
            'content-length': '83886080',
            'content-type': 'application/x-7z-compressed',
          },
        });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    };

    const res = await buzzheavierResolver.resolve(new URL('https://buzzheavier.com/abc12345'), {
      headers: [],
      signal: new AbortController().signal,
      fetchFn: mockFetch,
      lookupFn: PUBLIC_LOOKUP,
    });

    expect(res.items[0]).toEqual({
      downloadUrl: 'https://buzzheavier.com/dl/signed-token/Pack.7z',
      filename: 'Pack.7z',
      sizeBytes: 83886080,
      mimeType: 'application/x-7z-compressed',
      sourceUrl: 'https://buzzheavier.com/abc12345',
      hoster: 'Buzzheavier',
    });
  });

  it('supports 302 Location fallback and rejects 404 or CAPTCHA pages', async () => {
    const locationFetch: typeof fetch = async (input) => {
      const url = String(input);
      if (url === 'https://buzzheavier.com/file9999') {
        return new Response('<html><title>Movie.mkv - Buzzheavier</title><p>1.2 GiB</p></html>', {
          status: 200,
        });
      }
      return new Response(null, {
        status: 302,
        headers: { location: 'https://cdn.buzzheavier.com/raw/Movie.mkv' },
      });
    };

    const ok = await buzzheavierResolver.resolve(new URL('https://buzzheavier.com/file9999'), {
      headers: [],
      signal: new AbortController().signal,
      fetchFn: locationFetch,
      lookupFn: PUBLIC_LOOKUP,
    });
    expect(ok.items[0].downloadUrl).toBe('https://cdn.buzzheavier.com/raw/Movie.mkv');
    expect(ok.items[0].filename).toBe('Movie.mkv');
    expect(ok.items[0].sizeBytes).toBe(Math.round(1.2 * 1024 ** 3));

    const notFound: typeof fetch = async () => new Response('Not found', { status: 404 });
    await expect(
      buzzheavierResolver.resolve(new URL('https://buzzheavier.com/missing1'), {
        headers: [],
        signal: new AbortController().signal,
        fetchFn: notFound,
        lookupFn: PUBLIC_LOOKUP,
      }),
    ).rejects.toThrow(/404/);

    const captcha: typeof fetch = async () =>
      new Response('<html><div class="cf-turnstile"></div></html>', { status: 200 });
    await expect(
      buzzheavierResolver.resolve(new URL('https://buzzheavier.com/blocked1'), {
        headers: [],
        signal: new AbortController().signal,
        fetchFn: captcha,
        lookupFn: PUBLIC_LOOKUP,
      }),
    ).rejects.toThrow(/Turnstile/);
  });
});
