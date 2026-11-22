import { describe, expect, it } from 'vitest';
import { mediafireResolver } from './mediafire';

const PUBLIC_LOOKUP = async () => [{ address: '93.184.216.34' }];

describe('mediafireResolver', () => {
  it('matches mediafire file pages and excludes direct download CDN URLs', () => {
    expect(
      mediafireResolver.canHandle(new URL('https://www.mediafire.com/file/abc123def/Archive.zip/file')),
    ).toBe(true);
    expect(
      mediafireResolver.canHandle(new URL('https://mediafire.com/download/abc123def/Archive.zip')),
    ).toBe(true);
    expect(
      mediafireResolver.canHandle(new URL('https://download1234.mediafire.com/xyz/Archive.zip')),
    ).toBe(false);
  });

  it('extracts direct href, filename, and human size from downloadButton', async () => {
    const mockFetch: typeof fetch = async () =>
      new Response(
        `<html><body>
          <div class="dl-btn-label" title="Linux_Distro.iso">Linux_Distro.iso</div>
          <a class="input popsok" aria-label="Download file" href="https://download1500.mediafire.com/tok/abc123/Linux_Distro.iso" id="downloadButton">
            Download (1.25 GB)
          </a>
        </body></html>`,
        { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } },
      );

    const res = await mediafireResolver.resolve(
      new URL('https://www.mediafire.com/file/abc123/Linux_Distro.iso/file'),
      {
        headers: [],
        signal: new AbortController().signal,
        fetchFn: mockFetch,
        lookupFn: PUBLIC_LOOKUP,
      },
    );

    expect(res.items[0]).toEqual({
      downloadUrl: 'https://download1500.mediafire.com/tok/abc123/Linux_Distro.iso',
      filename: 'Linux_Distro.iso',
      sizeBytes: 1_250_000_000,
      sourceUrl: 'https://www.mediafire.com/file/abc123/Linux_Distro.iso/file',
      hoster: 'MediaFire',
    });
  });

  it('decodes base64 data-scrambled-url fallback when href is obfuscated', async () => {
    const scrambled = Buffer.from(
      'https://download2222.mediafire.com/secret/Pack.7z',
      'utf8',
    ).toString('base64');

    const mockFetch: typeof fetch = async () =>
      new Response(
        `<html><body>
          <div class="filename">Pack.7z</div>
          <a id="downloadButton" href="#" data-scrambled-url="${scrambled}">Download (450 MB)</a>
        </body></html>`,
        { status: 200, headers: { 'content-type': 'text/html' } },
      );

    const res = await mediafireResolver.resolve(
      new URL('https://www.mediafire.com/file/xyz999/Pack.7z/file'),
      {
        headers: [],
        signal: new AbortController().signal,
        fetchFn: mockFetch,
        lookupFn: PUBLIC_LOOKUP,
      },
    );

    expect(res.items[0].downloadUrl).toBe('https://download2222.mediafire.com/secret/Pack.7z');
    expect(res.items[0].filename).toBe('Pack.7z');
    expect(res.items[0].sizeBytes).toBe(450_000_000);
  });

  it('rejects deleted files and CAPTCHA gates cleanly', async () => {
    const deletedFetch: typeof fetch = async () =>
      new Response('<html><body>Invalid or Deleted File.</body></html>', {
        status: 200,
        headers: { 'content-type': 'text/html' },
      });

    await expect(
      mediafireResolver.resolve(new URL('https://www.mediafire.com/file/dead1/a.zip/file'), {
        headers: [],
        signal: new AbortController().signal,
        fetchFn: deletedFetch,
        lookupFn: PUBLIC_LOOKUP,
      }),
    ).rejects.toThrow(/removed or blocked/);

    const captchaFetch: typeof fetch = async () =>
      new Response('<html><div class="cf-turnstile"></div></html>', {
        status: 200,
        headers: { 'content-type': 'text/html' },
      });

    await expect(
      mediafireResolver.resolve(new URL('https://www.mediafire.com/file/cap1/a.zip/file'), {
        headers: [],
        signal: new AbortController().signal,
        fetchFn: captchaFetch,
        lookupFn: PUBLIC_LOOKUP,
      }),
    ).rejects.toThrow(/Turnstile/);
  });
});
