import { describe, expect, it } from 'vitest';
import type { AppConfig } from '../config';
import {
  ClientPresenceTracker,
  dispatchJobNotification,
  hasConfiguredNotificationChannel,
} from './notifications';

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
    notifyInactiveSeconds: 300,
    ...overrides,
  };
}

describe('ClientPresenceTracker', () => {
  it('gates activity strictly inside the configured inactivity window', () => {
    const tracker = new ClientPresenceTracker();
    expect(tracker.isClientRecentlyActive(300, 1_000_000)).toBe(false);

    tracker.markActive(1_000_000);
    expect(tracker.isClientRecentlyActive(300, 1_000_000 + 299_999)).toBe(true);
    expect(tracker.isClientRecentlyActive(300, 1_000_000 + 300_000)).toBe(false);
    expect(tracker.isClientRecentlyActive(0, 1_000_000 + 1_000)).toBe(false);
  });
});

describe('dispatchJobNotification', () => {
  it('suppresses notifications while the user is recently active in the tab', async () => {
    let fetchCalls = 0;
    const mockFetch: typeof fetch = async () => {
      fetchCalls += 1;
      return new Response(null, { status: 204 });
    };

    const presence = new ClientPresenceTracker();
    presence.markActive(1_000_000);

    const res = await dispatchJobNotification(
      baseConfig({ discordWebhookUrl: 'https://discord.com/api/webhooks/123/secret' }),
      {
        kind: 'completed',
        job: {
          id: 'j1',
          resolvedFilename: 'Movie.mkv',
          destinationRemote: 'gdrive:Media/Movies',
        },
      },
      { presence, now: 1_060_000, fetchFn: mockFetch, lookupFn: PUBLIC_LOOKUP },
    );

    expect(res).toEqual({ skippedReason: 'client_active', sent: [], errors: [] });
    expect(fetchCalls).toBe(0);
  });

  it('dispatches Discord embed, ntfy, and Telegram messages once inactive', async () => {
    const seen: Array<{ url: string; headers: Record<string, string>; body?: string }> = [];
    const mockFetch: typeof fetch = async (input, init) => {
      seen.push({
        url: String(input),
        headers: (init?.headers as Record<string, string>) ?? {},
        body: typeof init?.body === 'string' ? init.body : undefined,
      });
      return new Response(null, { status: 200 });
    };

    const presence = new ClientPresenceTracker();
    presence.markActive(1_000_000);

    const config = baseConfig({
      discordWebhookUrl: 'https://discord.com/api/webhooks/123/secret-hook',
      ntfyUrl: 'https://ntfy.sh/my-private-topic',
      telegramBotToken: '12345:bot-secret',
      telegramChatId: '99999',
    });
    expect(hasConfiguredNotificationChannel(config)).toBe(true);

    const res = await dispatchJobNotification(
      config,
      {
        kind: 'failed',
        job: {
          id: 'j2',
          resolvedFilename: 'Episode.mkv',
          destinationRemote: 'gdrive:Media/TVShows',
          error: 'Remote returned HTTP 503',
          resolverName: 'Pixeldrain',
        },
      },
      { presence, now: 1_305_000, fetchFn: mockFetch, lookupFn: PUBLIC_LOOKUP },
    );

    expect(res.skippedReason).toBeUndefined();
    expect(res.sent).toEqual(['discord', 'ntfy', 'telegram']);
    expect(res.errors).toEqual([]);

    const discordBody = JSON.parse(seen[0].body!);
    expect(discordBody.embeds[0].title).toBe('Transfer Failed');
    expect(discordBody.embeds[0].color).toBe(0xef4444);
    expect(discordBody.embeds[0].description).toContain('Remote returned HTTP 503');

    expect(seen[1].headers.Title).toBe('Transfer Failed');
    expect(seen[1].headers.Priority).toBe('high');

    expect(JSON.parse(seen[2].body!)).toEqual({
      chat_id: '99999',
      text: 'Transfer Failed\nEpisode.mkv failed: Remote returned HTTP 503',
    });
  });

  it('blocks private webhook URLs via SSRF validation without crashing', async () => {
    const res = await dispatchJobNotification(
      baseConfig({ discordWebhookUrl: 'http://127.0.0.1:8080/hook' }),
      {
        kind: 'completed',
        job: {
          id: 'j3',
          resolvedFilename: 'Show.mkv',
          destinationRemote: 'gdrive:Media/TVShows',
        },
      },
      { lookupFn: PUBLIC_LOOKUP },
    );

    expect(res.sent).toEqual([]);
    expect(res.errors[0]).toMatch(/Blocked private or reserved IP/);
  });
});
