import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import EventEmitter from 'node:events';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { AppConfig } from '../config';
import { GIB, MIB, REDACTED_VALUE } from '../consts';
import type {
  CreateJobsRequest,
  CustomHeader,
  DiskStatus,
  Job,
  JobProgress,
} from '../types';
import { attachAbortKill } from '../utils/process';
import {
  redactHeaders,
  redactJobForOutput,
  redactProxyUrl,
  resolveSafeUrl,
  sanitizeFilename,
  sanitizeFolderName,
  sanitizeHeaders,
  sanitizeRelativePath,
  validatePublicUrl,
} from '../utils/security';
import { detectArchiveFormat, extractArchive } from './extractor';
import { refreshMediaTargets } from './jellyfin';
import { assertNoSkippedFiles, runRcloneCopyUrl, runRcloneMove } from './rclone';
import {
  type JobStore,
  isActiveOrQueuedStatus,
  trimJobHistory,
  verifyWritableDirectory,
} from './store';

function parseSizeToBytes(rawValue: string, unit: string): number {
  const num = Number.parseFloat(rawValue);
  if (!Number.isFinite(num)) return 0;
  switch (unit) {
    case 'B':
      return Math.round(num);
    case 'KiB':
      return Math.round(num * 1024);
    case 'MiB':
      return Math.round(num * MIB);
    case 'GiB':
      return Math.round(num * GIB);
    case 'TiB':
      return Math.round(num * 1024 ** 4);
    case 'KB':
      return Math.round(num * 1000);
    case 'MB':
      return Math.round(num * 1000 ** 2);
    case 'GB':
      return Math.round(num * 1000 ** 3);
    default:
      return Math.round(num);
  }
}

function parseEtaToSeconds(rawEta: string): number | null {
  if (!rawEta) return null;
  let total = 0;
  let matched = false;
  const regex = /(\d+)([dhms])/g;
  let m: RegExpExecArray | null;
  while ((m = regex.exec(rawEta)) !== null) {
    matched = true;
    const val = Number.parseInt(m[1], 10);
    if (m[2] === 'd') total += val * 86400;
    else if (m[2] === 'h') total += val * 3600;
    else if (m[2] === 'm') total += val * 60;
    else if (m[2] === 's') total += val;
  }
  return matched ? total : null;
}

export function parseAria2ProgressLine(line: string): JobProgress | null {
  const match = line.match(
    /([\d.]+)(TiB|GiB|MiB|KiB|GB|MB|KB|B)\/([\d.]+)(TiB|GiB|MiB|KiB|GB|MB|KB|B)\((\d+)%\).*?DL:([\d.]+)(TiB|GiB|MiB|KiB|GB|MB|KB|B)(?:.*?ETA:([0-9dhms]+))?/,
  );
  if (!match) return null;

  const bytesDone = parseSizeToBytes(match[1], match[2]);
  const bytesTotal = parseSizeToBytes(match[3], match[4]);
  const percent = Number.parseInt(match[5], 10);
  const speedBytesPerSec = parseSizeToBytes(match[6], match[7]);
  const etaSeconds = match[8] ? parseEtaToSeconds(match[8]) : null;

  return {
    percent: Number.isFinite(percent) ? Math.min(100, percent) : 0,
    bytesDone,
    bytesTotal,
    speedBytesPerSec,
    etaSeconds,
  };
}

function defaultProgress(): JobProgress {
  return {
    percent: 0,
    bytesDone: 0,
    bytesTotal: 0,
    speedBytesPerSec: 0,
    etaSeconds: null,
  };
}

function guessNameFromUrl(rawUrl: string): string {
  try {
    const parsed = new URL(rawUrl);
    const last = parsed.pathname.split('/').filter(Boolean).pop();
    if (last) return decodeURIComponent(last);
    return parsed.hostname;
  } catch {
    return rawUrl.slice(0, 60);
  }
}

export function buildAria2Args(
  job: Pick<Job, 'url' | 'customFilename' | 'headers'>,
  stagingDir: string,
  proxyUrl?: string,
): string[] {
  const args = [
    `--dir=${stagingDir}`,
    '--allow-overwrite=true',
    '--auto-file-renaming=false',
    '--content-disposition-default-utf8=true',
    '--max-connection-per-server=16',
    '--split=16',
    '--min-split-size=1M',
    '--continue=true',
    '--max-tries=5',
    '--retry-wait=3',
    '--summary-interval=1',
    '--console-log-level=notice',
    '--download-result=full',
    '--follow-torrent=false',
    '--follow-metalink=false',
    '--enable-dht=false',
    '--enable-dht6=false',
    '--bt-enable-lpd=false',
    '--enable-peer-exchange=false',
    '--seed-time=0',
  ];

  if (proxyUrl) {
    args.push(`--all-proxy=${proxyUrl}`);
  }
  if (job.customFilename) {
    args.push(`--out=${job.customFilename}`);
  }
  for (const h of job.headers) {
    args.push(`--header=${h.name}: ${h.value}`);
  }
  args.push(job.url);
  return args;
}

export class JobQueueManager extends EventEmitter {
  private readonly config: AppConfig;
  private readonly store: JobStore;
  private jobs: Job[] = [];
  private readonly activeControllers = new Map<string, AbortController>();
  private readonly activeRuns = new Set<Promise<void>>();
  private readonly lastEmitAt = new Map<string, number>();
  // Keep raw sensitive headers in memory only; job.headers always holds redacted copies.
  private readonly liveHeaders = new Map<string, CustomHeader[]>();
  private shuttingDown = false;

  constructor(config: AppConfig, store: JobStore) {
    super();
    this.config = config;
    this.store = store;
  }

  async init(): Promise<void> {
    await verifyWritableDirectory(this.config.stagingDir, 'STAGING_DIR');
    this.jobs = (await this.store.init()).map(redactJobForOutput);
  }

  listJobs(): Job[] {
    return this.jobs.map(redactJobForOutput);
  }

  getJob(id: string): Job | undefined {
    const job = this.jobs.find((j) => j.id === id);
    return job ? redactJobForOutput(job) : undefined;
  }

  private findJobInternal(id: string): Job | undefined {
    return this.jobs.find((j) => j.id === id);
  }

  async getDiskStatus(): Promise<DiskStatus> {
    await fs.mkdir(this.config.stagingDir, { recursive: true });
    const stats = await fs.statfs(this.config.stagingDir);
    const bsize = Number(stats.bsize);
    return {
      freeBytes: Number(stats.bavail) * bsize,
      totalBytes: Number(stats.blocks) * bsize,
    };
  }

  async enqueueJobs(req: CreateJobsRequest): Promise<Job[]> {
    const urls = (req.urls ?? []).map((u) => u.trim()).filter(Boolean);
    if (urls.length === 0) {
      throw new Error('At least one URL is required');
    }
    if (urls.length > 50) {
      throw new Error('Cannot queue more than 50 URLs in a single batch');
    }

    const folder = sanitizeFolderName(req.folder);
    const existingSub = sanitizeRelativePath(req.existingSubfolder);
    const newSub = sanitizeRelativePath(req.newSubfolder);
    const subfolder = [existingSub, newSub].filter(Boolean).join('/');
    const customFilename = sanitizeFilename(req.customFilename);

    if (urls.length > 1 && customFilename) {
      throw new Error('Custom filename cannot be used when queuing multiple URLs at once');
    }

    const rawHeaders = sanitizeHeaders(req.headers);
    const redactedHeaders = redactHeaders(rawHeaders);
    const mode = req.mode === 'direct' ? 'direct' : 'staged';
    if (mode === 'direct' && rawHeaders.length > 0) {
      throw new Error(
        'Custom HTTP headers are only supported in Staged mode (rclone copyurl applies --header globally to Google Drive API requests)',
      );
    }
    const autoExtract = mode === 'staged' ? Boolean(req.autoExtract) : false;
    const autoRefreshJellyfin = Boolean(req.autoRefreshJellyfin);

    // Validate all URLs (including SSRF DNS lookup) before accepting the batch.
    const validatedUrls: string[] = [];
    for (const rawUrl of urls) {
      const parsed = await validatePublicUrl(rawUrl);
      validatedUrls.push(parsed.toString());
    }

    const relDest = [folder, subfolder].filter(Boolean).join('/');
    const destinationRemote = `${this.config.rcloneRoot}/${relDest}`;
    const now = new Date().toISOString();

    const created: Job[] = validatedUrls.map((url) => {
      const id = crypto.randomUUID();
      if (rawHeaders.length > 0) {
        this.liveHeaders.set(id, rawHeaders);
      }
      return {
        id,
        url,
        folder,
        subfolder,
        destinationRemote,
        customFilename,
        resolvedFilename: customFilename || guessNameFromUrl(url),
        mode,
        autoExtract,
        autoRefreshJellyfin,
        headers: redactedHeaders,
        status: 'queued',
        phaseLabel: 'Queued',
        progress: defaultProgress(),
        logs: [`[${now}] Queued (${mode} mode) -> ${destinationRemote}`],
        createdAt: now,
      };
    });

    // Prepend newest jobs in reverse batch order so batch order matches visual order.
    this.jobs = trimJobHistory([...created.slice().reverse(), ...this.jobs]);
    await this.store.save(this.jobs);
    this.emit('jobs-changed', this.listJobs());
    this.pumpQueue();

    return created.map(redactJobForOutput);
  }

  async cancelJob(id: string): Promise<Job> {
    const job = this.findJobInternal(id);
    if (!job) throw new Error('Job not found');

    if (job.status === 'queued') {
      job.status = 'cancelled';
      job.phaseLabel = 'Cancelled';
      job.finishedAt = new Date().toISOString();
      this.liveHeaders.delete(id);
      this.appendLog(job, 'Cancelled while queued');
      await this.store.save(this.jobs);
      this.emitJob(job, true);
      return redactJobForOutput(job);
    }

    const controller = this.activeControllers.get(id);
    if (controller) {
      this.appendLog(job, 'Cancellation requested...');
      controller.abort();
      this.emitJob(job, true);
      return redactJobForOutput(job);
    }

    throw new Error(`Cannot cancel job in state "${job.status}"`);
  }

  async retryJob(id: string): Promise<Job> {
    const job = this.findJobInternal(id);
    if (!job) throw new Error('Job not found');
    if (this.activeControllers.has(id)) {
      throw new Error('Job is still running or cleaning up');
    }
    if (job.status !== 'failed' && job.status !== 'cancelled') {
      throw new Error('Only failed or cancelled jobs can be retried');
    }

    await validatePublicUrl(job.url);

    job.status = 'queued';
    job.phaseLabel = 'Queued';
    job.error = undefined;
    job.startedAt = undefined;
    job.finishedAt = undefined;
    job.progress = defaultProgress();
    this.appendLog(job, 'Retrying job...');
    await this.store.save(this.jobs);
    this.emitJob(job, true);
    this.pumpQueue();

    return redactJobForOutput(job);
  }

  private async removeJobStagingDirs(jobId: string): Promise<void> {
    const safeId = path.basename(jobId);
    if (!safeId || safeId === '.' || safeId === '..') return;
    const stagingRoot = path.resolve(this.config.stagingDir);
    const jobRootDir = path.resolve(stagingRoot, safeId);
    if (!jobRootDir.startsWith(stagingRoot + path.sep)) return;
    await fs.rm(jobRootDir, { recursive: true, force: true }).catch(() => {});
  }

  async deleteJob(id: string): Promise<void> {
    const job = this.findJobInternal(id);
    if (!job) throw new Error('Job not found');
    if (this.activeControllers.has(id) || job.status === 'queued') {
      throw new Error('Cancel the active or queued job before deleting it');
    }
    this.jobs = this.jobs.filter((j) => j.id !== id);
    this.liveHeaders.delete(id);
    await this.removeJobStagingDirs(id);
    await this.store.save(this.jobs);
    this.emit('jobs-changed', this.listJobs());
  }

  async clearFinished(): Promise<number> {
    const keepJob = (j: Job) => isActiveOrQueuedStatus(j.status) || this.activeControllers.has(j.id);
    const removedJobs = this.jobs.filter((j) => !keepJob(j));
    if (removedJobs.length > 0) {
      this.jobs = this.jobs.filter(keepJob);
      for (const removed of removedJobs) {
        this.liveHeaders.delete(removed.id);
      }
      await Promise.all(removedJobs.map((j) => this.removeJobStagingDirs(j.id)));
      await this.store.save(this.jobs);
      this.emit('jobs-changed', this.listJobs());
    }
    return removedJobs.length;
  }

  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    for (const controller of this.activeControllers.values()) {
      controller.abort();
    }
    if (this.activeRuns.size > 0) {
      const timeoutMs = 8000;
      let timer: NodeJS.Timeout | undefined;
      await Promise.race([
        Promise.allSettled(Array.from(this.activeRuns)),
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, timeoutMs);
          timer.unref();
        }),
      ]);
      if (timer) clearTimeout(timer);
    }
    await this.store.save(this.jobs);
  }

  private pumpQueue(): void {
    if (this.shuttingDown) return;
    while (this.activeControllers.size < this.config.maxConcurrentJobs) {
      // Pick oldest queued job (FIFO) that has not already been claimed.
      const next = [...this.jobs]
        .reverse()
        .find((j) => j.status === 'queued' && !this.activeControllers.has(j.id));
      if (!next) break;
      const controller = new AbortController();
      this.activeControllers.set(next.id, controller);
      next.status = next.mode === 'direct' ? 'uploading' : 'downloading';
      next.phaseLabel = 'Starting';
      this.emitJob(next, true);
      const runPromise = this.runJob(next, controller).finally(() => {
        this.activeRuns.delete(runPromise);
      });
      this.activeRuns.add(runPromise);
    }
  }

  private appendLog(job: Job, message: string): void {
    const stamp = new Date().toISOString().slice(11, 19);
    job.logs.push(`[${stamp}] ${message}`);
    if (job.logs.length > 100) {
      job.logs = job.logs.slice(-100);
    }
  }

  private emitJob(job: Job, force = false): void {
    const now = Date.now();
    const prev = this.lastEmitAt.get(job.id) ?? 0;
    if (!force && now - prev < 400) return;
    this.lastEmitAt.set(job.id, now);
    this.emit('job-update', redactJobForOutput(job));
  }

  private getExecutionHeaders(job: Job): CustomHeader[] {
    return this.liveHeaders.get(job.id) ?? job.headers.filter((h) => h.value !== REDACTED_VALUE);
  }

  private async runJob(job: Job, controller?: AbortController): Promise<void> {
    const activeController = controller ?? this.activeControllers.get(job.id) ?? new AbortController();
    this.activeControllers.set(job.id, activeController);
    const runId = crypto.randomUUID().slice(0, 8);
    const jobStagingRoot = path.join(this.config.stagingDir, job.id);
    const jobStagingDir = path.join(jobStagingRoot, runId);

    let outcome:
      | { status: 'completed' }
      | { status: 'cancelled' }
      | { status: 'failed'; error: string } = { status: 'failed', error: 'Transfer failed' };

    try {
      if (activeController.signal.aborted) {
        throw new Error('Cancelled');
      }
      job.startedAt = new Date().toISOString();

      if (job.mode === 'direct') {
        await this.executeDirectStream(job, activeController.signal);
      } else {
        await this.executeStagedTransfer(job, jobStagingDir, activeController.signal);
      }

      if (job.autoRefreshJellyfin) {
        const relDir = [job.folder, job.subfolder].filter(Boolean).join('/');
        const refresh = await refreshMediaTargets(this.config, relDir);
        for (const msg of refresh.messages) {
          this.appendLog(job, msg);
        }
      }

      outcome = { status: 'completed' };
    } catch (err) {
      const msg = (err as Error).message || 'Transfer failed';
      if (activeController.signal.aborted || msg === 'Cancelled') {
        outcome = { status: 'cancelled' };
      } else {
        outcome = { status: 'failed', error: msg };
      }
    } finally {
      if (job.mode === 'staged') {
        await fs.rm(jobStagingDir, { recursive: true, force: true }).catch(() => {});
        await fs.rmdir(jobStagingRoot).catch(() => {});
      }

      if (outcome.status === 'completed') {
        job.status = 'completed';
        job.phaseLabel = 'Completed';
        job.progress = {
          ...job.progress,
          percent: 100,
          speedBytesPerSec: 0,
          etaSeconds: 0,
        };
        job.finishedAt = new Date().toISOString();
        this.liveHeaders.delete(job.id);
        this.appendLog(job, `Completed -> ${job.destinationRemote}`);
      } else if (outcome.status === 'cancelled') {
        job.status = 'cancelled';
        job.phaseLabel = 'Cancelled';
        job.error = undefined;
        job.finishedAt = new Date().toISOString();
        this.liveHeaders.delete(job.id);
        this.appendLog(job, 'Job cancelled');
      } else {
        job.status = 'failed';
        job.phaseLabel = 'Failed';
        job.error = outcome.error;
        job.finishedAt = new Date().toISOString();
        this.appendLog(job, `ERROR: ${outcome.error}`);
      }

      this.activeControllers.delete(job.id);
      this.lastEmitAt.delete(job.id);
      const beforeCount = this.jobs.length;
      this.jobs = trimJobHistory(this.jobs);
      await this.store.save(this.jobs);
      this.emitJob(job, true);
      if (this.jobs.length !== beforeCount) {
        this.emit('jobs-changed', this.listJobs());
      }
      this.pumpQueue();
    }
  }

  private async executeDirectStream(job: Job, signal: AbortSignal): Promise<void> {
    job.status = 'uploading';
    job.phaseLabel = 'Direct streaming to Drive';
    const safeUrl = await resolveSafeUrl(job.url, {
      signal,
      proxyUrl: this.config.downloadProxy,
    });
    if (this.config.downloadProxy) {
      this.appendLog(job, `Using proxy: ${redactProxyUrl(this.config.downloadProxy)}`);
    }
    this.appendLog(job, `Starting rclone copyurl -> ${job.destinationRemote}`);
    this.emitJob(job, true);

    await runRcloneCopyUrl(
      this.config,
      {
        url: safeUrl,
        destRemoteDir: job.destinationRemote,
        customFilename: job.customFilename,
        headers: this.getExecutionHeaders(job),
        proxyUrl: this.config.downloadProxy,
      },
      {
        signal,
        onProgress: (progress, activeName) => {
          job.progress = progress;
          if (activeName) {
            job.resolvedFilename = activeName;
          }
          this.emitJob(job);
        },
        onLog: (line) => {
          this.appendLog(job, line);
          this.emitJob(job);
        },
      },
    );
  }

  private async executeStagedTransfer(
    job: Job,
    jobStagingDir: string,
    signal: AbortSignal,
  ): Promise<void> {
    if (signal.aborted) {
      throw new Error('Cancelled');
    }

    const disk = await this.getDiskStatus();
    if (signal.aborted) {
      throw new Error('Cancelled');
    }
    if (disk.freeBytes < this.config.minFreeDiskBytes) {
      const freeGb = (disk.freeBytes / GIB).toFixed(1);
      const minGb = (this.config.minFreeDiskBytes / GIB).toFixed(0);
      throw new Error(
        `Insufficient VPS disk space (${freeGb} GB free; minimum ${minGb} GB required)`,
      );
    }

    await fs.mkdir(jobStagingDir, { recursive: true });
    await fs.rm(path.join(jobStagingDir, 'extracted'), { recursive: true, force: true }).catch(() => {});
    if (signal.aborted) {
      throw new Error('Cancelled');
    }

    const executionHeaders = this.getExecutionHeaders(job);
    const safeUrl = await resolveSafeUrl(job.url, {
      headers: executionHeaders,
      signal,
      proxyUrl: this.config.downloadProxy,
    });

    job.status = 'downloading';
    job.phaseLabel = 'Downloading to VPS (aria2c 16x)';
    job.progress = defaultProgress();
    if (this.config.downloadProxy) {
      this.appendLog(job, `Using proxy: ${redactProxyUrl(this.config.downloadProxy)}`);
    }
    this.appendLog(job, 'Starting aria2c multi-connection download...');
    this.emitJob(job, true);

    await this.runAria2c(job, safeUrl, executionHeaders, jobStagingDir, signal);

    const downloadedEntries = (await fs.readdir(jobStagingDir)).filter(
      (name) => !name.endsWith('.aria2'),
    );
    if (downloadedEntries.length === 0) {
      throw new Error('aria2c finished but no file was found in staging directory');
    }

    const primaryFile = downloadedEntries[0];
    job.resolvedFilename = primaryFile;
    let uploadSourceDir = jobStagingDir;

    if (job.autoExtract && downloadedEntries.length === 1 && detectArchiveFormat(primaryFile)) {
      const archivePath = path.join(jobStagingDir, primaryFile);
      const extractDir = path.join(jobStagingDir, 'extracted');
      const postDownloadDisk = await this.getDiskStatus();

      job.status = 'extracting';
      job.phaseLabel = `Extracting ${primaryFile}`;
      job.progress = {
        percent: 0,
        bytesDone: 0,
        bytesTotal: 0,
        speedBytesPerSec: 0,
        etaSeconds: null,
      };
      this.appendLog(job, `Extracting archive: ${primaryFile}`);
      this.emitJob(job, true);

      await extractArchive(
        archivePath,
        extractDir,
        signal,
        (line) => {
          this.appendLog(job, `[extract] ${line}`);
          this.emitJob(job);
        },
        {
          maxExtractBytes: this.config.maxExtractBytes,
          freeDiskBytes: postDownloadDisk.freeBytes,
          minFreeDiskBytes: this.config.minFreeDiskBytes,
        },
      );

      await fs.unlink(archivePath);
      const extractedItems = await fs.readdir(extractDir);
      if (extractedItems.length === 0) {
        throw new Error('Archive extracted cleanly but contained no files');
      }

      this.appendLog(job, `Extracted ${extractedItems.length} top-level item(s)`);
      uploadSourceDir = extractDir;
    }

    job.status = 'uploading';
    job.phaseLabel = 'Uploading to Google Drive';
    job.progress = defaultProgress();
    this.appendLog(job, `Running rclone move -> ${job.destinationRemote}`);
    this.emitJob(job, true);

    await runRcloneMove(
      this.config,
      {
        localDir: uploadSourceDir,
        destRemoteDir: job.destinationRemote,
      },
      {
        signal,
        onProgress: (progress) => {
          job.progress = progress;
          this.emitJob(job);
        },
        onLog: (line) => {
          this.appendLog(job, line);
          this.emitJob(job);
        },
      },
    );

    await assertNoSkippedFiles(uploadSourceDir, job.destinationRemote);
  }

  private runAria2c(
    job: Job,
    downloadUrl: string,
    headers: CustomHeader[],
    stagingDir: string,
    signal: AbortSignal,
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      if (signal.aborted) {
        reject(new Error('Cancelled'));
        return;
      }

      const args = buildAria2Args(
        {
          url: downloadUrl,
          customFilename: job.customFilename,
          headers,
        },
        stagingDir,
        this.config.downloadProxy,
      );

      const child = spawn('aria2c', args, { stdio: ['ignore', 'pipe', 'pipe'] });
      const abortHandle = attachAbortKill(child, signal);
      let lastError = '';

      let buffer = '';
      const handleChunk = (chunk: Buffer) => {
        buffer += chunk.toString('utf8');
        const lines = buffer.split(/[\r\n]+/);
        buffer = lines.pop() ?? '';

        for (const raw of lines) {
          const line = raw.trim();
          if (!line) continue;

          const progress = parseAria2ProgressLine(line);
          if (progress) {
            job.progress = progress;
            this.emitJob(job);
            continue;
          }

          const completeMatch = line.match(/Download complete:\s+(.+)$/);
          if (completeMatch) {
            job.resolvedFilename = path.basename(completeMatch[1].trim());
            this.appendLog(job, `Downloaded ${job.resolvedFilename}`);
            this.emitJob(job, true);
            continue;
          }

          if (line.includes('[ERROR]') || line.includes('Exception')) {
            lastError = line;
            this.appendLog(job, `[aria2c] ${line}`);
            this.emitJob(job);
          }
        }
      };

      child.stdout.on('data', handleChunk);
      child.stderr.on('data', handleChunk);

      child.on('error', (err) => {
        abortHandle.cleanup();
        reject(err);
      });

      child.on('close', (code) => {
        abortHandle.cleanup();
        if (abortHandle.wasAborted() || signal.aborted) {
          reject(new Error('Cancelled'));
          return;
        }
        if (code === 0) {
          resolve();
        } else {
          reject(new Error(lastError || `aria2c exited with code ${code ?? 'unknown'}`));
        }
      });
    });
  }
}
