import { fetchConfig, fetchJobs, fetchStats, sendPresenceHeartbeat } from '../api/client';
import type {
  AppConfigResponse,
  ConnectionState,
  Job,
  SystemStatsResponse,
} from '../api/types';

const NOTIFICATION_STORAGE_KEY = 'drive-downloader:browser-notifications';

function readInitialNotificationsEnabled(): boolean {
  try {
    return localStorage.getItem(NOTIFICATION_STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

function readNotificationPermission(): 'default' | 'granted' | 'denied' | 'unsupported' {
  if (typeof Notification === 'undefined') return 'unsupported';
  return Notification.permission;
}

function isActiveJob(job: Job): boolean {
  return (
    job.status === 'queued' ||
    job.status === 'paused' ||
    job.status === 'resolving' ||
    job.status === 'downloading' ||
    job.status === 'extracting' ||
    job.status === 'uploading'
  );
}

class TransferStore {
  config = $state<AppConfigResponse | null>(null);
  stats = $state<SystemStatsResponse | null>(null);
  jobs = $state<Job[]>([]);
  connectionState = $state<ConnectionState>('connecting');
  notificationsEnabled = $state<boolean>(readInitialNotificationsEnabled());
  notificationPermission = $state<'default' | 'granted' | 'denied' | 'unsupported'>(
    readNotificationPermission(),
  );

  activeJobs = $derived(this.jobs.filter(isActiveJob));
  activeCount = $derived(this.activeJobs.length);

  downloadSpeedBytesPerSec = $derived(
    this.activeJobs.reduce(
      (sum, job) => sum + (job.status === 'downloading' ? (job.progress?.speedBytesPerSec ?? 0) : 0),
      0,
    ),
  );

  uploadSpeedBytesPerSec = $derived(
    this.activeJobs.reduce(
      (sum, job) => sum + (job.status === 'uploading' ? (job.progress?.speedBytesPerSec ?? 0) : 0),
      0,
    ),
  );

  hasMediaRefresh = $derived(
    Boolean(
      this.config?.jellyfinConfigured ||
        this.config?.rcloneRcConfigured ||
        this.config?.audiobookshelfConfigured ||
        this.config?.postUploadWebhookConfigured,
    ),
  );

  tabTitle = $derived.by(() => {
    if (this.activeCount === 0) return 'Drive Downloader';
    const running = this.activeJobs.filter(
      (j) =>
        (j.status === 'downloading' || j.status === 'uploading' || j.status === 'extracting') &&
        typeof j.progress?.percent === 'number',
    );
    if (running.length > 0) {
      const avg =
        running.reduce((sum, j) => sum + (j.progress?.percent ?? 0), 0) / running.length;
      if (avg > 0) {
        return `(${this.activeCount}) ${Math.round(avg)}% — Drive Downloader`;
      }
    }
    return `(${this.activeCount}) Active — Drive Downloader`;
  });

  private eventSource: EventSource | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private configTimer: ReturnType<typeof setInterval> | null = null;
  private statsTimer: ReturnType<typeof setInterval> | null = null;
  private presenceTimer: ReturnType<typeof setInterval> | null = null;
  private telemetryOpen = false;
  private lastActiveAt = Date.now();
  private lastHeartbeatAt = 0;

  async refreshConfig() {
    try {
      this.config = await fetchConfig();
    } catch {
      // Keep last known config snapshot during transient network blips.
    }
  }

  async refreshStats() {
    try {
      this.stats = await fetchStats();
    } catch {
      // Keep last known stats snapshot during transient network blips.
    }
  }

  setTelemetryOpen(open: boolean) {
    this.telemetryOpen = open;
    if (open) {
      void this.refreshStats();
    }
    this.rescheduleStatsTimer();
  }

  async toggleBrowserNotifications(): Promise<'enabled' | 'disabled' | 'denied' | 'unsupported'> {
    if (typeof Notification === 'undefined') {
      this.notificationPermission = 'unsupported';
      return 'unsupported';
    }

    if (this.notificationsEnabled) {
      this.notificationsEnabled = false;
      try {
        localStorage.setItem(NOTIFICATION_STORAGE_KEY, '0');
      } catch {
        // Ignore storage errors.
      }
      return 'disabled';
    }

    if (Notification.permission === 'default') {
      try {
        await Notification.requestPermission();
      } catch {
        // Permission prompt failure falls through to state check.
      }
    }

    this.notificationPermission = Notification.permission;
    if (Notification.permission !== 'granted') {
      this.notificationsEnabled = false;
      try {
        localStorage.setItem(NOTIFICATION_STORAGE_KEY, '0');
      } catch {
        // Ignore storage errors.
      }
      return 'denied';
    }

    this.notificationsEnabled = true;
    try {
      localStorage.setItem(NOTIFICATION_STORAGE_KEY, '1');
    } catch {
      // Ignore storage errors.
    }
    return 'enabled';
  }

  private maybeDispatchBrowserNotification(job: Job) {
    if (!this.notificationsEnabled) return;
    if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;

    const thresholdMs = (this.config?.notifyInactiveSeconds ?? 300) * 1000;
    const elapsedMs = Date.now() - this.lastActiveAt;
    if (thresholdMs > 0 && elapsedMs < thresholdMs) return;

    const name = job.resolvedFilename || 'Transfer';
    const title = job.status === 'completed' ? 'Transfer Completed' : 'Transfer Failed';
    const body =
      job.status === 'completed'
        ? `${name} uploaded to ${job.destinationRemote}`
        : `${name} failed: ${job.error || 'Transfer failed'}`;

    const notification = new Notification(title, {
      body,
      tag: `drive-dl-${job.id}`,
    });
    notification.onclick = () => {
      window.focus();
      notification.close();
    };
  }

  private rescheduleStatsTimer() {
    if (this.statsTimer) {
      clearInterval(this.statsTimer);
      this.statsTimer = null;
    }
    const intervalMs = this.telemetryOpen ? 5_000 : 30_000;
    this.statsTimer = setInterval(() => void this.refreshStats(), intervalMs);
  }

  private setSnapshot(nextJobs: Job[]) {
    this.jobs = nextJobs;
  }

  private upsertJob(job: Job) {
    const idx = this.jobs.findIndex((existing) => existing.id === job.id);
    const prevStatus = idx === -1 ? null : this.jobs[idx].status;
    if (idx === -1) {
      this.jobs = [job, ...this.jobs];
    } else {
      this.jobs[idx] = job;
    }

    if (
      prevStatus &&
      prevStatus !== 'completed' &&
      prevStatus !== 'failed' &&
      (job.status === 'completed' || job.status === 'failed')
    ) {
      this.maybeDispatchBrowserNotification(job);
    }

    if (job.status === 'completed') {
      void this.refreshConfig();
      void this.refreshStats();
    }
  }

  private startFallbackPolling() {
    if (this.pollTimer) return;
    this.pollTimer = setInterval(async () => {
      try {
        this.setSnapshot(await fetchJobs());
      } catch {
        // Retry on next interval until SSE recovers.
      }
    }, 3000);
  }

  private stopFallbackPolling() {
    if (!this.pollTimer) return;
    clearInterval(this.pollTimer);
    this.pollTimer = null;
  }

  start(): () => void {
    void this.refreshConfig();
    void this.refreshStats();
    this.configTimer = setInterval(() => void this.refreshConfig(), 30_000);
    this.rescheduleStatsTimer();

    this.lastActiveAt = Date.now();
    if (typeof document !== 'undefined' && document.visibilityState === 'visible') {
      this.lastHeartbeatAt = this.lastActiveAt;
      void sendPresenceHeartbeat();
    }

    const recordInteraction = () => {
      const now = Date.now();
      this.lastActiveAt = now;
      if (now - this.lastHeartbeatAt >= 30_000) {
        this.lastHeartbeatAt = now;
        void sendPresenceHeartbeat();
      }
    };

    const throttledMouseMove = () => {
      if (Date.now() - this.lastActiveAt >= 15_000) {
        recordInteraction();
      }
    };

    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        recordInteraction();
      }
    };

    if (typeof window !== 'undefined' && typeof document !== 'undefined') {
      window.addEventListener('pointerdown', recordInteraction);
      window.addEventListener('keydown', recordInteraction);
      window.addEventListener('focus', recordInteraction);
      window.addEventListener('mousemove', throttledMouseMove);
      document.addEventListener('visibilitychange', onVisibilityChange);
      this.presenceTimer = setInterval(() => {
        const thresholdMs = (this.config?.notifyInactiveSeconds ?? 300) * 1000;
        if (
          document.visibilityState === 'visible' &&
          (thresholdMs === 0 || Date.now() - this.lastActiveAt < thresholdMs)
        ) {
          this.lastHeartbeatAt = Date.now();
          void sendPresenceHeartbeat();
        }
      }, 45_000);
    }

    const es = new EventSource('/api/events');
    this.eventSource = es;

    es.onopen = () => {
      this.connectionState = 'live';
      this.stopFallbackPolling();
    };

    es.addEventListener('snapshot', (event) => {
      this.setSnapshot(JSON.parse((event as MessageEvent<string>).data) as Job[]);
    });

    es.addEventListener('job', (event) => {
      this.upsertJob(JSON.parse((event as MessageEvent<string>).data) as Job);
    });

    es.onerror = () => {
      this.connectionState = 'reconnecting';
      this.startFallbackPolling();
    };

    return () => {
      es.close();
      this.eventSource = null;
      this.stopFallbackPolling();
      if (this.configTimer) {
        clearInterval(this.configTimer);
        this.configTimer = null;
      }
      if (this.statsTimer) {
        clearInterval(this.statsTimer);
        this.statsTimer = null;
      }
      if (this.presenceTimer) {
        clearInterval(this.presenceTimer);
        this.presenceTimer = null;
      }
      if (typeof window !== 'undefined' && typeof document !== 'undefined') {
        window.removeEventListener('pointerdown', recordInteraction);
        window.removeEventListener('keydown', recordInteraction);
        window.removeEventListener('focus', recordInteraction);
        window.removeEventListener('mousemove', throttledMouseMove);
        document.removeEventListener('visibilitychange', onVisibilityChange);
      }
    };
  }
}

export const transferStore = new TransferStore();
