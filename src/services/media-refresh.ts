import type { AppConfig } from '../config';
import { type DnsLookupFn, safeFetch } from '../utils/security';

export interface RefreshResult {
  rcloneRefreshed: boolean;
  jellyfinRefreshed: boolean;
  audiobookshelfRefreshed: boolean;
  webhookTriggered: boolean;
  messages: string[];
}

export interface MediaRefreshContext {
  remoteRelativeDir?: string;
  filename?: string;
  destinationRemote?: string;
}

export function hasAnyMediaRefreshTarget(config: AppConfig): boolean {
  return Boolean(
    config.rcloneRcUrl ||
      (config.jellyfinUrl && config.jellyfinApiKey) ||
      (config.audiobookshelfUrl && config.audiobookshelfApiKey) ||
      config.postUploadWebhookUrl,
  );
}

async function scanAudiobookshelfLibrary(
  baseUrl: string,
  apiKey: string,
  libraryId: string,
  fetchImpl: typeof fetch,
): Promise<boolean> {
  const res = await fetchImpl(`${baseUrl}/api/libraries/${encodeURIComponent(libraryId)}/scan`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}` },
    signal: AbortSignal.timeout(10_000),
  });
  await res.body?.cancel().catch(() => {});
  return res.ok;
}

export async function refreshMediaTargets(
  config: AppConfig,
  context?: string | MediaRefreshContext,
  opts?: { fetchFn?: typeof fetch; lookupFn?: DnsLookupFn },
): Promise<RefreshResult> {
  const ctx: MediaRefreshContext =
    typeof context === 'string' ? { remoteRelativeDir: context } : (context ?? {});
  const fetchImpl = opts?.fetchFn ?? fetch;

  const messages: string[] = [];
  let rcloneRefreshed = false;
  let jellyfinRefreshed = false;
  let audiobookshelfRefreshed = false;
  let webhookTriggered = false;

  if (config.rcloneRcUrl) {
    try {
      const body: Record<string, unknown> = { recursive: true };
      if (ctx.remoteRelativeDir) {
        body.dir = ctx.remoteRelativeDir;
      }
      const res = await fetchImpl(`${config.rcloneRcUrl}/vfs/refresh`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(10_000),
      });
      await res.body?.cancel().catch(() => {});
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
      const res = await fetchImpl(`${config.jellyfinUrl}/Library/Refresh`, {
        method: 'POST',
        headers: { 'X-Emby-Token': config.jellyfinApiKey },
        signal: AbortSignal.timeout(10_000),
      });
      await res.body?.cancel().catch(() => {});
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

  if (config.audiobookshelfUrl && config.audiobookshelfApiKey) {
    const absBase = config.audiobookshelfUrl.replace(/\/+$/, '');
    try {
      const explicitId = config.audiobookshelfLibraryId?.trim();
      if (explicitId) {
        const ok = await scanAudiobookshelfLibrary(
          absBase,
          config.audiobookshelfApiKey,
          explicitId,
          fetchImpl,
        );
        if (ok) {
          audiobookshelfRefreshed = true;
          messages.push(`Audiobookshelf library scan triggered (${explicitId})`);
        } else {
          messages.push(`Audiobookshelf scan returned error for library ${explicitId}`);
        }
      } else {
        const listRes = await fetchImpl(`${absBase}/api/libraries`, {
          method: 'GET',
          headers: { Authorization: `Bearer ${config.audiobookshelfApiKey}` },
          signal: AbortSignal.timeout(10_000),
        });
        if (!listRes.ok) {
          await listRes.body?.cancel().catch(() => {});
          messages.push(`Audiobookshelf library list returned HTTP ${listRes.status}`);
        } else {
          const data = (await listRes.json()) as {
            libraries?: Array<{ id?: string; name?: string }>;
          };
          const ids = (data.libraries ?? []).map((l) => l.id).filter((id): id is string => Boolean(id));
          if (ids.length === 0) {
            messages.push('Audiobookshelf has no libraries to scan');
          } else {
            let scannedCount = 0;
            for (const id of ids) {
              const ok = await scanAudiobookshelfLibrary(
                absBase,
                config.audiobookshelfApiKey,
                id,
                fetchImpl,
              );
              if (ok) scannedCount += 1;
            }
            if (scannedCount > 0) {
              audiobookshelfRefreshed = true;
              messages.push(`Audiobookshelf scanned ${scannedCount}/${ids.length} library(s)`);
            } else {
              messages.push('Audiobookshelf scan failed for all libraries');
            }
          }
        }
      }
    } catch (err) {
      messages.push(`Audiobookshelf refresh failed: ${(err as Error).message}`);
    }
  }

  if (config.postUploadWebhookUrl) {
    try {
      const { response } = await safeFetch(config.postUploadWebhookUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': 'drive-downloader/1.0',
        },
        body: JSON.stringify({
          event: 'upload.completed',
          remoteRelativeDir: ctx.remoteRelativeDir || '',
          destinationRemote: ctx.destinationRemote || '',
          filename: ctx.filename || '',
          timestamp: new Date().toISOString(),
        }),
        timeoutMs: 10_000,
        fetchFn: opts?.fetchFn,
        lookupFn: opts?.lookupFn,
      });
      await response.body?.cancel().catch(() => {});
      if (!response.ok) {
        messages.push(`Post-upload webhook returned HTTP ${response.status}`);
      } else {
        webhookTriggered = true;
        messages.push('Post-upload webhook triggered');
      }
    } catch (err) {
      messages.push(`Post-upload webhook failed: ${(err as Error).message}`);
    }
  }

  return {
    rcloneRefreshed,
    jellyfinRefreshed,
    audiobookshelfRefreshed,
    webhookTriggered,
    messages,
  };
}
