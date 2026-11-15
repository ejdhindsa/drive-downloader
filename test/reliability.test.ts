import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import type { AppConfig } from '../src/config';
import { resolve7zBinary, sanitizeExtractedTree } from '../src/extractor';
import { attachAbortKill } from '../src/process';
import { JobQueueManager } from '../src/queue';
import { JobStore, trimJobHistory, verifyWritableDirectory } from '../src/store';
import type { Job } from '../src/types';

const execFileAsync = promisify(execFile);

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

test('NB2: retry uses isolated per-run staging directory and avoids cleanup race', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'drive-dl-nb2-'));
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
        if (job.status === 'failed') resolve();
        else setTimeout(check, 5);
      };
      check();
    });

    await queue.retryJob(job.id);
    await run2Started.promise;

    assert.equal(seenDirs.length, 2);
    assert.notEqual(seenDirs[0], seenDirs[1]);
    // Run 2's staging file must still be intact
    const content = await fs.readFile(path.join(seenDirs[1], 'file.bin'), 'utf8');
    assert.equal(content, 'payload');

    run2Gate.resolve();
    await new Promise<void>((resolve) => {
      const check = () => {
        if (job.status === 'completed') resolve();
        else setTimeout(check, 5);
      };
      check();
    });

    // Both per-run dirs and job staging root should be cleaned up
    await assert.rejects(() => fs.stat(path.join(config.stagingDir, job.id)), /ENOENT/);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test('NB3: attachAbortKill escalates SIGTERM-ignoring child to SIGKILL and clears timer on close', async () => {
  const child = spawn(
    process.execPath,
    ['-e', "process.on('SIGTERM', () => {}); console.log('ready'); setInterval(() => {}, 1000);"],
    { stdio: ['ignore', 'pipe', 'ignore'] },
  );

  const controller = new AbortController();
  const handle = attachAbortKill(child, controller.signal, 80);

  await new Promise<void>((resolve) => {
    child.stdout.on('data', (chunk: Buffer) => {
      if (chunk.toString('utf8').includes('ready')) resolve();
    });
  });

  controller.abort();

  const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (resolve) => {
      child.on('close', (code, sig) => {
        handle.cleanup();
        resolve({ code, signal: sig });
      });
    },
  );

  assert.equal(handle.wasAborted(), true);
  assert.equal(result.code, null);
  assert.equal(result.signal, 'SIGKILL');

  // Also verify normal exit with cleanup leaves no error
  const fastChild = spawn(process.execPath, ['-e', 'process.exit(0)'], { stdio: 'ignore' });
  const fastHandle = attachAbortKill(fastChild, new AbortController().signal, 50);
  const fastExit = await new Promise<number | null>((resolve) => {
    fastChild.on('close', (code) => {
      fastHandle.cleanup();
      resolve(code);
    });
  });
  assert.equal(fastExit, 0);
  assert.equal(fastHandle.wasAborted(), false);
});

test('NB4: deleteJob and clearFinished remove staging dirs, and shutdown awaits active runs', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'drive-dl-nb4-'));
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
    await assert.rejects(() => fs.stat(path.join(config.stagingDir, job1.id)), /ENOENT/);

    const removed = await queue.clearFinished();
    assert.equal(removed, 1);
    await assert.rejects(() => fs.stat(path.join(config.stagingDir, job2.id)), /ENOENT/);

    // Verify shutdown aborts and awaits active run cleanup before returning
    const started = deferred<void>();
    const cleanupFinished = deferred<void>();
    const internals = queue as unknown as {
      executeStagedTransfer: (job: Job, dir: string, signal: AbortSignal) => Promise<void>;
    };
    internals.executeStagedTransfer = async (_job, dir, signal) => {
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(path.join(dir, 'part.bin'), 'partial');
      started.resolve();
      await new Promise<void>((_, reject) => {
        signal.addEventListener('abort', () => {
          setTimeout(() => {
            cleanupFinished.resolve();
            reject(new Error('Cancelled'));
          }, 30);
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

    assert.equal(active.status, 'cancelled');
    await assert.rejects(() => fs.stat(path.join(config.stagingDir, active.id)), /ENOENT/);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test('NB5: sanitizeExtractedTree normalizes restrictive permissions and strips symlinks and FIFOs', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'drive-dl-nb5-'));
  const extractDir = path.join(tmpDir, 'extracted');
  const roDir = path.join(extractDir, 'ro-dir');
  const zeroDir = path.join(extractDir, 'zero-dir');
  try {
    await fs.mkdir(roDir, { recursive: true });
    await fs.mkdir(zeroDir, { recursive: true });

    const fileInRo = path.join(roDir, 'movie.mkv');
    const fileInZero = path.join(zeroDir, 'extra.mkv');
    await fs.writeFile(fileInRo, 'video');
    await fs.writeFile(fileInZero, 'extra');
    await fs.chmod(fileInRo, 0o444);
    await fs.chmod(fileInZero, 0o000);

    // Create symlink and FIFO
    await fs.symlink('/etc/passwd', path.join(extractDir, 'bad-link'));
    await execFileAsync('mkfifo', [path.join(extractDir, 'bad-pipe')]);

    // Lock directory modes
    await fs.chmod(roDir, 0o555);
    await fs.chmod(zeroDir, 0o000);

    const logs: string[] = [];
    await sanitizeExtractedTree(extractDir, (line) => logs.push(line));

    const roDirStat = await fs.lstat(roDir);
    const zeroDirStat = await fs.lstat(zeroDir);
    const fileInRoStat = await fs.lstat(fileInRo);
    const fileInZeroStat = await fs.lstat(fileInZero);

    assert.equal(roDirStat.mode & 0o777, 0o755);
    assert.equal(zeroDirStat.mode & 0o777, 0o755);
    assert.equal(fileInRoStat.mode & 0o600, 0o600);
    assert.equal(fileInZeroStat.mode & 0o600, 0o600);

    await assert.rejects(() => fs.lstat(path.join(extractDir, 'bad-link')), /ENOENT/);
    await assert.rejects(() => fs.lstat(path.join(extractDir, 'bad-pipe')), /ENOENT/);
    assert.ok(logs.some((l) => l.includes('symlink')));
    assert.ok(logs.some((l) => l.includes('special file')));
  } finally {
    await fs.chmod(zeroDir, 0o755).catch(() => {});
    await fs.chmod(roDir, 0o755).catch(() => {});
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test('NB12: JobStore quarantines corrupt jobs.json, syncs save, and trimJobHistory keeps queued/active jobs', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'drive-dl-nb12-'));
  try {
    const dataDir = path.join(tmpDir, 'data');
    await fs.mkdir(dataDir, { recursive: true });
    const jobsFile = path.join(dataDir, 'jobs.json');
    await fs.writeFile(jobsFile, '{not valid json', 'utf8');

    const store = new JobStore(dataDir);
    const loaded = await store.init();
    assert.deepEqual(loaded, []);

    // Original file should be quarantined to jobs.json.corrupt-<timestamp>
    await assert.rejects(() => fs.stat(jobsFile), /ENOENT/);
    const entries = await fs.readdir(dataDir);
    const corruptFile = entries.find((name) => name.startsWith('jobs.json.corrupt-'));
    assert.ok(corruptFile, 'Expected jobs.json.corrupt-<timestamp> file');
    assert.equal(await fs.readFile(path.join(dataDir, corruptFile), 'utf8'), '{not valid json');

    // Verify trimJobHistory preserves all active/queued jobs even past 200 finished jobs
    const finished = Array.from({ length: 210 }, (_, i) => makeJob(`fin-${i}`, 'completed'));
    const queuedTail = makeJob('queued-tail', 'queued');
    const downloadingHead = makeJob('active-head', 'downloading');
    const all = [downloadingHead, ...finished, queuedTail];

    const trimmed = trimJobHistory(all, 200);
    assert.equal(trimmed.length, 202);
    assert.ok(trimmed.some((j) => j.id === 'active-head'));
    assert.ok(trimmed.some((j) => j.id === 'queued-tail'));
    assert.equal(trimmed.filter((j) => j.status === 'completed').length, 200);

    // Save and reload via JobStore
    await store.save(all);
    const postSaveEntries = await fs.readdir(dataDir);
    assert.ok(!postSaveEntries.includes('jobs.json.tmp'));
    const persisted = JSON.parse(await fs.readFile(jobsFile, 'utf8')) as Job[];
    assert.equal(persisted.length, 202);
    assert.ok(persisted.some((j) => j.id === 'queued-tail'));
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test('NB16: verifyWritableDirectory fails fast with clear PUID/PGID error on non-writable dir', async (t) => {
  if (typeof process.getuid === 'function' && process.getuid() === 0) {
    t.skip('Running as root bypasses POSIX directory permission checks');
    return;
  }

  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'drive-dl-nb16-'));
  const readOnlyDir = path.join(tmpDir, 'readonly');
  try {
    await fs.mkdir(readOnlyDir, { recursive: true });
    await fs.chmod(readOnlyDir, 0o555);

    await assert.rejects(
      () => verifyWritableDirectory(readOnlyDir, 'STAGING_DIR'),
      /STAGING_DIR.*not writable\/deletable.*PUID\/PGID/,
    );
  } finally {
    await fs.chmod(readOnlyDir, 0o755).catch(() => {});
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test('NB17: resolve7zBinary resolves 7zz or 7z from PATH and throws clear error when missing', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'drive-dl-nb17-'));
  try {
    const dir7zz = path.join(tmpDir, 'bin-7zz');
    const dir7z = path.join(tmpDir, 'bin-7z');
    const dirNonExec = path.join(tmpDir, 'bin-nonexec');
    await fs.mkdir(dir7zz, { recursive: true });
    await fs.mkdir(dir7z, { recursive: true });
    await fs.mkdir(dirNonExec, { recursive: true });

    const bin7zz = path.join(dir7zz, '7zz');
    const bin7z = path.join(dir7z, '7z');
    const binBad = path.join(dirNonExec, '7zz');

    await fs.writeFile(bin7zz, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    await fs.writeFile(bin7z, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    await fs.writeFile(binBad, 'not executable', { mode: 0o644 });

    assert.equal(await resolve7zBinary(dir7zz), bin7zz);
    assert.equal(await resolve7zBinary(dir7z), bin7z);
    assert.equal(await resolve7zBinary(`${dirNonExec}${path.delimiter}${dir7z}`), bin7z);

    await assert.rejects(
      () => resolve7zBinary(dirNonExec),
      /Required archive tool not found in PATH \(tried: 7zz, 7z\)/,
    );
    await assert.rejects(
      () => resolve7zBinary(''),
      /Required archive tool not found in PATH \(tried: 7zz, 7z\)/,
    );
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});
