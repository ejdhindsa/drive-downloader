import { describe, expect, it } from 'vitest';
import { dropboxResolver } from './dropbox';

const PUBLIC_LOOKUP = async () => [{ address: '93.184.216.34' }];

describe('dropboxResolver', () => {
  it('matches /s/ and /scl/fi/ Dropbox share URLs and ignores non-share paths', () => {
    expect(dropboxResolver.canHandle(new URL('https://www.dropbox.com/s/abc123/file.zip?dl=0'))).toBe(
      true,
    );
    expect(
      dropboxResolver.canHandle(
        new URL('https://www.dropbox.com/scl/fi/id123/show.mkv?rlkey=xyz&dl=0'),
      ),
    ).toBe(true);
    expect(dropboxResolver.canHandle(new URL('https://www.dropbox.com/home/Movies'))).toBe(false);
  });

  it('rewrites dl=0 to dl=1 while preserving rlkey and sets dl=1 when missing', async () => {
    const probedUrls: string[] = [];
    const mockFetch: typeof fetch = async (input) => {
      probedUrls.push(String(input));
      return new Response(null, {
        status: 200,
        headers: {
          'content-disposition': 'attachment; filename="Movie.mkv"',
          'content-length': '9000000',
          'content-type': 'video/x-matroska',
        },
      });
    };

    const res1 = await dropboxResolver.resolve(
      new URL('https://www.dropbox.com/scl/fi/id123/Movie.mkv?rlkey=secret123&st=abc&dl=0'),
      {
        headers: [],
        signal: new AbortController().signal,
        fetchFn: mockFetch,
        lookupFn: PUBLIC_LOOKUP,
      },
    );

    expect(res1.items[0].hoster).toBe('Dropbox');
    expect(res1.items[0].downloadUrl).toBe(
      'https://www.dropbox.com/scl/fi/id123/Movie.mkv?rlkey=secret123&st=abc&dl=1',
    );
    expect(res1.items[0].filename).toBe('Movie.mkv');
    expect(res1.items[0].sizeBytes).toBe(9000000);

    const res2 = await dropboxResolver.resolve(
      new URL('https://dropbox.com/s/old123/Archive.zip?raw=1'),
      {
        headers: [],
        signal: new AbortController().signal,
        fetchFn: mockFetch,
        lookupFn: PUBLIC_LOOKUP,
      },
    );

    expect(res2.items[0].downloadUrl).toBe('https://dropbox.com/s/old123/Archive.zip?dl=1');
    expect(probedUrls).toHaveLength(2);
  });
});
