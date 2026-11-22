import { describe, expect, it } from 'vitest';
import type { AppConfig } from '../config';
import { hasAnyMediaRefreshTarget, refreshMediaTargets } from './media-refresh';

const PUBLIC_LOOKUP = async () => [{ address: '93.184.216.34' }];

function baseConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    port: 3000,
    host: '127.0.0.1',
    rcloneRoot: 'gdrive:Media',
    rcloneConfig: '/tmp/rclone.conf',
    stagingDir: '/tmp/staging',
    dataDir: '/tmp/data',
    maxConcurrentJobs: 2,
    minFreeDiskBytes: 1024,
    maxExtractBytes: 1024 ** 3,
    downloadProxy: '',
    jellyfinUrl: '',
    jellyfinApiKey: '',
    rcloneRcUrl: '',
    ...overrides,
  };
}

describe('media-refresh service', () => {
  it('triggers rclone RC, Jellyfin, Audiobookshelf auto-discovery, and SSRF-validated webhook', async () => {
    const calls: Array<{ url: string; method?: string; headers: Record<string, string>; body?: string }> = [];

    const mockFetch: typeof fetch = async (input, init) => {
      const url = String(input);
      calls.push({
        url,
        method: init?.method,
        headers: (init?.headers as Record<string, string>) ?? {},
        body: typeof init?.body === 'string' ? init.body : undefined,
      });

      if (url === 'http://abs:13378/api/libraries') {
        return new Response(
          JSON.stringify({ libraries: [{ id: 'lib-1' }, { id: 'lib-2' }] }),
          { status: 200 },
        );
      }
      return new Response(null, { status: 204 });
    };

    const config = baseConfig({
      rcloneRcUrl: 'http://rclone-rc:5572',
      jellyfinUrl: 'http://jellyfin:8096',
      jellyfinApiKey: 'jf-key',
      audiobookshelfUrl: 'http://abs:13378',
      audiobookshelfApiKey: 'abs-key',
      postUploadWebhookUrl: 'https://hooks.example.com/upload/secret-path',
    });

    expect(hasAnyMediaRefreshTarget(config)).toBe(true);

    const res = await refreshMediaTargets(
      config,
      {
        remoteRelativeDir: 'Books/Author',
        filename: 'Novel.m4b',
        destinationRemote: 'gdrive:Media/Books/Author',
      },
      { fetchFn: mockFetch, lookupFn: PUBLIC_LOOKUP },
    );

    expect(res.rcloneRefreshed).toBe(true);
    expect(res.jellyfinRefreshed).toBe(true);
    expect(res.audiobookshelfRefreshed).toBe(true);
    expect(res.webhookTriggered).toBe(true);
    expect(res.messages).not.toContain('secret-path');
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      'POST http://rclone-rc:5572/vfs/refresh',
      'POST http://jellyfin:8096/Library/Refresh',
      'GET http://abs:13378/api/libraries',
      'POST http://abs:13378/api/libraries/lib-1/scan',
      'POST http://abs:13378/api/libraries/lib-2/scan',
      'POST https://hooks.example.com/upload/secret-path',
    ]);

    const jellyfinCall = calls[1];
    expect(jellyfinCall.headers.Authorization).toBe('MediaBrowser Token="jf-key"');

    const webhookCall = calls[5];
    expect(JSON.parse(webhookCall.body!)).toMatchObject({
      event: 'upload.completed',
      remoteRelativeDir: 'Books/Author',
      destinationRemote: 'gdrive:Media/Books/Author',
      filename: 'Novel.m4b',
    });
  });

  it('supports explicit Audiobookshelf library ID and blocks SSRF on private post-upload webhook URLs', async () => {
    const calls: string[] = [];
    const mockFetch: typeof fetch = async (input) => {
      calls.push(String(input));
      return new Response(null, { status: 200 });
    };

    const config = baseConfig({
      audiobookshelfUrl: 'http://abs:13378',
      audiobookshelfApiKey: 'abs-key',
      audiobookshelfLibraryId: 'lib-only',
      postUploadWebhookUrl: 'http://127.0.0.1:9000/internal',
    });

    const res = await refreshMediaTargets(config, 'Books', {
      fetchFn: mockFetch,
      lookupFn: PUBLIC_LOOKUP,
    });

    expect(res.audiobookshelfRefreshed).toBe(true);
    expect(res.webhookTriggered).toBe(false);
    expect(calls).toEqual(['http://abs:13378/api/libraries/lib-only/scan']);
    expect(res.messages.join(' ')).toMatch(/Blocked private or reserved IP/);
  });
});
