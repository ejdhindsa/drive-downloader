import { spawn } from 'node:child_process';
import { constants as fsConstants } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  DEFAULT_MAX_COMPRESSION_RATIO,
  DEFAULT_MAX_EXTRACT_BYTES,
  GIB,
  MIB,
  RATIO_CHECK_MIN_BYTES,
} from '../consts';
import { attachAbortKill } from '../utils/process';

export type ArchiveFormat = 'zip' | '7z' | 'rar' | 'tar';

export interface ArchiveEntryInfo {
  path: string;
  sizeBytes: number;
}

export interface ArchiveExtractionLimits {
  maxExtractBytes: number;
  freeDiskBytes?: number;
  minFreeDiskBytes?: number;
  maxCompressionRatio?: number;
  password?: string;
}

export function sanitizeArchivePassword(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  if (/[\r\n\0]/.test(raw) || raw.length > 512) {
    throw new Error('Archive password contains invalid control characters or exceeds 512 characters');
  }
  return raw;
}

export function detectArchiveFormat(filename: string): ArchiveFormat | null {
  const lower = filename.toLowerCase();
  if (lower.endsWith('.zip')) return 'zip';
  if (lower.endsWith('.7z')) return '7z';
  if (lower.endsWith('.rar')) return 'rar';
  if (
    lower.endsWith('.tar') ||
    lower.endsWith('.tar.gz') ||
    lower.endsWith('.tgz') ||
    lower.endsWith('.tar.bz2') ||
    lower.endsWith('.tbz2') ||
    lower.endsWith('.tar.xz') ||
    lower.endsWith('.txz')
  ) {
    return 'tar';
  }
  return null;
}

export async function resolveBinary(
  candidates: string[],
  pathEnv = process.env.PATH || '',
): Promise<string> {
  const dirs = pathEnv.split(path.delimiter).filter(Boolean);
  for (const candidate of candidates) {
    for (const dir of dirs) {
      const fullPath = path.join(dir, candidate);
      try {
        const st = await fs.stat(fullPath);
        if (!st.isFile()) continue;
        await fs.access(fullPath, fsConstants.X_OK);
        return fullPath;
      } catch {
        continue;
      }
    }
  }
  throw new Error(
    `Required archive tool not found in PATH (tried: ${candidates.join(', ')}). Ensure 7zip/extraction binaries are installed.`,
  );
}

export async function resolve7zBinary(pathEnv = process.env.PATH || ''): Promise<string> {
  return resolveBinary(['7zz', '7z'], pathEnv);
}

function runCommand(
  cmd: string,
  args: string[],
  signal: AbortSignal,
  onLog: (line: string) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error('Cancelled'));
      return;
    }

    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const abortHandle = attachAbortKill(child, signal);

    const handleChunk = (data: Buffer) => {
      const lines = data.toString('utf8').split(/\r?\n/).filter(Boolean);
      for (const line of lines.slice(-5)) {
        onLog(line);
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
        reject(new Error(`${cmd} exited with code ${code ?? 'unknown'}`));
      }
    });
  });
}

function runCommandCapture(
  cmd: string,
  args: string[],
  signal: AbortSignal,
  maxBytes = 8 * MIB,
): Promise<string> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error('Cancelled'));
      return;
    }

    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const abortHandle = attachAbortKill(child, signal);
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let stdoutBytes = 0;
    let overflowed = false;

    child.stdout.on('data', (chunk: Buffer) => {
      stdoutBytes += chunk.byteLength;
      if (stdoutBytes > maxBytes) {
        overflowed = true;
        child.kill('SIGKILL');
        return;
      }
      stdoutChunks.push(chunk);
    });

    child.stderr.on('data', (chunk: Buffer) => {
      if (stderrChunks.length < 32) {
        stderrChunks.push(chunk);
      }
    });

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
      if (overflowed) {
        reject(new Error(`Archive listing exceeded ${maxBytes} bytes (too many entries)`));
        return;
      }
      if (code === 0) {
        resolve(Buffer.concat(stdoutChunks).toString('utf8'));
      } else {
        const errTail = Buffer.concat(stderrChunks).toString('utf8').trim();
        reject(new Error(errTail || `${cmd} exited with code ${code ?? 'unknown'}`));
      }
    });
  });
}

export function parse7zListing(output: string): ArchiveEntryInfo[] {
  const markerIndex = output.indexOf('----------');
  if (markerIndex === -1) return [];

  const body = output.slice(markerIndex + '----------'.length);
  const blocks = body.split(/\r?\n\r?\n/);
  const entries: ArchiveEntryInfo[] = [];

  for (const block of blocks) {
    let entryPath = '';
    let sizeBytes = 0;

    for (const rawLine of block.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (line.startsWith('Path = ')) {
        entryPath = line.slice('Path = '.length);
      } else if (line.startsWith('Size = ')) {
        const parsed = Number.parseInt(line.slice('Size = '.length), 10);
        if (Number.isFinite(parsed) && parsed >= 0) {
          sizeBytes = parsed;
        }
      }
    }

    if (entryPath) {
      entries.push({ path: entryPath, sizeBytes });
    }
  }

  return entries;
}

export function parseUnzipListing(output: string): ArchiveEntryInfo[] {
  const entries: ArchiveEntryInfo[] = [];
  const lineRegex = /^\s*(\d+)\s+\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}\s+(.+)$/;
  const altDateRegex = /^\s*(\d+)\s+\d{2}-\d{2}-\d{4}\s+\d{2}:\d{2}\s+(.+)$/;

  for (const rawLine of output.split(/\r?\n/)) {
    const match = rawLine.match(lineRegex) ?? rawLine.match(altDateRegex);
    if (!match) continue;
    const sizeBytes = Number.parseInt(match[1], 10);
    const entryPath = match[2].trim();
    if (Number.isFinite(sizeBytes) && entryPath) {
      entries.push({ path: entryPath, sizeBytes });
    }
  }

  return entries;
}

export function parseTarListing(output: string): ArchiveEntryInfo[] {
  const entries: ArchiveEntryInfo[] = [];
  // Matches both GNU/BusyBox (`perms owner/group size YYYY-MM-DD HH:MM path`)
  // and BSD (`perms links owner group size Mon DD HH:MM path`).
  const gnuRegex = /^[bcdlps-][rwxstST-]{9}\S*\s+\S+\s+(\d+)\s+\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}(?::\d{2})?\s+(.+)$/;
  const bsdRegex = /^[bcdlps-][rwxstST-]{9}\S*\s+\d+\s+\S+\s+\S+\s+(\d+)\s+[A-Za-z]{3}\s+\d{1,2}\s+(?:\d{2}:\d{2}|\d{4})\s+(.+)$/;

  for (const rawLine of output.split(/\r?\n/)) {
    const match = rawLine.match(gnuRegex) ?? rawLine.match(bsdRegex);
    if (!match) continue;
    const sizeBytes = Number.parseInt(match[1], 10);
    const entryPath = match[2].split(' -> ')[0].trim();
    if (Number.isFinite(sizeBytes) && entryPath) {
      entries.push({ path: entryPath, sizeBytes });
    }
  }

  return entries;
}

function isUnsafeArchiveEntryPath(entryPath: string): boolean {
  if (!entryPath) return false;
  if (entryPath.includes('\0')) return true;
  if (entryPath.startsWith('/') || entryPath.startsWith('\\')) return true;
  if (/^[A-Za-z]:/.test(entryPath)) return true;

  const segments = entryPath.split(/[/\\]+/);
  return segments.some((seg) => seg === '..');
}

export function validateArchivePreflight(opts: {
  entries: ArchiveEntryInfo[];
  archiveSizeBytes: number;
  limits: ArchiveExtractionLimits;
}): { totalUncompressedBytes: number; entryCount: number } {
  let totalUncompressedBytes = 0;

  for (const entry of opts.entries) {
    if (isUnsafeArchiveEntryPath(entry.path)) {
      throw new Error(`Archive contains unsafe entry path: "${entry.path}"`);
    }
    totalUncompressedBytes += Math.max(0, entry.sizeBytes);
  }

  // Check real available disk headroom before the static ceiling so tight disks report accurately.
  if (opts.limits.freeDiskBytes !== undefined) {
    const reserve = opts.limits.minFreeDiskBytes ?? 0;
    const availableForExtract = Math.max(0, opts.limits.freeDiskBytes - reserve);
    if (totalUncompressedBytes > availableForExtract) {
      const needGb = (totalUncompressedBytes / GIB).toFixed(2);
      const availGb = (availableForExtract / GIB).toFixed(2);
      throw new Error(
        `Insufficient disk space to extract archive (needs ${needGb} GB, only ${availGb} GB available above reserve)`,
      );
    }
  }

  const maxExtractBytes = opts.limits.maxExtractBytes;
  if (totalUncompressedBytes > maxExtractBytes) {
    const totalGb = (totalUncompressedBytes / GIB).toFixed(2);
    const capGb = (maxExtractBytes / GIB).toFixed(1);
    throw new Error(
      `Archive uncompressed size (${totalGb} GB) exceeds maximum allowed limit (${capGb} GB)`,
    );
  }

  const maxRatio = opts.limits.maxCompressionRatio ?? DEFAULT_MAX_COMPRESSION_RATIO;
  if (
    opts.archiveSizeBytes > 0 &&
    totalUncompressedBytes > RATIO_CHECK_MIN_BYTES &&
    totalUncompressedBytes / opts.archiveSizeBytes > maxRatio
  ) {
    const ratio = Math.round(totalUncompressedBytes / opts.archiveSizeBytes);
    throw new Error(
      `Refusing to extract suspected archive bomb (compression ratio ${ratio}:1 exceeds ${maxRatio}:1 limit)`,
    );
  }

  return {
    totalUncompressedBytes,
    entryCount: opts.entries.length,
  };
}

async function inspectArchiveEntries(
  archivePath: string,
  format: ArchiveFormat,
  signal: AbortSignal,
  password?: string,
): Promise<ArchiveEntryInfo[]> {
  const pwArgs = password ? [`-p${password}`] : [];

  if (format === 'tar') {
    const output = await runCommandCapture('tar', ['-tvf', archivePath], signal);
    return parseTarListing(output);
  }

  if (format === 'zip') {
    try {
      const bin7z = await resolve7zBinary();
      const output = await runCommandCapture(bin7z, ['l', '-slt', ...pwArgs, archivePath], signal);
      return parse7zListing(output);
    } catch (err) {
      if (signal.aborted || password) throw err;
      const output = await runCommandCapture('unzip', ['-l', archivePath], signal);
      return parseUnzipListing(output);
    }
  }

  if (format === 'rar') {
    if (!password) {
      try {
        const output = await runCommandCapture('bsdtar', ['-tvf', archivePath], signal);
        return parseTarListing(output);
      } catch (err) {
        if (signal.aborted) throw err;
      }
    }
    const bin7z = await resolve7zBinary();
    const output = await runCommandCapture(bin7z, ['l', '-slt', ...pwArgs, archivePath], signal);
    return parse7zListing(output);
  }

  const bin7z = await resolve7zBinary();
  const output = await runCommandCapture(bin7z, ['l', '-slt', ...pwArgs, archivePath], signal);
  return parse7zListing(output);
}

export async function sanitizeExtractedTree(
  rootDir: string,
  onLog: (line: string) => void,
): Promise<void> {
  const resolvedRoot = path.resolve(rootDir);
  await fs.chmod(resolvedRoot, 0o755);

  async function walk(currentDir: string): Promise<void> {
    const entries = await fs.readdir(currentDir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(currentDir, entry.name);
      const resolvedPath = path.resolve(fullPath);

      if (!resolvedPath.startsWith(resolvedRoot + path.sep)) {
        await fs.rm(fullPath, { recursive: true, force: true });
        onLog(`Removed unsafe path outside extraction dir: ${entry.name}`);
        continue;
      }

      const st = await fs.lstat(fullPath);
      if (st.isDirectory()) {
        await fs.chmod(fullPath, 0o755);
        await walk(fullPath);
      } else if (st.isFile()) {
        const targetMode = (st.mode & 0o777) | 0o600;
        if ((st.mode & 0o7777) !== targetMode) {
          await fs.chmod(fullPath, targetMode);
        }
      } else {
        await fs.rm(fullPath, { recursive: true, force: true });
        if (st.isSymbolicLink()) {
          onLog(`Removed symlink from extracted archive: ${entry.name}`);
        } else {
          onLog(`Removed special file from extracted archive: ${entry.name}`);
        }
      }
    }
  }

  await walk(resolvedRoot);
}

export async function extractArchive(
  archivePath: string,
  destDir: string,
  signal: AbortSignal,
  onLog: (line: string) => void,
  limits: ArchiveExtractionLimits = { maxExtractBytes: DEFAULT_MAX_EXTRACT_BYTES },
): Promise<void> {
  const format = detectArchiveFormat(archivePath);
  if (!format) {
    throw new Error(`Unsupported archive format: ${path.basename(archivePath)}`);
  }

  const password = sanitizeArchivePassword(limits.password);
  const stat = await fs.stat(archivePath);
  const entries = await inspectArchiveEntries(archivePath, format, signal, password);
  const preflight = validateArchivePreflight({
    entries,
    archiveSizeBytes: stat.size,
    limits,
  });
  onLog(
    `Preflight passed: ${preflight.entryCount} entry(s), ${(preflight.totalUncompressedBytes / MIB).toFixed(1)} MB uncompressed`,
  );

  await fs.mkdir(destDir, { recursive: true });
  const pwArgs = password ? [`-p${password}`] : [];

  if (format === 'zip') {
    if (password) {
      // 7zz handles both ZipCrypto and AES-256 encrypted zip archives.
      const bin7z = await resolve7zBinary();
      await runCommand(bin7z, ['x', '-y', ...pwArgs, `-o${destDir}`, archivePath], signal, onLog);
    } else {
      await runCommand('unzip', ['-q', '-o', archivePath, '-d', destDir], signal, onLog);
    }
  } else if (format === 'tar') {
    await runCommand('tar', ['-xf', archivePath, '-C', destDir], signal, onLog);
  } else if (format === '7z') {
    const bin7z = await resolve7zBinary();
    await runCommand(bin7z, ['x', '-y', ...pwArgs, `-o${destDir}`, archivePath], signal, onLog);
  } else if (format === 'rar') {
    if (password) {
      const bin7z = await resolve7zBinary();
      await runCommand(bin7z, ['x', '-y', ...pwArgs, `-o${destDir}`, archivePath], signal, onLog);
    } else {
      try {
        await runCommand('bsdtar', ['-xf', archivePath, '-C', destDir], signal, onLog);
      } catch (err) {
        if (signal.aborted) throw err;
        onLog('bsdtar failed on .rar, trying 7z...');
        const bin7z = await resolve7zBinary();
        await runCommand(bin7z, ['x', '-y', `-o${destDir}`, archivePath], signal, onLog);
      }
    }
  }

  await sanitizeExtractedTree(destDir, onLog);
}
