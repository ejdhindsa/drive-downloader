import { describe, expect, it } from 'vitest';
import { extractGdriveFileId, gdriveResolver } from './gdrive';

const PUBLIC_LOOKUP = async () => [{ address: '93.184.216.34' }];

describe('gdriveResolver', () => {
  it('extracts file IDs from all supported Google Drive URL formats', () => {
    const id = '1AbCdEfGhIjKlMnOpQrStUvWxYz';
    expect(extractGdriveFileId(new URL(`https://drive.google.com/file/d/${id}/view?usp=sharing`))).toBe(id);
    expect(extractGdriveFileId(new URL(`https://drive.google.com/open?id=${id}`))).toBe(id);
    expect(extractGdriveFileId(new URL(`https://drive.google.com/uc?id=${id}&export=download`))).toBe(id);
    expect(extractGdriveFileId(new URL(`https://docs.google.com/uc?id=${id}`))).toBe(id);
    expect(
      extractGdriveFileId(new URL(`https://drive.usercontent.google.com/download?id=${id}&confirm=t`)),
    ).toBe(id);
    expect(extractGdriveFileId(new URL('https://drive.google.com/drive/folders/1AbCdEfGhIjKlMnOp'))).toBeNull();
  });

  it('resolves direct binary HEAD response cleanly', async () => {
    const mockFetch: typeof fetch = async (_input, init) => {
      expect(init?.method).toBe('HEAD');
      return new Response(null, {
        status: 200,
        headers: {
          'content-type': 'application/octet-stream',
          'content-disposition': 'attachment; filename="Ubuntu.iso"',
          'content-length': '104857600',
        },
      });
    };

    const res = await gdriveResolver.resolve(
      new URL('https://drive.google.com/file/d/1AbCdEfGhIjKlMnOpQrStUvWxYz/view'),
      {
        headers: [],
        signal: new AbortController().signal,
        fetchFn: mockFetch,
        lookupFn: PUBLIC_LOOKUP,
      },
    );

    expect(res.items[0]).toEqual({
      downloadUrl:
        'https://drive.usercontent.google.com/download?id=1AbCdEfGhIjKlMnOpQrStUvWxYz&export=download&confirm=t',
      filename: 'Ubuntu.iso',
      sizeBytes: 104857600,
      mimeType: 'application/octet-stream',
      sourceUrl: 'https://drive.google.com/file/d/1AbCdEfGhIjKlMnOpQrStUvWxYz/view',
      hoster: 'Google Drive',
    });
  });

  it('falls back to GET binary response when HEAD returns text/html', async () => {
    const mockFetch: typeof fetch = async (_input, init) => {
      if (init?.method === 'HEAD') {
        return new Response(null, {
          status: 200,
          headers: { 'content-type': 'text/html; charset=utf-8' },
        });
      }
      return new Response('binary', {
        status: 200,
        headers: {
          'content-type': 'video/mp4',
          'content-disposition': 'attachment; filename="Clip.mp4"',
          'content-length': '4096',
        },
      });
    };

    const res = await gdriveResolver.resolve(
      new URL('https://drive.google.com/open?id=1AbCdEfGhIjKlMnOpQrStUvWxYz'),
      {
        headers: [],
        signal: new AbortController().signal,
        fetchFn: mockFetch,
        lookupFn: PUBLIC_LOOKUP,
      },
    );

    expect(res.items[0].filename).toBe('Clip.mp4');
    expect(res.items[0].sizeBytes).toBe(4096);
    expect(res.items[0].mimeType).toBe('video/mp4');
  });

  it('parses virus-scan HTML confirmation form with hidden confirm & uuid inputs', async () => {
    const seenUrls: string[] = [];
    const mockFetch: typeof fetch = async (input, init) => {
      const url = String(input);
      seenUrls.push(`${init?.method ?? 'GET'} ${url}`);

      if (init?.method === 'HEAD' && url.includes('confirm=t') && !url.includes('uuid=')) {
        return new Response(null, { status: 405 });
      }
      if (init?.method === 'GET') {
        return new Response(
          `<html><body>
            <span class="uc-name-size"><a href="/open?id=1AbCdEfGhIjKlMnOpQrStUvWxYz">BigArchive.7z</a> (2.5G)</span>
            <form id="download-form" action="https://drive.usercontent.google.com/download" method="get">
              <input value="1AbCdEfGhIjKlMnOpQrStUvWxYz" type="hidden" name="id">
              <input type="hidden" name="export" value="download">
              <input type="hidden" name="confirm" value="t">
              <input type="hidden" name="uuid" value="u-998877">
            </form>
          </body></html>`,
          { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } },
        );
      }
      return new Response(null, {
        status: 200,
        headers: {
          'content-type': 'application/x-7z-compressed',
          'content-disposition': 'attachment; filename="BigArchive.7z"',
          'content-length': '2684354560',
        },
      });
    };

    const res = await gdriveResolver.resolve(
      new URL('https://drive.google.com/uc?id=1AbCdEfGhIjKlMnOpQrStUvWxYz'),
      {
        headers: [],
        signal: new AbortController().signal,
        fetchFn: mockFetch,
        lookupFn: PUBLIC_LOOKUP,
      },
    );

    expect(res.items[0].downloadUrl).toContain('uuid=u-998877');
    expect(res.items[0].filename).toBe('BigArchive.7z');
    expect(res.items[0].sizeBytes).toBe(2684354560);
    expect(seenUrls).toHaveLength(3);
  });

  it('rejects private/login pages and quota-exceeded pages clearly', async () => {
    const loginFetch: typeof fetch = async (_input, init) => {
      if (init?.method === 'HEAD') {
        return new Response(null, { status: 403 });
      }
      return new Response('<html><title>Google Drive - Request access</title></html>', {
        status: 200,
        headers: { 'content-type': 'text/html' },
      });
    };

    await expect(
      gdriveResolver.resolve(
        new URL('https://drive.google.com/file/d/1AbCdEfGhIjKlMnOpQrStUvWxYz/view'),
        {
          headers: [],
          signal: new AbortController().signal,
          fetchFn: loginFetch,
          lookupFn: PUBLIC_LOOKUP,
        },
      ),
    ).rejects.toThrow(/private or requires sign-in/);

    const quotaFetch: typeof fetch = async (_input, init) => {
      if (init?.method === 'HEAD') {
        return new Response(null, { status: 403 });
      }
      return new Response(
        '<html><body>Too many users have viewed or downloaded this file recently.</body></html>',
        {
          status: 200,
          headers: { 'content-type': 'text/html' },
        },
      );
    };

    await expect(
      gdriveResolver.resolve(
        new URL('https://drive.google.com/file/d/1AbCdEfGhIjKlMnOpQrStUvWxYz/view'),
        {
          headers: [],
          signal: new AbortController().signal,
          fetchFn: quotaFetch,
          lookupFn: PUBLIC_LOOKUP,
        },
      ),
    ).rejects.toThrow(/quota exceeded/);
  });
});
