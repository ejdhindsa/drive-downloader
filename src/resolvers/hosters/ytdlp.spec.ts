import { describe, expect, it } from 'vitest';
import { createYtDlpResolver } from './ytdlp';

describe('ytDlpResolver', () => {
  it('throws a clear error when yt-dlp binary is missing', async () => {
    const resolver = createYtDlpResolver({
      detectBinaryFn: async () => null,
    });

    await expect(
      resolver.resolve(new URL('https://www.youtube.com/watch?v=dQw4w9WgXcQ'), {
        headers: [],
        signal: new AbortController().signal,
        inspectOnly: true,
      }),
    ).rejects.toThrow(/yt-dlp is not installed/);
  });

  it('delegates inspectOnly calls to inspectWithYtDlp and returns playlist/video items', async () => {
    let inspectCalled = false;
    const resolver = createYtDlpResolver({
      detectBinaryFn: async () => '/usr/bin/yt-dlp',
      inspectFn: async (url) => {
        inspectCalled = true;
        return {
          items: [
            {
              downloadUrl: url.toString(),
              filename: 'Demo Video.mp4',
              hoster: 'YouTube',
              category: 'video',
              engine: 'yt-dlp',
            },
          ],
          warnings: [],
        };
      },
    });

    const out = await resolver.resolve(new URL('https://www.youtube.com/watch?v=dQw4w9WgXcQ'), {
      headers: [],
      signal: new AbortController().signal,
      inspectOnly: true,
    });

    expect(inspectCalled).toBe(true);
    expect(out.items[0].engine).toBe('yt-dlp');
    expect(out.items[0].filename).toBe('Demo Video.mp4');
  });

  it('skips inspect subprocess during job execution and returns yt-dlp engine target', async () => {
    let inspectCalled = false;
    const resolver = createYtDlpResolver({
      detectBinaryFn: async () => '/usr/bin/yt-dlp',
      inspectFn: async () => {
        inspectCalled = true;
        return { items: [], warnings: [] };
      },
    });

    const out = await resolver.resolve(new URL('https://soundcloud.com/artist/track-name'), {
      headers: [],
      signal: new AbortController().signal,
      inspectOnly: false,
    });

    expect(inspectCalled).toBe(false);
    expect(out.items).toEqual([
      {
        downloadUrl: 'https://soundcloud.com/artist/track-name',
        sourceUrl: 'https://soundcloud.com/artist/track-name',
        hoster: 'SoundCloud',
        category: 'audio',
        engine: 'yt-dlp',
      },
    ]);
  });
});
