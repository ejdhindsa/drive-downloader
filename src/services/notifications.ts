import type { AppConfig } from '../config';
import { DEFAULT_NOTIFY_INACTIVE_SECONDS } from '../consts';
import type { Job } from '../types';
import { type DnsLookupFn, safeFetch } from '../utils/security';

export class ClientPresenceTracker {
  private lastActiveAt = 0;

  markActive(now = Date.now()): void {
    this.lastActiveAt = now;
  }

  getLastActiveAt(): number {
    return this.lastActiveAt;
  }

  isClientRecentlyActive(inactiveSeconds: number, now = Date.now()): boolean {
    if (inactiveSeconds <= 0 || this.lastActiveAt <= 0) return false;
    return now - this.lastActiveAt < inactiveSeconds * 1000;
  }
}

export function hasConfiguredNotificationChannel(config: AppConfig): boolean {
  return Boolean(
    config.discordWebhookUrl ||
      config.ntfyUrl ||
      (config.telegramBotToken && config.telegramChatId),
  );
}

export interface NotificationDispatchResult {
  skippedReason?: 'no_channels' | 'client_active';
  sent: string[];
  errors: string[];
}

export async function dispatchJobNotification(
  config: AppConfig,
  event: {
    kind: 'completed' | 'failed';
    job: Pick<Job, 'id' | 'resolvedFilename' | 'destinationRemote' | 'error' | 'resolverName'>;
  },
  opts?: {
    presence?: ClientPresenceTracker;
    now?: number;
    fetchFn?: typeof fetch;
    lookupFn?: DnsLookupFn;
  },
): Promise<NotificationDispatchResult> {
  if (!hasConfiguredNotificationChannel(config)) {
    return { skippedReason: 'no_channels', sent: [], errors: [] };
  }

  const now = opts?.now ?? Date.now();
  const inactiveSeconds = config.notifyInactiveSeconds ?? DEFAULT_NOTIFY_INACTIVE_SECONDS;
  if (opts?.presence?.isClientRecentlyActive(inactiveSeconds, now)) {
    return { skippedReason: 'client_active', sent: [], errors: [] };
  }

  const isCompleted = event.kind === 'completed';
  const title = isCompleted ? 'Transfer Completed' : 'Transfer Failed';
  const itemName = event.job.resolvedFilename || 'Transfer';
  const summary = isCompleted
    ? `${itemName} uploaded to ${event.job.destinationRemote}`
    : `${itemName} failed: ${event.job.error || 'Transfer failed'}`;

  const tasks: Array<Promise<{ channel: string; ok: boolean; error?: string }>> = [];

  if (config.discordWebhookUrl) {
    const discordUrl = config.discordWebhookUrl;
    const fields = [
      { name: 'Destination', value: event.job.destinationRemote, inline: true },
      ...(event.job.resolverName
        ? [{ name: 'Source', value: event.job.resolverName, inline: true }]
        : []),
    ];
    const payload = {
      username: 'Drive Downloader',
      embeds: [
        {
          title,
          description: summary,
          color: isCompleted ? 0x22c55e : 0xef4444,
          fields,
          timestamp: new Date(now).toISOString(),
        },
      ],
    };

    tasks.push(
      (async () => {
        try {
          const { response } = await safeFetch(discordUrl, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'User-Agent': 'drive-downloader/1.0',
            },
            body: JSON.stringify(payload),
            timeoutMs: 10_000,
            fetchFn: opts?.fetchFn,
            lookupFn: opts?.lookupFn,
          });
          await response.body?.cancel().catch(() => {});
          return response.ok
            ? { channel: 'discord', ok: true }
            : { channel: 'discord', ok: false, error: `Discord returned HTTP ${response.status}` };
        } catch (err) {
          return {
            channel: 'discord',
            ok: false,
            error: `Discord error: ${(err as Error).message}`,
          };
        }
      })(),
    );
  }

  if (config.ntfyUrl) {
    const ntfyUrl = config.ntfyUrl;
    tasks.push(
      (async () => {
        try {
          const { response } = await safeFetch(ntfyUrl, {
            method: 'POST',
            headers: {
              Title: title,
              Priority: isCompleted ? 'default' : 'high',
              Tags: isCompleted ? 'white_check_mark' : 'warning',
              'User-Agent': 'drive-downloader/1.0',
            },
            body: summary,
            timeoutMs: 10_000,
            fetchFn: opts?.fetchFn,
            lookupFn: opts?.lookupFn,
          });
          await response.body?.cancel().catch(() => {});
          return response.ok
            ? { channel: 'ntfy', ok: true }
            : { channel: 'ntfy', ok: false, error: `ntfy returned HTTP ${response.status}` };
        } catch (err) {
          return { channel: 'ntfy', ok: false, error: `ntfy error: ${(err as Error).message}` };
        }
      })(),
    );
  }

  if (config.telegramBotToken && config.telegramChatId) {
    const botToken = config.telegramBotToken;
    const chatId = config.telegramChatId;
    const tgUrl = `https://api.telegram.org/bot${encodeURIComponent(botToken)}/sendMessage`;
    tasks.push(
      (async () => {
        try {
          const { response } = await safeFetch(tgUrl, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'User-Agent': 'drive-downloader/1.0',
            },
            body: JSON.stringify({
              chat_id: chatId,
              text: `${title}\n${summary}`,
            }),
            timeoutMs: 10_000,
            fetchFn: opts?.fetchFn,
            lookupFn: opts?.lookupFn,
          });
          await response.body?.cancel().catch(() => {});
          return response.ok
            ? { channel: 'telegram', ok: true }
            : { channel: 'telegram', ok: false, error: `Telegram returned HTTP ${response.status}` };
        } catch (err) {
          const rawMsg = (err as Error).message.replaceAll(botToken, '[REDACTED]');
          return { channel: 'telegram', ok: false, error: `Telegram error: ${rawMsg}` };
        }
      })(),
    );
  }

  const results = await Promise.all(tasks);
  const sent = results.filter((r) => r.ok).map((r) => r.channel);
  const errors = results.filter((r) => !r.ok && r.error).map((r) => r.error!);
  return { sent, errors };
}
