import path from 'node:path';
import {
  DEFAULT_MAX_CONCURRENT_JOBS,
  DEFAULT_MAX_EXTRACT_SIZE_GB,
  DEFAULT_MIN_FREE_DISK_GB,
  GIB,
  MAX_CONCURRENT_JOBS_CAP,
} from './consts';
import { validateProxyUrl } from './utils/security';

export interface AppConfig {
  port: number;
  host: string;
  rcloneRoot: string;
  rcloneConfig: string;
  stagingDir: string;
  dataDir: string;
  maxConcurrentJobs: number;
  minFreeDiskBytes: number;
  maxExtractBytes: number;
  downloadProxy: string;
  jellyfinUrl: string;
  jellyfinApiKey: string;
  rcloneRcUrl: string;
}

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function loadConfig(): AppConfig {
  const minFreeGb = parsePositiveInt(process.env.MIN_FREE_DISK_GB, DEFAULT_MIN_FREE_DISK_GB);
  const maxExtractGb = parsePositiveInt(
    process.env.MAX_EXTRACT_SIZE_GB,
    DEFAULT_MAX_EXTRACT_SIZE_GB,
  );

  return {
    port: parsePositiveInt(process.env.PORT, 3000),
    host: process.env.HOST?.trim() || '0.0.0.0',
    rcloneRoot: (process.env.RCLONE_ROOT?.trim() || 'gdrive:Media').replace(/\/+$/, ''),
    rcloneConfig: process.env.RCLONE_CONFIG?.trim() || '/config/rclone/rclone.conf',
    stagingDir: path.resolve(process.env.STAGING_DIR?.trim() || '/tmp/staging'),
    dataDir: path.resolve(process.env.DATA_DIR?.trim() || '/app/data'),
    maxConcurrentJobs: Math.min(
      parsePositiveInt(process.env.MAX_CONCURRENT_JOBS, DEFAULT_MAX_CONCURRENT_JOBS),
      MAX_CONCURRENT_JOBS_CAP,
    ),
    minFreeDiskBytes: minFreeGb * GIB,
    maxExtractBytes: maxExtractGb * GIB,
    downloadProxy: validateProxyUrl(process.env.DOWNLOAD_PROXY),
    jellyfinUrl: (process.env.JELLYFIN_URL?.trim() || '').replace(/\/+$/, ''),
    jellyfinApiKey: process.env.JELLYFIN_API_KEY?.trim() || '',
    rcloneRcUrl: (process.env.RCLONE_RC_URL?.trim() || '').replace(/\/+$/, ''),
  };
}
