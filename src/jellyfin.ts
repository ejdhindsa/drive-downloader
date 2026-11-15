import type { AppConfig } from './config';

export interface RefreshResult {
  rcloneRefreshed: boolean;
  jellyfinRefreshed: boolean;
  messages: string[];
}

export async function refreshMediaTargets(
  config: AppConfig,
  remoteRelativeDir?: string,
): Promise<RefreshResult> {
  const messages: string[] = [];
  let rcloneRefreshed = false;
  let jellyfinRefreshed = false;

  if (config.rcloneRcUrl) {
    try {
      const body: Record<string, unknown> = { recursive: true };
      if (remoteRelativeDir) {
        body.dir = remoteRelativeDir;
      }
      const res = await fetch(`${config.rcloneRcUrl}/vfs/refresh`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) {
        messages.push(`rclone RC refresh returned HTTP ${res.status}`);
      } else {
        rcloneRefreshed = true;
        messages.push('rclone VFS directory cache refreshed');
      }
    } catch (err) {
      messages.push(`rclone RC refresh failed: ${(err as Error).message}`);
    }
  }

  if (config.jellyfinUrl && config.jellyfinApiKey) {
    try {
      const res = await fetch(`${config.jellyfinUrl}/Library/Refresh`, {
        method: 'POST',
        headers: { 'X-Emby-Token': config.jellyfinApiKey },
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) {
        messages.push(`Jellyfin refresh returned HTTP ${res.status}`);
      } else {
        jellyfinRefreshed = true;
        messages.push('Jellyfin library scan triggered');
      }
    } catch (err) {
      messages.push(`Jellyfin refresh failed: ${(err as Error).message}`);
    }
  }

  return { rcloneRefreshed, jellyfinRefreshed, messages };
}
