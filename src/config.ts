import path from 'node:path';

export interface AppConfig {
  port: number;
  host: string;
  rcloneRoot: string;
  rcloneConfig: string;
  stagingDir: string;
  dataDir: string;
  maxConcurrentJobs: number;
  minFreeDiskBytes: number;
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
  const minFreeGb = parsePositiveInt(process.env.MIN_FREE_DISK_GB, 15);
  return {
    port: parsePositiveInt(process.env.PORT, 3000),
    host: process.env.HOST?.trim() || '0.0.0.0',
    rcloneRoot: (process.env.RCLONE_ROOT?.trim() || 'gdrive:Media').replace(/\/+$/, ''),
    rcloneConfig: process.env.RCLONE_CONFIG?.trim() || '/config/rclone/rclone.conf',
    stagingDir: path.resolve(process.env.STAGING_DIR?.trim() || '/tmp/staging'),
    dataDir: path.resolve(process.env.DATA_DIR?.trim() || '/app/data'),
    maxConcurrentJobs: Math.min(parsePositiveInt(process.env.MAX_CONCURRENT_JOBS, 2), 6),
    minFreeDiskBytes: minFreeGb * 1024 * 1024 * 1024,
    jellyfinUrl: (process.env.JELLYFIN_URL?.trim() || '').replace(/\/+$/, ''),
    jellyfinApiKey: process.env.JELLYFIN_API_KEY?.trim() || '',
    rcloneRcUrl: (process.env.RCLONE_RC_URL?.trim() || '').replace(/\/+$/, ''),
  };
}
