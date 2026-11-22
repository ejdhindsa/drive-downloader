import { fetchConfig, fetchJobs } from '../api/client';
import type { AppConfigResponse, ConnectionState, Job } from '../api/types';

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
  jobs = $state<Job[]>([]);
  connectionState = $state<ConnectionState>('connecting');

  activeJobs = $derived(this.jobs.filter(isActiveJob));
  activeCount = $derived(this.activeJobs.length);

  totalSpeedBytesPerSec = $derived(
    this.activeJobs.reduce((sum, job) => {
      if (job.status === 'downloading' || job.status === 'uploading') {
        return sum + (job.progress?.speedBytesPerSec ?? 0);
      }
      return sum;
    }, 0),
  );

  diskUsedPercent = $derived.by(() => {
    const disk = this.config?.disk;
    if (!disk || disk.totalBytes <= 0) return null;
    const used = Math.max(0, disk.totalBytes - disk.freeBytes);
    return Math.min(100, Math.round((used / disk.totalBytes) * 100));
  });

  diskTone = $derived<'success' | 'warning' | 'danger'>(
    this.diskUsedPercent === null
      ? 'success'
      : this.diskUsedPercent >= 90
        ? 'danger'
        : this.diskUsedPercent >= 75
          ? 'warning'
          : 'success',
  );

  hasMediaRefresh = $derived(
    Boolean(this.config?.jellyfinConfigured || this.config?.rcloneRcConfigured),
  );

  private eventSource: EventSource | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private configTimer: ReturnType<typeof setInterval> | null = null;

  async refreshConfig() {
    try {
      this.config = await fetchConfig();
    } catch {
      // Keep last known config snapshot during transient network blips.
    }
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
    this.configTimer = setInterval(() => void this.refreshConfig(), 30_000);

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
    };
  }
}

export const transferStore = new TransferStore();
