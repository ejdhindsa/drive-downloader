import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { AppConfig } from '../src/config';
import { JobQueueManager, buildAria2Args } from '../src/queue';
import {
  assertNoSkippedFiles,
  listRemainingFiles,
  runRcloneCopyUrl,
} from '../src/rclone';
import { JobStore } from '../src/store';

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
    jellyfinUrl: '',
    jellyfinApiKey: '',
    rcloneRcUrl: '',
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

test('B1: pumpQueue claims jobs synchronously, caps at maxConcurrentJobs=2, and does not loop or double-invoke runJob', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'drive-dl-b1-'));
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

    // Synchronous claim: first two jobs must already be claimed, third must remain queued
    assert.equal(created[0].status, 'downloading');
    assert.equal(created[1].status, 'downloading');
    assert.equal(created[2].status, 'queued');

    await waitForStarted(2);
    assert.deepEqual(startedIds, [created[0].id, created[1].id]);

    // Finish first job -> third job should start without re-invoking job 0 or job 1
    gates.get(created[0].id)!.resolve(undefined);
    await waitForStarted(3);

    assert.equal(created[0].status, 'completed');
    assert.deepEqual(startedIds, [created[0].id, created[1].id, created[2].id]);

    gates.get(created[1].id)!.resolve(undefined);
    gates.get(created[2].id)!.resolve(undefined);
    await new Promise<void>((resolve) => {
      const check = () => {
        if (created[1].status === 'completed' && created[2].status === 'completed') resolve();
        else setTimeout(check, 5);
      };
      check();
    });

    assert.equal(created[1].status, 'completed');
    assert.equal(created[2].status, 'completed');
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test('B1: pumpQueue does not double-invoke runJob even when runJob is stubbed and cancelJob works in starting state', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'drive-dl-b1-cancel-'));
  try {
    const config = makeTestConfig(tmpDir, 2);
    const store = new JobStore(config.dataDir);
    const queue = new JobQueueManager(config, store);
    await queue.init();

    // Part 1: Verify runJob invocation count directly when runJob never settles synchronously
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
    assert.deepEqual(runCalls, [stubJobs[0].id, stubJobs[1].id]);

    // Part 2: Verify cancelJob works cleanly during the starting transition
    const slowDiskGate = deferred<{ freeBytes: number; totalBytes: number }>();
    queue.getDiskStatus = () => slowDiskGate.promise;

    const [job] = await queue.enqueueJobs({
      urls: ['https://93.184.216.34/cancel-me.mkv'],
      folder: 'Movies',
      mode: 'staged',
      autoExtract: false,
      autoRefreshJellyfin: false,
    });

    assert.equal(job.phaseLabel, 'Starting');
    const cancelling = await queue.cancelJob(job.id);
    assert.equal(cancelling.id, job.id);

    slowDiskGate.resolve({ freeBytes: 100 * 1024 ** 3, totalBytes: 200 * 1024 ** 3 });
    await new Promise<void>((resolve) => {
      const check = () => {
        if (job.status === 'cancelled') resolve();
        else setTimeout(check, 5);
      };
      check();
    });

    assert.equal(job.status, 'cancelled');
    assert.equal(job.phaseLabel, 'Cancelled');
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test('B3: buildAria2Args disables torrent, metalink, DHT, LPD, PEX, and seeding', () => {
  const args = buildAria2Args(
    {
      url: 'https://cdn.example.com/movie.mkv',
      customFilename: 'Movie.mkv',
      headers: [{ name: 'Referer', value: 'https://cdn.example.com/' }],
    },
    '/tmp/staging/job-1',
  );

  const requiredFlags = [
    '--follow-torrent=false',
    '--follow-metalink=false',
    '--enable-dht=false',
    '--enable-dht6=false',
    '--bt-enable-lpd=false',
    '--enable-peer-exchange=false',
    '--seed-time=0',
  ];

  for (const flag of requiredFlags) {
    assert.ok(args.includes(flag), `Expected aria2c args to include ${flag}`);
  }
  assert.ok(args.includes('--dir=/tmp/staging/job-1'));
  assert.ok(args.includes('--out=Movie.mkv'));
  assert.ok(args.includes('--header=Referer: https://cdn.example.com/'));
  assert.equal(args[args.length - 1], 'https://cdn.example.com/movie.mkv');
});

test('B5: enqueueJobs and runRcloneCopyUrl reject custom headers in direct mode', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'drive-dl-b5-'));
  try {
    const config = makeTestConfig(tmpDir, 2);
    const store = new JobStore(config.dataDir);
    const queue = new JobQueueManager(config, store);
    await queue.init();

    await assert.rejects(
      () =>
        queue.enqueueJobs({
          urls: ['https://93.184.216.34/file.mkv'],
          folder: 'Movies',
          mode: 'direct',
          autoExtract: false,
          autoRefreshJellyfin: false,
          headers: [{ name: 'Authorization', value: 'Bearer secret' }],
        }),
      /Custom HTTP headers are only supported in Staged mode/,
    );

    await assert.rejects(
      () =>
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
      /Custom HTTP headers are only supported in Staged mode/,
    );
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test('B6: listRemainingFiles and assertNoSkippedFiles detect leftover skipped files after rclone move', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'drive-dl-b6-'));
  try {
    const uploadDir = path.join(tmpDir, 'extracted');

    // Non-existent dir (e.g. removed by rclone --delete-empty-src-dirs) passes cleanly
    assert.deepEqual(await listRemainingFiles(uploadDir), []);
    await assertNoSkippedFiles(uploadDir, 'gdrive:Media/Movies');

    // Empty directories alone pass cleanly
    await fs.mkdir(path.join(uploadDir, 'Season 01'), { recursive: true });
    assert.deepEqual(await listRemainingFiles(uploadDir), []);
    await assertNoSkippedFiles(uploadDir, 'gdrive:Media/Movies');

    // Leftover skipped files (nested and top-level) trigger a clear error naming them
    await fs.writeFile(path.join(uploadDir, 'Season 01', 'Episode 01.mkv'), 'data');
    await fs.writeFile(path.join(uploadDir, 'readme.txt'), 'data');

    const remaining = await listRemainingFiles(uploadDir);
    assert.deepEqual(remaining, [path.join('Season 01', 'Episode 01.mkv'), 'readme.txt']);

    await assert.rejects(
      () => assertNoSkippedFiles(uploadDir, 'gdrive:Media/Shows'),
      /Upload skipped 2 file\(s\) already existing at gdrive:Media\/Shows: .*Episode 01\.mkv.*readme\.txt/,
    );
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});
