import { spawn } from 'node:child_process';
import { constants as fsConstants } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { attachAbortKill } from './process';

export type ArchiveFormat = 'zip' | '7z' | 'rar' | 'tar';

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

/**
 * Resolves the first executable binary from `candidates` found on `pathEnv`.
 * Throws a clear error if none are installed.
 */
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
        // Continue searching PATH
      }
    }
  }
  throw new Error(
    `Required archive tool not found in PATH (tried: ${candidates.join(', ')}). Ensure 7zip/extraction binaries are installed.`,
  );
}

/**
 * Resolves `7zz` (Alpine 7zip package) or `7z` from PATH.
 */
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

/**
 * Normalizes permissions on extracted files/directories and removes symlinks and
 * special files (FIFOs, sockets, device nodes) before upload.
 */
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
): Promise<void> {
  const format = detectArchiveFormat(archivePath);
  if (!format) {
    throw new Error(`Unsupported archive format: ${path.basename(archivePath)}`);
  }

  await fs.mkdir(destDir, { recursive: true });

  if (format === 'zip') {
    await runCommand('unzip', ['-q', '-o', archivePath, '-d', destDir], signal, onLog);
  } else if (format === 'tar') {
    await runCommand('tar', ['-xf', archivePath, '-C', destDir], signal, onLog);
  } else if (format === '7z') {
    const bin7z = await resolve7zBinary();
    await runCommand(bin7z, ['x', '-y', `-o${destDir}`, archivePath], signal, onLog);
  } else if (format === 'rar') {
    try {
      await runCommand('bsdtar', ['-xf', archivePath, '-C', destDir], signal, onLog);
    } catch (err) {
      if (signal.aborted) throw err;
      onLog('bsdtar failed on .rar, trying 7z...');
      const bin7z = await resolve7zBinary();
      await runCommand(bin7z, ['x', '-y', `-o${destDir}`, archivePath], signal, onLog);
    }
  }

  await sanitizeExtractedTree(destDir, onLog);
}
