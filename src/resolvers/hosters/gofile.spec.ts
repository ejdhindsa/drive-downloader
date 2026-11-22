import { describe, expect, it } from 'vitest';
import { gofileResolver } from './gofile';

const PUBLIC_LOOKUP = async () => [{ address: '93.184.216.34' }];

describe('gofileResolver', () => {
  it('matches gofile.io/d/{id} URLs only', () => {
    expect(gofileResolver.canHandle(new URL('https://gofile.io/d/XyZ123'))).toBe(true);
    expect(gofileResolver.canHandle(new URL('https://www.gofile.io/d/XyZ123/'))).toBe(true);
    expect(gofileResolver.canHandle(new URL('https://gofile.io/upload'))).toBe(false);
  });

  it('creates guest token, fetches object children, attaches Cookie header, and warns on subfolders', async () => {
    const calls: Array<{ url: string; method?: string; headers: Record<string, string> }> = [];
    const mockFetch: typeof fetch = async (input, init) => {
      const url = String(input);
      calls.push({
        url,
        method: init?.method,
        headers: (init?.headers as Record<string, string>) ?? {},
      });

      if (url === 'https://api.gofile.io/accounts') {
        return new Response(
          JSON.stringify({ status: 'ok', data: { token: 'guest-tok-123' } }),
          { status: 200 },
        );
      }

      return new Response(
        JSON.stringify({
          status: 'ok',
          data: {
            children: {
              c1: {
                id: 'c1',
                type: 'file',
                name: 'Release.zip',
                size: 512_000_000,
                mimetype: 'application/zip',
                link: 'https://store1.gofile.io/download/web/c1/Release.zip',
              },
              c2: {
                id: 'c2',
                type: 'folder',
                name: 'Extras',
              },
            },
          },
        }),
        { status: 200 },
      );
    };

    const res = await gofileResolver.resolve(new URL('https://gofile.io/d/Folder99'), {
      headers: [],
      signal: new AbortController().signal,
      fetchFn: mockFetch,
      lookupFn: PUBLIC_LOOKUP,
    });

    expect(calls[0].method).toBe('POST');
    expect(calls[1].headers.Authorization).toBe('Bearer guest-tok-123');
    expect(calls[1].headers['X-Website-Token']).toBe('4fd6sg89d7s6');
    expect(res.items).toEqual([
      {
        downloadUrl: 'https://store1.gofile.io/download/web/c1/Release.zip',
        filename: 'Release.zip',
        sizeBytes: 512_000_000,
        mimeType: 'application/zip',
        headers: [{ name: 'Cookie', value: 'accountToken=guest-tok-123' }],
        note: 'Requires Staged mode (uses session cookie)',
        sourceUrl: 'https://gofile.io/d/Folder99',
        hoster: 'Gofile',
      },
    ]);
    expect(res.warnings).toEqual(['Skipped nested Gofile subfolder "Extras"']);
  });

  it('supports array children and rejects password-protected or not-found folders', async () => {
    const arrayChildrenFetch: typeof fetch = async (input) => {
      if (String(input).endsWith('/accounts')) {
        return new Response(JSON.stringify({ status: 'ok', data: { token: 't2' } }), { status: 200 });
      }
      return new Response(
        JSON.stringify({
          status: 'ok',
          data: {
            children: [
              {
                id: 'f1',
                type: 'file',
                name: 'Track.flac',
                size: 35_000_000,
                link: 'https://store2.gofile.io/download/f1/Track.flac',
              },
            ],
          },
        }),
        { status: 200 },
      );
    };

    const arrayRes = await gofileResolver.resolve(new URL('https://gofile.io/d/Arr1'), {
      headers: [],
      signal: new AbortController().signal,
      fetchFn: arrayChildrenFetch,
      lookupFn: PUBLIC_LOOKUP,
    });
    expect(arrayRes.items[0].filename).toBe('Track.flac');

    const pwFetch: typeof fetch = async (input) => {
      if (String(input).endsWith('/accounts')) {
        return new Response(JSON.stringify({ status: 'ok', data: { token: 't3' } }), { status: 200 });
      }
      return new Response(
        JSON.stringify({
          status: 'ok',
          data: { password: true, passwordStatus: 'passwordRequired', children: {} },
        }),
        { status: 200 },
      );
    };

    await expect(
      gofileResolver.resolve(new URL('https://gofile.io/d/Locked1'), {
        headers: [],
        signal: new AbortController().signal,
        fetchFn: pwFetch,
        lookupFn: PUBLIC_LOOKUP,
      }),
    ).rejects.toThrow(/password-protected/);

    const missingFetch: typeof fetch = async (input) => {
      if (String(input).endsWith('/accounts')) {
        return new Response(JSON.stringify({ status: 'ok', data: { token: 't4' } }), { status: 200 });
      }
      return new Response(JSON.stringify({ status: 'error-notFound' }), { status: 404 });
    };

    await expect(
      gofileResolver.resolve(new URL('https://gofile.io/d/Missing1'), {
        headers: [],
        signal: new AbortController().signal,
        fetchFn: missingFetch,
        lookupFn: PUBLIC_LOOKUP,
      }),
    ).rejects.toThrow(/not found/);
  });
});
