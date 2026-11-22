import { fetchConfig, fetchJobs, fetchStats } from '../api/client';
import type {
  AppConfigResponse,
  ConnectionState,
  Job,
  SystemStatsResponse,
} from '../api/types';

function isActiveJob(job: Job): boolean {
  return (
    job.status === 'queued' ||
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
    Boolean(this.config?.jellyfinConfigured || this.config?.rcloneRcConfigured),
  );

  private eventSource: EventSource | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private configTimer: ReturnType<typeof setInterval> | null = null;
  private statsTimer: ReturnType<typeof setInterval> | null = null;
  private telemetryOpen = false;

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
    if (idx === -1) {
      this.jobs = [job, ...this.jobs];
    } else {
      this.jobs[idx] = job;
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
    };
  }
}

export const transferStore = new TransferStore();
