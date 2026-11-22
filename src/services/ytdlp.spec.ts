import { describe, expect, it } from 'vitest';
import {
  buildYtDlpDownloadArgs,
  buildYtDlpInspectArgs,
  detectPlatformLabel,
  isYtDlpPlatformUrl,
  parseYtDlpInspectJson,
  parseYtDlpProgressLine,
  sanitizeYtDlpFormat,
} from './ytdlp';

describe('yt-dlp platform detection & format validation', () => {
  it('matches major video and audio platform URLs and ignores file hosters or direct links', () => {
    expect(isYtDlpPlatformUrl(new URL('https://www.youtube.com/watch?v=dQw4w9WgXcQ'))).toBe(true);
    expect(isYtDlpPlatformUrl(new URL('https://youtu.be/dQw4w9WgXcQ'))).toBe(true);
    expect(isYtDlpPlatformUrl(new URL('https://music.youtube.com/watch?v=abc123'))).toBe(true);
    expect(isYtDlpPlatformUrl(new URL('https://vimeo.com/12345678'))).toBe(true);
    expect(isYtDlpPlatformUrl(new URL('https://www.twitch.tv/videos/987654321'))).toBe(true);
    expect(isYtDlpPlatformUrl(new URL('https://clips.twitch.tv/FunClipSlug'))).toBe(true);
    expect(isYtDlpPlatformUrl(new URL('https://soundcloud.com/artist/track-name'))).toBe(true);
    expect(isYtDlpPlatformUrl(new URL('https://artist.bandcamp.com/album/demo'))).toBe(true);
    expect(isYtDlpPlatformUrl(new URL('https://www.dailymotion.com/video/x8abcde'))).toBe(true);

    expect(isYtDlpPlatformUrl(new URL('https://soundcloud.com/discover'))).toBe(false);
    expect(isYtDlpPlatformUrl(new URL('https://pixeldrain.com/u/abc123'))).toBe(false);
    expect(isYtDlpPlatformUrl(new URL('https://cdn.example.com/movie.mkv'))).toBe(false);

    expect(detectPlatformLabel(new URL('https://music.youtube.com/watch?v=1'))).toBe(
      'YouTube Music',
    );
    expect(detectPlatformLabel(new URL('https://youtu.be/1'))).toBe('YouTube');
    expect(detectPlatformLabel(new URL('https://soundcloud.com/a/b'))).toBe('SoundCloud');
  });

  it('validates ytDlpFormat presets cleanly', () => {
    expect(sanitizeYtDlpFormat(undefined)).toBeUndefined();
    expect(sanitizeYtDlpFormat('')).toBeUndefined();
    expect(sanitizeYtDlpFormat('1080p')).toBe('1080p');
    expect(sanitizeYtDlpFormat('audio-mp3')).toBe('audio-mp3');
    expect(() => sanitizeYtDlpFormat('4k-raw')).toThrow(/Invalid yt-dlp format preset/);
  });
});

describe('yt-dlp argument builders', () => {
  it('builds flat-playlist inspect args with optional proxy and headers', () => {
    const args = buildYtDlpInspectArgs('https://www.youtube.com/playlist?list=PL123', {
      proxyUrl: 'http://gluetun:8888',
      headers: [{ name: 'Referer', value: 'https://www.youtube.com/' }],
    });

    expect(args).toContain('--flat-playlist');
    expect(args).toContain('-J');
    expect(args).toContain('--proxy');
    expect(args).toContain('http://gluetun:8888');
    expect(args).toContain('--add-header');
    expect(args).toContain('Referer: https://www.youtube.com/');
    expect(args.slice(-2)).toEqual(['--', 'https://www.youtube.com/playlist?list=PL123']);
  });

  it('builds download args for video and audio presets with safe output template', () => {
    const mp4Args = buildYtDlpDownloadArgs({
      url: 'https://www.youtube.com/watch?v=123',
      outputDir: '/tmp/staging/job-1',
      format: '720p',
      customFilename: 'Talk.mp4',
      proxyUrl: 'http://gluetun:8888',
    });

    expect(mp4Args).toContain('--newline');
    expect(mp4Args).toContain('--no-playlist');
    expect(mp4Args).toContain('-P');
    expect(mp4Args).toContain('/tmp/staging/job-1');
    expect(mp4Args).toContain('Talk.%(ext)s');
    expect(mp4Args).toContain('--merge-output-format');
    expect(mp4Args).toContain('mp4');
    expect(mp4Args.join(' ')).toContain('height<=720');

    const mp3Args = buildYtDlpDownloadArgs({
      url: 'https://soundcloud.com/artist/song',
      outputDir: '/tmp/staging/job-2',
      format: 'audio-mp3',
    });

    expect(mp3Args).toContain('-x');
    expect(mp3Args).toContain('--audio-format');
    expect(mp3Args).toContain('mp3');
    expect(mp3Args).toContain('%(title).180B.%(ext)s');
  });
});

describe('yt-dlp progress & JSON parsers', () => {
  it('parses standard, approximate, HH:MM:SS, Unknown ETA, and completion lines', () => {
    expect(
      parseYtDlpProgressLine('[download]  42.3% of  100.00MiB at   10.00MiB/s ETA 01:05'),
    ).toEqual({
      percent: 42.3,
      bytesDone: Math.round(0.423 * 100 * 1024 ** 2),
      bytesTotal: 100 * 1024 ** 2,
      speedBytesPerSec: 10 * 1024 ** 2,
      etaSeconds: 65,
    });

    expect(
      parseYtDlpProgressLine('[download]  50.0% of ~ 2.00GiB at Unknown B/s ETA Unknown'),
    ).toEqual({
      percent: 50,
      bytesDone: 1024 ** 3,
      bytesTotal: 2 * 1024 ** 3,
      speedBytesPerSec: 0,
      etaSeconds: null,
    });

    expect(
      parseYtDlpProgressLine('[download] 100% of   25.00MiB in 00:00:05 at 5.00MiB/s'),
    ).toEqual({
      percent: 100,
      bytesDone: 25 * 1024 ** 2,
      bytesTotal: 25 * 1024 ** 2,
      speedBytesPerSec: 5 * 1024 ** 2,
      etaSeconds: 0,
    });

    expect(parseYtDlpProgressLine('[Merger] Merging formats into "out.mp4"')).toBeNull();
  });

  it('parses single video and playlist inspect JSON and skips unavailable items', () => {
    const single = parseYtDlpInspectJson(
      JSON.stringify({
        id: 'vid1',
        title: 'Lecture: Part 1',
        webpage_url: 'https://vimeo.com/123456',
        ext: 'mp4',
        filesize_approx: 50_000_000,
        duration: 125,
      }),
      new URL('https://vimeo.com/123456'),
    );

    expect(single.warnings).toEqual([]);
    expect(single.items).toEqual([
      {
        downloadUrl: 'https://vimeo.com/123456',
        filename: 'Lecture- Part 1.mp4',
        sizeBytes: 50_000_000,
        sourceUrl: 'https://vimeo.com/123456',
        hoster: 'Vimeo',
        category: 'video',
        engine: 'yt-dlp',
        note: 'Duration 2:05 · yt-dlp',
      },
    ]);

    const playlist = parseYtDlpInspectJson(
      JSON.stringify({
        _type: 'playlist',
        entries: [
          { id: 'abc111', title: 'Track One', ie_key: 'Youtube', duration: 200 },
          null,
          { id: 'priv222', title: 'Secret', availability: 'private' },
        ],
      }),
      new URL('https://music.youtube.com/playlist?list=PL99'),
    );

    expect(playlist.items).toHaveLength(1);
    expect(playlist.items[0].downloadUrl).toBe('https://www.youtube.com/watch?v=abc111');
    expect(playlist.items[0].hoster).toBe('YouTube');
    expect(playlist.warnings).toEqual([
      'Skipped unavailable playlist item',
      'Skipped restricted item: Secret',
    ]);
  });
});
