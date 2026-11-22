import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import { promisify } from 'node:util';
import type { AppConfig } from '../config';
import type { DriveQuotaStats, MemoryStats, SystemStats } from '../types';

const execFileAsync = promisify(execFile);

export interface CpuSnapshot {
  idle: number;
  total: number;
}

const DRIVE_QUOTA_TTL_MS = 5 * 60_000;
const DRIVE_QUOTA_MISS_TTL_MS = 60_000;

export function captureCpuSnapshot(cpus = os.cpus()): CpuSnapshot {
  let idle = 0;
  let total = 0;
  for (const cpu of cpus) {
    idle += cpu.times.idle;
    total += cpu.times.user + cpu.times.nice + cpu.times.sys + cpu.times.idle + cpu.times.irq;
  }
  return { idle, total };
}

export function computeCpuPercent(prev: CpuSnapshot, next: CpuSnapshot): number {
  const totalDelta = next.total - prev.total;
  const idleDelta = next.idle - prev.idle;
  if (totalDelta <= 0) return 0;
  const busy = Math.max(0, totalDelta - idleDelta);
  return Math.min(100, Math.round((busy / totalDelta) * 1000) / 10);
}

export function parseLinuxMeminfo(raw: string): MemoryStats | null {
  const totalMatch = raw.match(/^MemTotal:\s+(\d+)\s+kB$/m);
  const availMatch = raw.match(/^MemAvailable:\s+(\d+)\s+kB$/m);
  if (!totalMatch || !availMatch) return null;

  const totalBytes = Number.parseInt(totalMatch[1], 10) * 1024;
  const availBytes = Number.parseInt(availMatch[1], 10) * 1024;
  if (!Number.isFinite(totalBytes) || totalBytes <= 0 || !Number.isFinite(availBytes)) {
    return null;
  }

  const usedBytes = Math.max(0, totalBytes - availBytes);
  const usedPercent = Math.min(100, Math.round((usedBytes / totalBytes) * 1000) / 10);
  return { usedBytes, totalBytes, usedPercent };
}

export async function readMemoryStats(): Promise<MemoryStats> {
  try {
    const raw = await fs.readFile('/proc/meminfo', 'utf8');
    const parsed = parseLinuxMeminfo(raw);
    if (parsed) return parsed;
  } catch {
    // Non-Linux hosts fall back to os.totalmem/os.freemem below.
  }

  const totalBytes = os.totalmem();
  const freeBytes = os.freemem();
  const usedBytes = Math.max(0, totalBytes - freeBytes);
  const usedPercent = totalBytes > 0 ? Math.min(100, Math.round((usedBytes / totalBytes) * 1000) / 10) : 0;
  return { usedBytes, totalBytes, usedPercent };
}

export function extractRcloneRemote(rcloneRoot: string): string {
  const colonIdx = rcloneRoot.indexOf(':');
  return colonIdx > 0 ? `${rcloneRoot.slice(0, colonIdx)}:` : '';
}

export function parseRcloneAboutJson(raw: string): DriveQuotaStats | null {
  try {
    const parsed = JSON.parse(raw) as { total?: number; used?: number; free?: number };
    const totalBytes = typeof parsed.total === 'number' && parsed.total > 0 ? parsed.total : 0;
    const usedBytes = typeof parsed.used === 'number' && parsed.used >= 0 ? parsed.used : 0;
    const freeBytes =
      typeof parsed.free === 'number' && parsed.free >= 0
        ? parsed.free
        : Math.max(0, totalBytes - usedBytes);
    if (totalBytes <= 0) return null;
    return { usedBytes, freeBytes, totalBytes };
  } catch {
    return null;
  }
}

export class SystemStatsCollector {
  private readonly config: AppConfig;
  private prevCpu: CpuSnapshot;
  private quotaCache: { expiresAt: number; value: DriveQuotaStats | null } | null = null;

  constructor(config: AppConfig) {
    this.config = config;
    this.prevCpu = captureCpuSnapshot();
  }

  private async getDriveQuota(): Promise<DriveQuotaStats | null> {
    const now = Date.now();
    if (this.quotaCache && this.quotaCache.expiresAt > now) {
      return this.quotaCache.value;
    }

    const remote = extractRcloneRemote(this.config.rcloneRoot);
    if (!remote) {
      this.quotaCache = { expiresAt: now + DRIVE_QUOTA_MISS_TTL_MS, value: null };
      return null;
    }

    try {
      const { stdout } = await execFileAsync(
        'rclone',
        ['--config', this.config.rcloneConfig, 'about', remote, '--json'],
        { timeout: 10_000, maxBuffer: 512 * 1024 },
      );
      const parsed = parseRcloneAboutJson(stdout);
      this.quotaCache = {
        expiresAt: now + (parsed ? DRIVE_QUOTA_TTL_MS : DRIVE_QUOTA_MISS_TTL_MS),
        value: parsed,
      };
      return parsed;
    } catch {
      this.quotaCache = { expiresAt: now + DRIVE_QUOTA_MISS_TTL_MS, value: null };
      return null;
    }
  }

  async collect(disk: { freeBytes: number; totalBytes: number }): Promise<SystemStats> {
    const nextCpu = captureCpuSnapshot();
    const cpuPercent = computeCpuPercent(this.prevCpu, nextCpu);
    this.prevCpu = nextCpu;

    const cpus = os.cpus();
    const loadAvg1m = Math.round((os.loadavg()[0] ?? 0) * 100) / 100;
    const [memory, driveQuota] = await Promise.all([readMemoryStats(), this.getDriveQuota()]);

    const diskUsed = Math.max(0, disk.totalBytes - disk.freeBytes);
    const diskUsedPercent =
      disk.totalBytes > 0 ? Math.min(100, Math.round((diskUsed / disk.totalBytes) * 1000) / 10) : 0;

    return {
      cpu: {
        percent: cpuPercent,
        cores: cpus.length || 1,
        loadAvg1m,
      },
      memory,
      disk: {
        freeBytes: disk.freeBytes,
        totalBytes: disk.totalBytes,
        usedPercent: diskUsedPercent,
      },
      driveQuota,
    };
  }
}
