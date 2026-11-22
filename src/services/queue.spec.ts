import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { AppConfig } from '../config';
import type { Job } from '../types';
import { JobQueueManager, buildAria2Args, parseAria2ProgressLine } from './queue';
import {
  assertNoSkippedFiles,
  buildProxyEnv,
  listRemainingFiles,
  runRcloneCopyUrl,
} from './rclone';
import { JobStore } from './store';

function makeTestConfig(tmpDir: string, maxConcurrentJobs = 2): AppConfig {
  return {
    port: 3000,
    host: '127.0.0.1',
    rcloneRoot: 'gdrive:Media',
    rcloneConfig: path.join(tmpDir, 'rclone.conf'),
    stagingDir: path.join(tmpDir, 'staging'),
    dataDir: path.join(tmpDir, 'data'),
    maxConcurrentJobs,
    minFreeDiskBytes: 1024,
    maxExtractBytes: 50 * 1024 ** 3,
    downloadProxy: '',
    jellyfinUrl: '',
    jellyfinApiKey: '',
    rcloneRcUrl: '',
  };
}

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

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('aria2c & rclone helpers', () => {
  it('parses aria2c progress lines for size, percent, speed, and ETA', () => {
    const line = '[#1a2b3c 45MiB/100MiB(45%) CN:16 DL:12.5MiB ETA:1m4s]';
    const parsed = parseAria2ProgressLine(line);
    expect(parsed).toEqual({
      percent: 45,
      bytesDone: 45 * 1024 * 1024,
      bytesTotal: 100 * 1024 * 1024,
      speedBytesPerSec: Math.round(12.5 * 1024 * 1024),
      etaSeconds: 64,
    });
  });

  it('disables torrent/metalink/DHT/PEX/seeding and wires optional proxy in buildAria2Args', () => {
    const args = buildAria2Args(
      {
        url: 'https://cdn.example.com/movie.mkv',
        customFilename: 'Movie.mkv',
        headers: [{ name: 'Referer', value: 'https://cdn.example.com/' }],
      },
      '/tmp/staging/job-1',
      'http://gluetun:8888',
    );

    const requiredFlags = [
      '--follow-torrent=false',
      '--follow-metalink=false',
      '--enable-dht=false',
      '--enable-dht6=false',
      '--bt-enable-lpd=false',
      '--enable-peer-exchange=false',
      '--seed-time=0',
      '--all-proxy=http://gluetun:8888',
    ];

    for (const flag of requiredFlags) {
      expect(args).toContain(flag);
    }
    expect(args).toContain('--dir=/tmp/staging/job-1');
    expect(args).toContain('--out=Movie.mkv');
    expect(args).toContain('--header=Referer: https://cdn.example.com/');
    expect(args[args.length - 1]).toBe('https://cdn.example.com/movie.mkv');
  });

  it('builds proxy environment variables for rclone copyurl', () => {
    expect(buildProxyEnv('')).toBeUndefined();
    const env = buildProxyEnv('http://gluetun:8888', { PATH: '/usr/bin' });
    expect(env).toEqual({
      PATH: '/usr/bin',
      HTTP_PROXY: 'http://gluetun:8888',
      HTTPS_PROXY: 'http://gluetun:8888',
      http_proxy: 'http://gluetun:8888',
      https_proxy: 'http://gluetun:8888',
    });
  });

  it('detects leftover skipped files after rclone move', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'drive-dl-skip-'));
    try {
      const uploadDir = path.join(tmpDir, 'extracted');

      expect(await listRemainingFiles(uploadDir)).toEqual([]);
      await assertNoSkippedFiles(uploadDir, 'gdrive:Media/Movies');

      await fs.mkdir(path.join(uploadDir, 'Season 01'), { recursive: true });
      expect(await listRemainingFiles(uploadDir)).toEqual([]);
      await assertNoSkippedFiles(uploadDir, 'gdrive:Media/Movies');

      await fs.writeFile(path.join(uploadDir, 'Season 01', 'Episode 01.mkv'), 'data');
      await fs.writeFile(path.join(uploadDir, 'readme.txt'), 'data');

      expect(await listRemainingFiles(uploadDir)).toEqual([
        path.join('Season 01', 'Episode 01.mkv'),
        'readme.txt',
      ]);

      await expect(assertNoSkippedFiles(uploadDir, 'gdrive:Media/Shows')).rejects.toThrow(
        /Upload skipped 2 file\(s\) already existing at gdrive:Media\/Shows: .*Episode 01\.mkv.*readme\.txt/,
      );
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });
});

describe('JobQueueManager concurrency, cancellation, retry, and redaction', () => {
  it('claims jobs synchronously, caps concurrency at maxConcurrentJobs=2, and drains FIFO', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'drive-dl-conc-'));
    try {
      const config = makeTestConfig(tmpDir, 2);
      const store = new JobStore(config.dataDir);
      const queue = new JobQueueManager(config, store);
      await queue.init();

      const startedIds: string[] = [];
      const gates = new Map<string, ReturnType<typeof deferred<void>>>();
      const waitForStarted = (count: number) =>
        new Promise<void>((resolve) => {
          const check = () => {
            if (startedIds.length >= count) resolve();
            else setTimeout(check, 5);
          };
          check();
        });

      const internals = queue as unknown as {
        executeStagedTransfer: (job: { id: string }) => Promise<void>;
      };
      internals.executeStagedTransfer = async (job) => {
        startedIds.push(job.id);
        const gate = deferred<void>();
        gates.set(job.id, gate);
        await gate.promise;
      };

      const created = await queue.enqueueJobs({
        urls: [
          'https://93.184.216.34/one.mkv',
          'https://93.184.216.34/two.mkv',
          'https://93.184.216.34/three.mkv',
        ],
        folder: 'Movies',
        mode: 'staged',
        autoExtract: false,
        autoRefreshJellyfin: false,
      });

      expect(created[0].status).toBe('downloading');
      expect(created[1].status).toBe('downloading');
      expect(created[2].status).toBe('queued');

      await waitForStarted(2);
      expect(startedIds).toEqual([created[0].id, created[1].id]);

      gates.get(created[0].id)!.resolve(undefined);
      await waitForStarted(3);

      expect(queue.getJob(created[0].id)?.status).toBe('completed');
      expect(startedIds).toEqual([created[0].id, created[1].id, created[2].id]);

      gates.get(created[1].id)!.resolve(undefined);
      gates.get(created[2].id)!.resolve(undefined);
      await new Promise<void>((resolve) => {
        const check = () => {
          if (
            queue.getJob(created[1].id)?.status === 'completed' &&
            queue.getJob(created[2].id)?.status === 'completed'
          ) {
            resolve();
          } else {
            setTimeout(check, 5);
          }
        };
        check();
      });

      expect(queue.getJob(created[1].id)?.status).toBe('completed');
      expect(queue.getJob(created[2].id)?.status).toBe('completed');
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('does not double-invoke runJob and cancels cleanly during starting state', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'drive-dl-cancel-'));
    try {
      const config = makeTestConfig(tmpDir, 2);
      const store = new JobStore(config.dataDir);
      const queue = new JobQueueManager(config, store);
      await queue.init();

      const runCalls: string[] = [];
      const queueStub = new JobQueueManager(config, new JobStore(path.join(tmpDir, 'data-stub')));
      await queueStub.init();
      (queueStub as unknown as { runJob: (job: { id: string }) => Promise<void> }).runJob = async (
        job,
      ) => {
        runCalls.push(job.id);
        await new Promise(() => {});
      };

      const stubJobs = await queueStub.enqueueJobs({
        urls: ['https://93.184.216.34/a.mkv', 'https://93.184.216.34/b.mkv'],
        folder: 'Movies',
        mode: 'staged',
        autoExtract: false,
        autoRefreshJellyfin: false,
      });
      expect(runCalls).toEqual([stubJobs[0].id, stubJobs[1].id]);

      const slowDiskGate = deferred<{ freeBytes: number; totalBytes: number }>();
      queue.getDiskStatus = () => slowDiskGate.promise;

      const [job] = await queue.enqueueJobs({
        urls: ['https://93.184.216.34/cancel-me.mkv'],
        folder: 'Movies',
        mode: 'staged',
        autoExtract: false,
        autoRefreshJellyfin: false,
      });

      expect(job.phaseLabel).toBe('Starting');
      const cancelling = await queue.cancelJob(job.id);
      expect(cancelling.id).toBe(job.id);

      slowDiskGate.resolve({ freeBytes: 100 * 1024 ** 3, totalBytes: 200 * 1024 ** 3 });
      await new Promise<void>((resolve) => {
        const check = () => {
          if (queue.getJob(job.id)?.status === 'cancelled') resolve();
          else setTimeout(check, 5);
        };
        check();
      });

      expect(queue.getJob(job.id)?.status).toBe('cancelled');
      expect(queue.getJob(job.id)?.phaseLabel).toBe('Cancelled');
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('rejects custom headers in direct mode', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'drive-dl-direct-hdr-'));
    try {
      const config = makeTestConfig(tmpDir, 2);
      const store = new JobStore(config.dataDir);
      const queue = new JobQueueManager(config, store);
      await queue.init();

      await expect(
        queue.enqueueJobs({
          urls: ['https://93.184.216.34/file.mkv'],
          folder: 'Movies',
          mode: 'direct',
          autoExtract: false,
          autoRefreshJellyfin: false,
          headers: [{ name: 'Authorization', value: 'Bearer secret' }],
        }),
      ).rejects.toThrow(/Custom HTTP headers are only supported in Staged mode/);

      await expect(
        runRcloneCopyUrl(
          config,
          {
            url: 'https://93.184.216.34/file.mkv',
            destRemoteDir: 'gdrive:Media/Movies',
            headers: [{ name: 'Cookie', value: 'session=abc' }],
          },
          {
            signal: new AbortController().signal,
            onProgress: () => {},
            onLog: () => {},
          },
        ),
      ).rejects.toThrow(/Custom HTTP headers are only supported in Staged mode/);
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('uses isolated per-run staging dirs on retry and cleans up cleanly', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'drive-dl-retry-'));
    try {
      const config = makeTestConfig(tmpDir, 1);
      const store = new JobStore(config.dataDir);
      const queue = new JobQueueManager(config, store);
      await queue.init();

      const seenDirs: string[] = [];
      const run2Started = deferred<void>();
      const run2Gate = deferred<void>();
      let attempt = 0;

      const internals = queue as unknown as {
        executeStagedTransfer: (job: Job, jobStagingDir: string) => Promise<void>;
      };
      internals.executeStagedTransfer = async (_job, jobStagingDir) => {
        attempt += 1;
        seenDirs.push(jobStagingDir);
        await fs.mkdir(jobStagingDir, { recursive: true });
        await fs.writeFile(path.join(jobStagingDir, 'file.bin'), 'payload');
        if (attempt === 1) {
          throw new Error('Transient download failure');
        }
        run2Started.resolve();
        await run2Gate.promise;
      };

      const [job] = await queue.enqueueJobs({
        urls: ['https://93.184.216.34/movie.mkv'],
        folder: 'Movies',
        mode: 'staged',
        autoExtract: false,
        autoRefreshJellyfin: false,
      });

      await new Promise<void>((resolve) => {
        const check = () => {
          if (queue.getJob(job.id)?.status === 'failed') resolve();
          else setTimeout(check, 5);
        };
        check();
      });

      await queue.retryJob(job.id);
      await run2Started.promise;

      expect(seenDirs).toHaveLength(2);
      expect(seenDirs[0]).not.toBe(seenDirs[1]);
      expect(await fs.readFile(path.join(seenDirs[1], 'file.bin'), 'utf8')).toBe('payload');

      run2Gate.resolve();
      await new Promise<void>((resolve) => {
        const check = () => {
          if (queue.getJob(job.id)?.status === 'completed') resolve();
          else setTimeout(check, 5);
        };
        check();
      });

      await expect(fs.stat(path.join(config.stagingDir, job.id))).rejects.toThrow(/ENOENT/);
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('removes staging dirs on deleteJob/clearFinished and awaits active runs on shutdown', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'drive-dl-shutdown-'));
    try {
      const config = makeTestConfig(tmpDir, 1);
      const store = new JobStore(config.dataDir);
      const job1 = makeJob('job-del-1', 'failed');
      const job2 = makeJob('job-clr-2', 'completed');
      const job3 = makeJob('job-run-3', 'queued');

      await fs.mkdir(path.join(config.stagingDir, job1.id, 'old-run'), { recursive: true });
      await fs.writeFile(path.join(config.stagingDir, job1.id, 'old-run', 'a.bin'), 'x');
      await fs.mkdir(path.join(config.stagingDir, job2.id, 'old-run'), { recursive: true });
      await fs.writeFile(path.join(config.stagingDir, job2.id, 'old-run', 'b.bin'), 'y');

      await store.init();
      await store.save([job1, job2]);

      const queue = new JobQueueManager(config, store);
      await queue.init();

      await queue.deleteJob(job1.id);
      await expect(fs.stat(path.join(config.stagingDir, job1.id))).rejects.toThrow(/ENOENT/);

      expect(await queue.clearFinished()).toBe(1);
      await expect(fs.stat(path.join(config.stagingDir, job2.id))).rejects.toThrow(/ENOENT/);

      const started = deferred<void>();
      const internals = queue as unknown as {
        executeStagedTransfer: (job: Job, dir: string, signal: AbortSignal) => Promise<void>;
      };
      internals.executeStagedTransfer = async (_job, dir, signal) => {
        await fs.mkdir(dir, { recursive: true });
        await fs.writeFile(path.join(dir, 'part.bin'), 'partial');
        started.resolve();
        await new Promise<void>((_, reject) => {
          signal.addEventListener('abort', () => {
            setTimeout(() => reject(new Error('Cancelled')), 30);
          });
        });
      };

      const [active] = await queue.enqueueJobs({
        urls: [`https://93.184.216.34/${job3.id}.mkv`],
        folder: 'Movies',
        mode: 'staged',
        autoExtract: false,
        autoRefreshJellyfin: false,
      });

      await started.promise;
      await queue.shutdown();

      expect(queue.getJob(active.id)?.status).toBe('cancelled');
      await expect(fs.stat(path.join(config.stagingDir, active.id))).rejects.toThrow(/ENOENT/);
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('redacts sensitive headers in events, listJobs, and jobs.json while retaining them in memory for execution', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'drive-dl-redact-'));
    try {
      const config = makeTestConfig(tmpDir, 1);
      const store = new JobStore(config.dataDir);
      const queue = new JobQueueManager(config, store);
      await queue.init();

      const emittedJobs: Job[] = [];
      queue.on('job-update', (j: Job) => emittedJobs.push(j));

      let executionHeaders: Array<{ name: string; value: string }> = [];
      const internals = queue as unknown as {
        getExecutionHeaders: (job: Job) => Array<{ name: string; value: string }>;
        executeStagedTransfer: (job: Job) => Promise<void>;
      };
      internals.executeStagedTransfer = async (job) => {
        executionHeaders = internals.getExecutionHeaders(job);
      };

      const [created] = await queue.enqueueJobs({
        urls: ['https://93.184.216.34/private.mkv'],
        folder: 'Movies',
        mode: 'staged',
        autoExtract: false,
        autoRefreshJellyfin: false,
        headers: [
          { name: 'Authorization', value: 'Bearer real-secret-token' },
          { name: 'Referer', value: 'https://source.example/' },
        ],
      });

      await new Promise<void>((resolve) => {
        const check = () => {
          if (queue.getJob(created.id)?.status === 'completed') resolve();
          else setTimeout(check, 5);
        };
        check();
      });

      expect(executionHeaders).toEqual([
        { name: 'Authorization', value: 'Bearer real-secret-token' },
        { name: 'Referer', value: 'https://source.example/' },
      ]);
      expect(created.headers[0].value).toBe('[REDACTED]');
      expect(emittedJobs.every((j) => j.headers[0].value === '[REDACTED]')).toBe(true);

      const persistedRaw = await fs.readFile(path.join(config.dataDir, 'jobs.json'), 'utf8');
      expect(persistedRaw).not.toContain('real-secret-token');
      expect(persistedRaw).toContain('[REDACTED]');
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });
});
