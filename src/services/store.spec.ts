import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { JobStore, trimJobHistory, verifyWritableDirectory } from './store';
import type { Job } from '../types';

function makeJob(id: string, status: Job['status']): Job {
  return {
    id,
    url: `https://93.184.216.34/${id}.mkv`,
    folder: 'Movies',
    subfolder: '',
    destinationRemote: 'gdrive:Media/Movies',
    mode: 'staged',
    autoExtract: false,
    autoRefreshJellyfin: false,
    headers: [],
    status,
    phaseLabel: status,
    progress: {
      percent: 0,
      bytesDone: 0,
      bytesTotal: 0,
      speedBytesPerSec: 0,
      etaSeconds: null,
    },
    logs: [],
    createdAt: new Date().toISOString(),
  };
}

describe('JobStore & directory checks', () => {
  it('quarantines corrupt jobs.json, preserves active/queued jobs on trim, and redacts headers on save', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'drive-dl-store-'));
    try {
      const dataDir = path.join(tmpDir, 'data');
      await fs.mkdir(dataDir, { recursive: true });
      const jobsFile = path.join(dataDir, 'jobs.json');
      await fs.writeFile(jobsFile, '{not valid json', 'utf8');

      const store = new JobStore(dataDir);
      const loaded = await store.init();
      expect(loaded).toEqual([]);

      await expect(fs.stat(jobsFile)).rejects.toThrow(/ENOENT/);
      const entries = await fs.readdir(dataDir);
      const corruptFile = entries.find((name) => name.startsWith('jobs.json.corrupt-'));
      expect(corruptFile).toBeTruthy();
      expect(await fs.readFile(path.join(dataDir, corruptFile!), 'utf8')).toBe('{not valid json');

      const finished = Array.from({ length: 210 }, (_, i) => makeJob(`fin-${i}`, 'completed'));
      const queuedTail = makeJob('queued-tail', 'queued');
      const downloadingHead = makeJob('active-head', 'downloading');
      downloadingHead.headers = [{ name: 'Cookie', value: 'raw-secret' }];
      const all = [downloadingHead, ...finished, queuedTail];

      const trimmed = trimJobHistory(all, 200);
      expect(trimmed).toHaveLength(202);
      expect(trimmed.some((j) => j.id === 'active-head')).toBe(true);
      expect(trimmed.some((j) => j.id === 'queued-tail')).toBe(true);
      expect(trimmed.filter((j) => j.status === 'completed')).toHaveLength(200);

      await store.save(all);
      const postSaveEntries = await fs.readdir(dataDir);
      expect(postSaveEntries).not.toContain('jobs.json.tmp');
      const rawDisk = await fs.readFile(jobsFile, 'utf8');
      expect(rawDisk).not.toContain('raw-secret');

      const persisted = JSON.parse(rawDisk) as Job[];
      expect(persisted).toHaveLength(202);
      expect(persisted[0].headers[0].value).toBe('[REDACTED]');
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('fails fast with a PUID/PGID message when a directory is not writable', async () => {
    if (typeof process.getuid === 'function' && process.getuid() === 0) {
      return;
    }

    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'drive-dl-perm-'));
    const readOnlyDir = path.join(tmpDir, 'readonly');
    try {
      await fs.mkdir(readOnlyDir, { recursive: true });
      await fs.chmod(readOnlyDir, 0o555);

      await expect(verifyWritableDirectory(readOnlyDir, 'STAGING_DIR')).rejects.toThrow(
        /STAGING_DIR.*not writable\/deletable.*PUID\/PGID/,
      );
    } finally {
      await fs.chmod(readOnlyDir, 0o755).catch(() => {});
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });
});
