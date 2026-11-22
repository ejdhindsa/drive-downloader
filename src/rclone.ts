import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import type { AppConfig } from './config';
import { attachAbortKill } from './process';
import type { CustomHeader, JobProgress } from './types';

const execFileAsync = promisify(execFile);

interface CacheEntry {
  expiresAt: number;
  folders: string[];
}

const folderCache = new Map<string, CacheEntry>();
const CACHE_TTL_MS = 15_000;

export function clearFolderCache(): void {
  folderCache.clear();
}

export async function listDriveDirectories(
  config: AppConfig,
  relativePath: string,
  bypassCache = false,
): Promise<string[]> {
  const remoteTarget = relativePath
    ? `${config.rcloneRoot}/${relativePath}`
    : config.rcloneRoot;

  const now = Date.now();
  if (!bypassCache) {
    const cached = folderCache.get(remoteTarget);
    if (cached && cached.expiresAt > now) {
      return cached.folders;
    }
  }

  const { stdout } = await execFileAsync(
    'rclone',
    ['--config', config.rcloneConfig, 'lsf', '--dirs-only', '--format', 'p', remoteTarget],
    { timeout: 25_000, maxBuffer: 2 * 1024 * 1024 },
  );

  const folders = stdout
    .split(/\r?\n/)
    .map((line) => line.trim().replace(/\/+$/, ''))
    .filter(Boolean)
    .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));

  folderCache.set(remoteTarget, {
    expiresAt: now + CACHE_TTL_MS,
    folders,
  });

  return folders;
}

interface RcloneStatsTransfer {
  name?: string;
  size?: number;
  bytes?: number;
  percentage?: number;
  speed?: number;
  eta?: number;
}

interface RcloneLogEntry {
  level?: string;
  msg?: string;
  stats?: {
    bytes?: number;
    totalBytes?: number;
    speed?: number;
    eta?: number | null;
    transferring?: RcloneStatsTransfer[];
  };
}

export interface RcloneTransferCallbacks {
  signal: AbortSignal;
  onProgress: (progress: JobProgress, filename?: string) => void;
  onLog: (line: string) => void;
}

export function buildProxyEnv(
  proxyUrl: string | undefined,
  baseEnv: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv | undefined {
  if (!proxyUrl) return undefined;
  return {
    ...baseEnv,
    HTTP_PROXY: proxyUrl,
    HTTPS_PROXY: proxyUrl,
    http_proxy: proxyUrl,
    https_proxy: proxyUrl,
  };
}

function spawnRcloneWithStats(
  args: string[],
  callbacks: RcloneTransferCallbacks,
  env?: NodeJS.ProcessEnv,
): Promise<void> {
  return new Promise((resolve, reject) => {
    if (callbacks.signal.aborted) {
      reject(new Error('Cancelled'));
      return;
    }

    const child = spawn('rclone', args, { stdio: ['ignore', 'pipe', 'pipe'], env });
    const abortHandle = attachAbortKill(child, callbacks.signal);
    let lastErrorLine = '';

    let lineBuffer = '';
    const processChunk = (chunk: Buffer) => {
      lineBuffer += chunk.toString('utf8');
      const lines = lineBuffer.split(/\r?\n/);
      lineBuffer = lines.pop() ?? '';

      for (const rawLine of lines) {
        const line = rawLine.trim();
        if (!line) continue;

        if (line.startsWith('{')) {
          try {
            const parsed = JSON.parse(line) as RcloneLogEntry;
            if (parsed.stats) {
              const bytesDone = parsed.stats.bytes ?? 0;
              const bytesTotal = parsed.stats.totalBytes ?? 0;
              const speedBytesPerSec = parsed.stats.speed ?? 0;
              const etaSeconds =
                typeof parsed.stats.eta === 'number' && Number.isFinite(parsed.stats.eta)
                  ? Math.max(0, Math.round(parsed.stats.eta))
                  : null;
              const percent =
                bytesTotal > 0
                  ? Math.min(100, Math.round((bytesDone / bytesTotal) * 1000) / 10)
                  : 0;

              const activeName = parsed.stats.transferring?.[0]?.name;
              callbacks.onProgress(
                { percent, bytesDone, bytesTotal, speedBytesPerSec, etaSeconds },
                activeName,
              );
              continue;
            }
            if (parsed.msg) {
              const msg = parsed.msg.trim();
              if (parsed.level === 'error') {
                lastErrorLine = msg;
              }
              if (msg && msg !== 'Transferred:' && !msg.startsWith('Checks:')) {
                callbacks.onLog(`[rclone] ${msg}`);
              }
              continue;
            }
          } catch {
            // Fall through to plain-text logging
          }
        }

        lastErrorLine = line;
        callbacks.onLog(`[rclone] ${line}`);
      }
    };

    child.stdout.on('data', processChunk);
    child.stderr.on('data', processChunk);

    child.on('error', (err) => {
      abortHandle.cleanup();
      reject(err);
    });

    child.on('close', (code) => {
      abortHandle.cleanup();
      if (abortHandle.wasAborted() || callbacks.signal.aborted) {
        reject(new Error('Cancelled'));
        return;
      }
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(lastErrorLine || `rclone exited with code ${code ?? 'unknown'}`));
      }
    });
  });
}

export async function runRcloneCopyUrl(
  config: AppConfig,
  opts: {
    url: string;
    destRemoteDir: string;
    customFilename?: string;
    headers: CustomHeader[];
    proxyUrl?: string;
  },
  callbacks: RcloneTransferCallbacks,
): Promise<void> {
  if (opts.headers.length > 0) {
    throw new Error('Custom HTTP headers are only supported in Staged mode');
  }

  const args = ['--config', config.rcloneConfig, 'copyurl', opts.url];

  if (opts.customFilename) {
    args.push(`${opts.destRemoteDir}/${opts.customFilename}`);
  } else {
    args.push(`${opts.destRemoteDir}/`, '--auto-filename', '--header-filename');
  }

  args.push(
    '--no-clobber',
    '--drive-chunk-size',
    '64M',
    '--use-json-log',
    '--stats',
    '1s',
    '--stats-log-level',
    'NOTICE',
  );

  const proxyEnv = buildProxyEnv(opts.proxyUrl ?? config.downloadProxy);
  await spawnRcloneWithStats(args, callbacks, proxyEnv);
  clearFolderCache();
}

export async function listRemainingFiles(rootDir: string, currentDir = rootDir): Promise<string[]> {
  let entries;
  try {
    entries = await fs.readdir(currentDir, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') {
      return [];
    }
    throw err;
  }

  const remaining: string[] = [];
  for (const entry of entries) {
    const fullPath = path.join(currentDir, entry.name);
    if (entry.isDirectory()) {
      remaining.push(...(await listRemainingFiles(rootDir, fullPath)));
    } else if (entry.isFile() || entry.isSymbolicLink()) {
      remaining.push(path.relative(rootDir, fullPath));
    }
  }
  return remaining.sort();
}

export async function assertNoSkippedFiles(localDir: string, destRemoteDir: string): Promise<void> {
  const skippedFiles = await listRemainingFiles(localDir);
  if (skippedFiles.length > 0) {
    const preview = skippedFiles.slice(0, 5).join(', ');
    const more = skippedFiles.length > 5 ? ` (+${skippedFiles.length - 5} more)` : '';
    throw new Error(
      `Upload skipped ${skippedFiles.length} file(s) already existing at ${destRemoteDir}: ${preview}${more}`,
    );
  }
}

export async function runRcloneMove(
  config: AppConfig,
  opts: {
    localDir: string;
    destRemoteDir: string;
  },
  callbacks: RcloneTransferCallbacks,
): Promise<void> {
  const args = [
    '--config',
    config.rcloneConfig,
    'move',
    opts.localDir,
    opts.destRemoteDir,
    '--ignore-existing',
    '--delete-empty-src-dirs',
    '--no-traverse',
    '--transfers',
    '4',
    '--drive-chunk-size',
    '64M',
    '--use-json-log',
    '--stats',
    '1s',
    '--stats-log-level',
    'NOTICE',
  ];

  await spawnRcloneWithStats(args, callbacks);
  clearFolderCache();
}
