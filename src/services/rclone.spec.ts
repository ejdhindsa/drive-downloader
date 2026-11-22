import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { AppConfig } from '../config';
import { buildApp } from '../server';
import { JobQueueManager } from './queue';
import { buildCreateDirectoryTarget } from './rclone';
import { JobStore } from './store';

const tempDirs: string[] = [];

afterEach(async () => {
  while (tempDirs.length > 0) {
    await fs.rm(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe('rclone folder creation scoping', () => {
  it('builds valid targets strictly inside RCLONE_ROOT and rejects escapes or injections', () => {
    expect(buildCreateDirectoryTarget('gdrive:Media', 'Anime')).toEqual({
      sanitizedPath: 'Anime',
      remoteTarget: 'gdrive:Media/Anime',
    });

    expect(buildCreateDirectoryTarget('gdrive:Media/', '/TVShows/Severance/Season 02/')).toEqual({
      sanitizedPath: 'TVShows/Severance/Season 02',
      remoteTarget: 'gdrive:Media/TVShows/Severance/Season 02',
    });

    expect(() => buildCreateDirectoryTarget('gdrive:Media', '')).toThrow(/cannot be empty/);
    expect(() => buildCreateDirectoryTarget('gdrive:Media', '   /  ')).toThrow(/cannot be empty/);
    expect(() => buildCreateDirectoryTarget('gdrive:Media', '../Escape')).toThrow(/Invalid path segment/);
    expect(() => buildCreateDirectoryTarget('gdrive:Media', 'Movies/../../Root')).toThrow(/Invalid path segment/);
    expect(() => buildCreateDirectoryTarget('gdrive:Media', 'other:Secret')).toThrow(/Invalid path segment/);
    expect(() => buildCreateDirectoryTarget('gdrive:Media', '--config=/etc/passwd')).toThrow(/Invalid path segment/);
    expect(() => buildCreateDirectoryTarget('gdrive:Media', 'Movies\\Sub')).toThrow(/Invalid path segment/);
  });

  it('POST /api/folders rejects empty, traversal, and cross-site CSRF requests', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'drive-dl-folders-'));
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
      downloadProxy: '',
      jellyfinUrl: '',
      jellyfinApiKey: '',
      rcloneRcUrl: '',
    };

    const store = new JobStore(config.dataDir);
    const queue = new JobQueueManager(config, store);
    await queue.init();

    const { app, closeSseClients } = await buildApp({ config, queue, logger: false });
    try {
      const empty = await app.inject({
        method: 'POST',
        url: '/api/folders',
        payload: { path: '' },
      });
      expect(empty.statusCode).toBe(400);

      const traversal = await app.inject({
        method: 'POST',
        url: '/api/folders',
        payload: { path: '../OutsideMedia' },
      });
      expect(traversal.statusCode).toBe(400);

      const crossOrigin = await app.inject({
        method: 'POST',
        url: '/api/folders',
        headers: { host: 'downloader.example.com', origin: 'https://evil.example' },
        payload: { path: 'Anime' },
      });
      expect(crossOrigin.statusCode).toBe(403);
    } finally {
      closeSseClients();
      await app.close();
    }
  });
});
