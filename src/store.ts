import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { redactJobForOutput } from './security';
import type { Job } from './types';

export const MAX_FINISHED_JOBS = 200;

export function isActiveOrQueuedStatus(status: Job['status']): boolean {
  return (
    status === 'queued' ||
    status === 'downloading' ||
    status === 'extracting' ||
    status === 'uploading'
  );
}

/**
 * Preserves all active/queued jobs untouched and caps finished job history to `maxFinished`.
 */
export function trimJobHistory(jobs: Job[], maxFinished = MAX_FINISHED_JOBS): Job[] {
  let finishedCount = 0;
  return jobs.filter((job) => {
    if (isActiveOrQueuedStatus(job.status)) {
      return true;
    }
    finishedCount += 1;
    return finishedCount <= maxFinished;
  });
}

/**
 * Verifies that `dirPath` can be created, written to, and deleted from by the current process.
 */
export async function verifyWritableDirectory(dirPath: string, label: string): Promise<void> {
  const probeName = `.write-probe-${process.pid}-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
  const probePath = path.join(dirPath, probeName);
  try {
    await fs.mkdir(dirPath, { recursive: true });
    await fs.writeFile(probePath, 'ok', 'utf8');
    await fs.unlink(probePath);
  } catch (err) {
    await fs.unlink(probePath).catch(() => {});
    const uid = typeof process.getuid === 'function' ? process.getuid() : 'unknown';
    const gid = typeof process.getgid === 'function' ? process.getgid() : 'unknown';
    throw new Error(
      `${label} (${dirPath}) is not writable/deletable by uid=${uid} gid=${gid}: ${(err as Error).message}. ` +
        `Check directory ownership/permissions or set PUID/PGID to match the host directory owner.`,
    );
  }
}

export class JobStore {
  private readonly filePath: string;
  private writeChain: Promise<void> = Promise.resolve();

  constructor(dataDir: string) {
    this.filePath = path.join(dataDir, 'jobs.json');
  }

  async init(): Promise<Job[]> {
    await verifyWritableDirectory(path.dirname(this.filePath), 'DATA_DIR');
    try {
      const raw = await fs.readFile(this.filePath, 'utf8');
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch (parseErr) {
        const corruptPath = `${this.filePath}.corrupt-${Date.now()}`;
        await fs.rename(this.filePath, corruptPath).catch(() => {});
        console.warn(
          `Corrupt jobs.json detected; quarantined to ${corruptPath} and starting with empty job list:`,
          parseErr,
        );
        return [];
      }
      if (!Array.isArray(parsed)) {
        const corruptPath = `${this.filePath}.corrupt-${Date.now()}`;
        await fs.rename(this.filePath, corruptPath).catch(() => {});
        console.warn(
          `Invalid jobs.json format (expected array); quarantined to ${corruptPath} and starting with empty job list`,
        );
        return [];
      }
      const now = new Date().toISOString();
      let dirty = false;
      const jobs: Job[] = parsed.map((job: Job) => {
        if (isActiveOrQueuedStatus(job.status)) {
          dirty = true;
          return {
            ...job,
            status: 'failed',
            phaseLabel: 'Interrupted',
            error: 'Container restarted while job was in progress. Click Retry to resume.',
            finishedAt: now,
            logs: [...(job.logs ?? []), `[${now}] Interrupted by container restart`].slice(-100),
          };
        }
        return job;
      });
      if (dirty) {
        await this.save(jobs);
      }
      return jobs;
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') {
        return [];
      }
      throw err;
    }
  }

  save(jobs: Job[]): Promise<void> {
    const trimmed = trimJobHistory(jobs).map(redactJobForOutput);
    const payload = JSON.stringify(trimmed, null, 2);
    this.writeChain = this.writeChain
      .then(async () => {
        const tmpPath = `${this.filePath}.tmp`;
        const fh = await fs.open(tmpPath, 'w');
        try {
          await fh.writeFile(payload, 'utf8');
          await fh.sync();
        } finally {
          await fh.close();
        }
        await fs.rename(tmpPath, this.filePath);
      })
      .catch((err) => {
        console.error('Failed to persist jobs.json:', err);
      });
    return this.writeChain;
  }
}
