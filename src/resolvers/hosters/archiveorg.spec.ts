import { describe, expect, it } from 'vitest';
import { archiveOrgResolver } from './archiveorg';

const PUBLIC_LOOKUP = async () => [{ address: '93.184.216.34' }];

describe('archiveOrgResolver', () => {
  it('matches archive.org/details/{id} URLs only', () => {
    expect(archiveOrgResolver.canHandle(new URL('https://archive.org/details/my-collection'))).toBe(
      true,
    );
    expect(
      archiveOrgResolver.canHandle(new URL('https://www.archive.org/details/my-collection/sub')),
    ).toBe(true);
    expect(
      archiveOrgResolver.canHandle(new URL('https://archive.org/download/my-collection/file.zip')),
    ).toBe(false);
  });

  it('filters internal metadata/thumb/private files and encodes downloadable paths', async () => {
    const mockFetch: typeof fetch = async (input) => {
      expect(String(input)).toBe('https://archive.org/metadata/classic-films');
      return new Response(
        JSON.stringify({
          is_dark: false,
          files: [
            { name: 'classic-films_meta.xml', size: '1234', format: 'Metadata' },
            { name: 'classic-films_files.xml', size: '2345', format: 'Metadata' },
            { name: 'classic-films_archive.torrent', size: '9000', format: 'Archive BitTorrent' },
            { name: '.thumbs/frame_001.jpg', size: '500', format: 'Thumbnail' },
            { name: 'secret.mkv', size: '9999', private: true },
            { name: 'Bonus/Film One (1950).mp4', size: '734003200', format: 'MPEG4' },
            { name: 'Subtitles.srt', size: 12000, format: 'SubRip' },
          ],
        }),
        { status: 200 },
      );
    };

    const res = await archiveOrgResolver.resolve(
      new URL('https://archive.org/details/classic-films'),
      {
        headers: [],
        signal: new AbortController().signal,
        fetchFn: mockFetch,
        lookupFn: PUBLIC_LOOKUP,
      },
    );

    expect(res.items).toEqual([
      {
        downloadUrl: 'https://archive.org/download/classic-films/Bonus/Film%20One%20(1950).mp4',
        filename: 'Film One (1950).mp4',
        sizeBytes: 734003200,
        sourceUrl: 'https://archive.org/details/classic-films',
        hoster: 'Archive.org',
      },
      {
        downloadUrl: 'https://archive.org/download/classic-films/Subtitles.srt',
        filename: 'Subtitles.srt',
        sizeBytes: 12000,
        sourceUrl: 'https://archive.org/details/classic-films',
        hoster: 'Archive.org',
      },
    ]);
  });

  it('rejects dark items clearly', async () => {
    const mockFetch: typeof fetch = async () =>
      new Response(JSON.stringify({ is_dark: true, files: [] }), { status: 200 });

    await expect(
      archiveOrgResolver.resolve(new URL('https://archive.org/details/removed-item'), {
        headers: [],
        signal: new AbortController().signal,
        fetchFn: mockFetch,
        lookupFn: PUBLIC_LOOKUP,
      }),
    ).rejects.toThrow(/unavailable/);
  });
});
