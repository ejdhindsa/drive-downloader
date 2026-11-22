import { describe, expect, it } from 'vitest';
import {
  computeCpuPercent,
  extractRcloneRemote,
  parseLinuxMeminfo,
  parseRcloneAboutJson,
} from './system-stats';

describe('system stats helpers', () => {
  it('computes CPU utilization percentage from two tick snapshots', () => {
    expect(computeCpuPercent({ idle: 100, total: 200 }, { idle: 125, total: 300 })).toBe(75);
    expect(computeCpuPercent({ idle: 100, total: 200 }, { idle: 200, total: 300 })).toBe(0);
    expect(computeCpuPercent({ idle: 100, total: 200 }, { idle: 100, total: 200 })).toBe(0);
  });

  it('parses Linux /proc/meminfo using MemAvailable rather than MemFree', () => {
    const sample = [
      'MemTotal:        8000000 kB',
      'MemFree:          500000 kB',
      'MemAvailable:    6000000 kB',
    ].join('\n');

    expect(parseLinuxMeminfo(sample)).toEqual({
      totalBytes: 8_000_000 * 1024,
      usedBytes: 2_000_000 * 1024,
      usedPercent: 25,
    });
    expect(parseLinuxMeminfo('invalid')).toBeNull();
  });

  it('extracts rclone remote prefix and parses rclone about JSON', () => {
    expect(extractRcloneRemote('gdrive:Media')).toBe('gdrive:');
    expect(extractRcloneRemote('crypt-media:Movies/4K')).toBe('crypt-media:');
    expect(extractRcloneRemote('/local/path')).toBe('');

    const json = JSON.stringify({
      total: 2_000_000_000_000,
      used: 500_000_000_000,
      free: 1_500_000_000_000,
    });
    expect(parseRcloneAboutJson(json)).toEqual({
      totalBytes: 2_000_000_000_000,
      usedBytes: 500_000_000_000,
      freeBytes: 1_500_000_000_000,
    });
    expect(parseRcloneAboutJson('{}')).toBeNull();
    expect(parseRcloneAboutJson('not-json')).toBeNull();
  });
});
