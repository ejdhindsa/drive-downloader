import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import {
  detectArchiveFormat,
  groupMultipartUrls,
  parse7zListing,
  parseTarListing,
  parseUnzipListing,
  pickEntryArchiveFile,
  resolve7zBinary,
  sanitizeArchivePassword,
  sanitizeExtractedTree,
  validateArchivePreflight,
} from './extractor';

const execFileAsync = promisify(execFile);

describe('archive detection and binary resolution', () => {
  it('identifies supported archive extensions', () => {
    expect(detectArchiveFormat('Season.01.zip')).toBe('zip');
    expect(detectArchiveFormat('pack.7z')).toBe('7z');
    expect(detectArchiveFormat('pack.rar')).toBe('rar');
    expect(detectArchiveFormat('pack.tar.gz')).toBe('tar');
    expect(detectArchiveFormat('pack.TGZ')).toBe('tar');
    expect(detectArchiveFormat('Movie.mkv')).toBeNull();
  });

  it('validates optional archive passwords against control characters', () => {
    expect(sanitizeArchivePassword(undefined)).toBeUndefined();
    expect(sanitizeArchivePassword('')).toBeUndefined();
    expect(sanitizeArchivePassword('s3cr3t!pass')).toBe('s3cr3t!pass');
    expect(() => sanitizeArchivePassword('bad\npass')).toThrow(/invalid control characters/);
    expect(() => sanitizeArchivePassword('bad\0pass')).toThrow(/invalid control characters/);
  });

  it('groups multi-part archive URLs and orders parts numerically', () => {
    const groups = groupMultipartUrls([
      'https://cdn.example.com/Show.S01.part2.rar',
      'https://cdn.example.com/standalone.mkv',
      'https://cdn.example.com/Show.S01.part1.rar',
      'https://cdn.example.com/Pack.7z.002',
      'https://cdn.example.com/Pack.7z.001',
      'https://cdn.example.com/Legacy.r00',
      'https://cdn.example.com/Legacy.rar',
      'https://cdn.example.com/Single.rar',
    ]);

    expect(groups).toEqual([
      {
        groupName: 'Show.S01.rar',
        urls: [
          'https://cdn.example.com/Show.S01.part1.rar',
          'https://cdn.example.com/Show.S01.part2.rar',
        ],
      },
      { urls: ['https://cdn.example.com/standalone.mkv'] },
      {
        groupName: 'Pack.7z',
        urls: [
          'https://cdn.example.com/Pack.7z.001',
          'https://cdn.example.com/Pack.7z.002',
        ],
      },
      {
        groupName: 'Legacy.rar',
        urls: [
          'https://cdn.example.com/Legacy.rar',
          'https://cdn.example.com/Legacy.r00',
        ],
      },
      { urls: ['https://cdn.example.com/Single.rar'] },
    ]);
  });

  it('picks the first volume as the extraction entry file', () => {
    expect(pickEntryArchiveFile(['Show.part02.rar', 'Show.part01.rar', 'Show.part03.rar'])).toBe(
      'Show.part01.rar',
    );
    expect(pickEntryArchiveFile(['Pack.7z.003', 'Pack.7z.001', 'Pack.7z.002'])).toBe('Pack.7z.001');
    expect(pickEntryArchiveFile(['Old.r01', 'Old.r00', 'Old.rar'])).toBe('Old.rar');
    expect(pickEntryArchiveFile(['Split.z01', 'Split.zip'])).toBe('Split.zip');
    expect(detectArchiveFormat('Pack.7z.001')).toBe('7z');
    expect(detectArchiveFormat('Pack.zip.001')).toBe('zip');
  });

  it('resolves 7zz or 7z from PATH and throws clearly when missing', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'drive-dl-7z-'));
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

      expect(await resolve7zBinary(dir7zz)).toBe(bin7zz);
      expect(await resolve7zBinary(dir7z)).toBe(bin7z);
      expect(await resolve7zBinary(`${dirNonExec}${path.delimiter}${dir7z}`)).toBe(bin7z);

      await expect(resolve7zBinary(dirNonExec)).rejects.toThrow(
        /Required archive tool not found in PATH \(tried: 7zz, 7z\)/,
      );
      await expect(resolve7zBinary('')).rejects.toThrow(
        /Required archive tool not found in PATH \(tried: 7zz, 7z\)/,
      );
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });
});

describe('archive preflight parsing and safety checks', () => {
  it('parses 7zz -slt, unzip -l, and GNU/BSD tar -tvf listings', () => {
    const sevenZ = [
      '7-Zip (z) 24.08',
      '----------',
      'Path = Show/Episode 01.mkv',
      'Size = 524288000',
      'Packed Size = 520000000',
      '',
      'Path = Show/subtitles.srt',
      'Size = 42000',
    ].join('\n');
    expect(parse7zListing(sevenZ)).toEqual([
      { path: 'Show/Episode 01.mkv', sizeBytes: 524288000 },
      { path: 'Show/subtitles.srt', sizeBytes: 42000 },
    ]);

    const unzipOut = [
      'Archive:  pack.zip',
      '  Length      Date    Time    Name',
      '---------  ---------- -----   ----',
      '  1048576  2026-01-15 10:20   Movie/film.mkv',
      '     2048  2026-01-15 10:20   Movie/readme.txt',
      '---------                     -------',
      '  1050624                     2 files',
    ].join('\n');
    expect(parseUnzipListing(unzipOut)).toEqual([
      { path: 'Movie/film.mkv', sizeBytes: 1048576 },
      { path: 'Movie/readme.txt', sizeBytes: 2048 },
    ]);

    const tarOut = [
      '-rw-r--r-- 0/0       2097152 2026-02-01 12:00 Season 01/ep1.mkv',
      '-rw-r--r--  1 root   root    4096 Feb  1 12:00 Season 01/info.nfo',
    ].join('\n');
    expect(parseTarListing(tarOut)).toEqual([
      { path: 'Season 01/ep1.mkv', sizeBytes: 2097152 },
      { path: 'Season 01/info.nfo', sizeBytes: 4096 },
    ]);
  });

  it('rejects path traversal, oversized archives, low disk space, and zip bombs', () => {
    const gib = 1024 ** 3;

    expect(() =>
      validateArchivePreflight({
        entries: [{ path: '../escape.sh', sizeBytes: 100 }],
        archiveSizeBytes: 50,
        limits: { maxExtractBytes: 10 * gib },
      }),
    ).toThrow(/unsafe entry path/);

    expect(() =>
      validateArchivePreflight({
        entries: [{ path: '/etc/cron.d/pwn', sizeBytes: 100 }],
        archiveSizeBytes: 50,
        limits: { maxExtractBytes: 10 * gib },
      }),
    ).toThrow(/unsafe entry path/);

    expect(() =>
      validateArchivePreflight({
        entries: [{ path: 'C:\\Windows\\win.ini', sizeBytes: 100 }],
        archiveSizeBytes: 50,
        limits: { maxExtractBytes: 10 * gib },
      }),
    ).toThrow(/unsafe entry path/);

    expect(() =>
      validateArchivePreflight({
        entries: [{ path: 'huge.mkv', sizeBytes: 60 * gib }],
        archiveSizeBytes: 55 * gib,
        limits: { maxExtractBytes: 50 * gib },
      }),
    ).toThrow(/exceeds maximum allowed limit/);

    // Disk headroom check runs before the static cap, so 50 GB on a 49 GB free disk reports disk space first.
    expect(() =>
      validateArchivePreflight({
        entries: [{ path: 'movie.mkv', sizeBytes: 50 * gib }],
        archiveSizeBytes: 45 * gib,
        limits: {
          maxExtractBytes: 50 * gib,
          freeDiskBytes: 49 * gib,
          minFreeDiskBytes: 15 * gib,
        },
      }),
    ).toThrow(/Insufficient disk space to extract/);

    // 5 MB archive expanding to 5 GiB (~1024:1 ratio) triggers zip-bomb guard.
    expect(() =>
      validateArchivePreflight({
        entries: [{ path: 'zeros.bin', sizeBytes: 5 * gib }],
        archiveSizeBytes: 5 * 1024 * 1024,
        limits: { maxExtractBytes: 50 * gib },
      }),
    ).toThrow(/suspected archive bomb/);

    // Normal media archive passes cleanly.
    const ok = validateArchivePreflight({
      entries: [
        { path: 'Movie (2025)/Movie.mkv', sizeBytes: 4 * gib },
        { path: 'Movie (2025)/Movie.srt', sizeBytes: 80_000 },
      ],
      archiveSizeBytes: 3.9 * gib,
      limits: {
        maxExtractBytes: 50 * gib,
        freeDiskBytes: 40 * gib,
        minFreeDiskBytes: 15 * gib,
      },
    });
    expect(ok.entryCount).toBe(2);
    expect(ok.totalUncompressedBytes).toBe(4 * gib + 80_000);
  });
});

describe('sanitizeExtractedTree', () => {
  it('normalizes restrictive permissions and strips symlinks and FIFOs', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'drive-dl-sanitize-'));
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

      await fs.symlink('/etc/passwd', path.join(extractDir, 'bad-link'));
      await execFileAsync('mkfifo', [path.join(extractDir, 'bad-pipe')]);

      await fs.chmod(roDir, 0o555);
      await fs.chmod(zeroDir, 0o000);

      const logs: string[] = [];
      await sanitizeExtractedTree(extractDir, (line) => logs.push(line));

      const roDirStat = await fs.lstat(roDir);
      const zeroDirStat = await fs.lstat(zeroDir);
      const fileInRoStat = await fs.lstat(fileInRo);
      const fileInZeroStat = await fs.lstat(fileInZero);

      expect(roDirStat.mode & 0o777).toBe(0o755);
      expect(zeroDirStat.mode & 0o777).toBe(0o755);
      expect(fileInRoStat.mode & 0o600).toBe(0o600);
      expect(fileInZeroStat.mode & 0o600).toBe(0o600);

      await expect(fs.lstat(path.join(extractDir, 'bad-link'))).rejects.toThrow(/ENOENT/);
      await expect(fs.lstat(path.join(extractDir, 'bad-pipe'))).rejects.toThrow(/ENOENT/);
      expect(logs.some((l) => l.includes('symlink'))).toBe(true);
      expect(logs.some((l) => l.includes('special file'))).toBe(true);
    } finally {
      await fs.chmod(zeroDir, 0o755).catch(() => {});
      await fs.chmod(roDir, 0o755).catch(() => {});
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });
});
