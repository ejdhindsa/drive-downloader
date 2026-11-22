import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { AppConfig } from './config';
import { JobQueueManager } from './queue';
import { buildApp } from './server';
import { JobStore } from './store';

const tempDirs: string[] = [];

async function createTestServer(overrides?: {
  downloadProxy?: string;
  rateLimitMaxRequests?: number;
}) {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'drive-dl-http-sec-'));
  tempDirs.push(tmpDir);

  const config: AppConfig = {
    port: 3000,
    host: '127.0.0.1',
    rcloneRoot: 'gdrive:Media',
    rcloneConfig: path.join(tmpDir, 'rclone.conf'),
    stagingDir: path.join(tmpDir, 'staging'),
    dataDir: path.join(tmpDir, 'data'),
    maxConcurrentJobs: 1,
    minFreeDiskBytes: 1024,
    maxExtractBytes: 1024 ** 3,
    downloadProxy: overrides?.downloadProxy ?? '',
    jellyfinUrl: '',
    jellyfinApiKey: '',
    rcloneRcUrl: '',
  };

  const store = new JobStore(config.dataDir);
  const queue = new JobQueueManager(config, store);
  await queue.init();

  // Prevent queued test jobs from spawning aria2c during HTTP layer tests.
  (
    queue as unknown as {
      executeStagedTransfer: (_job: unknown, _dir: string, signal: AbortSignal) => Promise<void>;
    }
  ).executeStagedTransfer = async (_job, _dir, signal) => {
    await new Promise<void>((_resolve, reject) => {
      if (signal.aborted) {
        reject(new Error('Cancelled'));
        return;
      }
      signal.addEventListener('abort', () => reject(new Error('Cancelled')), { once: true });
    });
  };

  const { app, closeSseClients } = await buildApp({
    config,
    queue,
    logger: false,
    security: {
      rateLimitWindowMs: 60_000,
      rateLimitMaxRequests: overrides?.rateLimitMaxRequests ?? 60,
    },
  });

  return { app, queue, config, closeSseClients };
}

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    await fs.rm(dir, { recursive: true, force: true });
  }
});

describe('HTTP security headers, CSRF, rate limiting, and API redaction', () => {
  it('attaches security headers and hides proxy credentials from /api/config', async () => {
    const { app, closeSseClients } = await createTestServer({
      downloadProxy: 'http://user:topsecret@gluetun:8888',
    });
    try {
      const res = await app.inject({ method: 'GET', url: '/api/config' });
      expect(res.statusCode).toBe(200);
      expect(res.headers['x-content-type-options']).toBe('nosniff');
      expect(res.headers['x-frame-options']).toBe('DENY');
      expect(res.headers['referrer-policy']).toBe('no-referrer');
      expect(res.headers['content-security-policy']).toContain("frame-ancestors 'none'");

      const body = res.json();
      expect(body.proxyConfigured).toBe(true);
      expect(JSON.stringify(body)).not.toContain('topsecret');
      expect(JSON.stringify(body)).not.toContain('gluetun');
    } finally {
      closeSseClients();
      await app.close();
    }
  });

  it('blocks cross-site CSRF requests on mutating endpoints and allows same-origin', async () => {
    const { app, closeSseClients } = await createTestServer();
    try {
      const payload = {
        urls: ['https://93.184.216.34/movie.mkv'],
        folder: 'Movies',
        mode: 'staged',
        autoExtract: false,
        autoRefreshJellyfin: false,
      };

      const badOrigin = await app.inject({
        method: 'POST',
        url: '/api/jobs',
        headers: { host: 'downloader.example.com', origin: 'https://evil.site' },
        payload,
      });
      expect(badOrigin.statusCode).toBe(403);

      const nullOrigin = await app.inject({
        method: 'POST',
        url: '/api/jobs',
        headers: { host: 'downloader.example.com', origin: 'null' },
        payload,
      });
      expect(nullOrigin.statusCode).toBe(403);

      const crossSiteFetch = await app.inject({
        method: 'DELETE',
        url: '/api/jobs',
        headers: { host: 'downloader.example.com', 'sec-fetch-site': 'cross-site' },
      });
      expect(crossSiteFetch.statusCode).toBe(403);

      const badReferer = await app.inject({
        method: 'DELETE',
        url: '/api/jobs',
        headers: { host: 'downloader.example.com', referer: 'https://evil.site/page' },
      });
      expect(badReferer.statusCode).toBe(403);

      // Same-origin behind a reverse proxy (x-forwarded-host) succeeds.
      const okSameOrigin = await app.inject({
        method: 'DELETE',
        url: '/api/jobs',
        headers: {
          host: 'drive-downloader:3000',
          'x-forwarded-host': 'downloader.example.com',
          origin: 'https://downloader.example.com',
        },
      });
      expect(okSameOrigin.statusCode).toBe(200);
    } finally {
      closeSseClients();
      await app.close();
    }
  });

  it('rate-limits mutating API routes with HTTP 429 and Retry-After', async () => {
    const { app, closeSseClients } = await createTestServer({ rateLimitMaxRequests: 2 });
    try {
      const r1 = await app.inject({ method: 'DELETE', url: '/api/jobs' });
      const r2 = await app.inject({ method: 'DELETE', url: '/api/jobs' });
      const r3 = await app.inject({ method: 'DELETE', url: '/api/jobs' });

      expect(r1.statusCode).toBe(200);
      expect(r2.statusCode).toBe(200);
      expect(r3.statusCode).toBe(429);
      expect(Number(r3.headers['retry-after'])).toBeGreaterThanOrEqual(1);
    } finally {
      closeSseClients();
      await app.close();
    }
  });

  it('never leaks sensitive Cookie or Authorization header values in API responses', async () => {
    const { app, queue, closeSseClients } = await createTestServer();
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/api/jobs',
        headers: { host: 'downloader.example.com', origin: 'https://downloader.example.com' },
        payload: {
          urls: ['https://93.184.216.34/protected.mkv'],
          folder: 'Movies',
          mode: 'staged',
          autoExtract: false,
          autoRefreshJellyfin: false,
          headers: [
            { name: 'Cookie', value: 'auth=super-secret-cookie' },
            { name: 'Referer', value: 'https://referrer.example/' },
          ],
        },
      });

      expect(res.statusCode).toBe(201);
      expect(res.body).not.toContain('super-secret-cookie');
      expect(res.json().jobs[0].headers).toEqual([
        { name: 'Cookie', value: '[REDACTED]' },
        { name: 'Referer', value: 'https://referrer.example/' },
      ]);

      const listRes = await app.inject({ method: 'GET', url: '/api/jobs' });
      expect(listRes.body).not.toContain('super-secret-cookie');

      await queue.shutdown();
    } finally {
      closeSseClients();
      await app.close();
    }
  });
});
