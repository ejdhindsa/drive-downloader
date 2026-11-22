<script lang="ts">
  import { transferStore } from '../stores/transferStore.svelte';
  import { formatBytes, formatSpeed } from '../utils/format';

  interface Props {
    open: boolean;
  }

  let { open }: Props = $props();

  function usageTone(pct: number): 'success' | 'warning' | 'danger' {
    if (pct >= 90) return 'danger';
    if (pct >= 75) return 'warning';
    return 'success';
  }

  let cpuPercent = $derived(transferStore.stats?.cpu.percent ?? 0);
  let memPercent = $derived(transferStore.stats?.memory.usedPercent ?? 0);
  let diskPercent = $derived(transferStore.stats?.disk.usedPercent ?? 0);

  let drivePercent = $derived.by(() => {
    const quota = transferStore.stats?.driveQuota;
    if (!quota || quota.totalBytes <= 0) return null;
    return Math.min(100, Math.round((quota.usedBytes / quota.totalBytes) * 1000) / 10);
  });
</script>

<div class="drawer" class:open aria-hidden={!open}>
  <div class="drawer-inner">
    <section class="telemetry-grid" aria-label="System and transfer telemetry">
      <div class="metric-card">
        <div class="metric-head">
          <span class="metric-label">Throughput</span>
          <span class="metric-sub mono">{transferStore.activeCount} active</span>
        </div>
        <div class="throughput-rows mono">
          <div class="speed-row">
            <span class="dir dir-down">↓ DL</span>
            <strong>{formatSpeed(transferStore.downloadSpeedBytesPerSec)}</strong>
          </div>
          <div class="speed-row">
            <span class="dir dir-up">↑ UL</span>
            <strong>{formatSpeed(transferStore.uploadSpeedBytesPerSec)}</strong>
          </div>
        </div>
      </div>

      <div class="metric-card">
        <div class="metric-head">
          <span class="metric-label">CPU</span>
          <span class="metric-value mono">{cpuPercent.toFixed(1)}%</span>
        </div>
        <div class="bar-track">
          <div class="bar-fill tone-{usageTone(cpuPercent)}" style:width={`${cpuPercent}%`}></div>
        </div>
        <div class="metric-foot mono">
          {#if transferStore.stats}
            {transferStore.stats.cpu.cores} cores • load {transferStore.stats.cpu.loadAvg1m.toFixed(2)}
          {:else}
            Sampling...
          {/if}
        </div>
      </div>

      <div class="metric-card">
        <div class="metric-head">
          <span class="metric-label">Memory</span>
          <span class="metric-value mono">{memPercent.toFixed(1)}%</span>
        </div>
        <div class="bar-track">
          <div class="bar-fill tone-{usageTone(memPercent)}" style:width={`${memPercent}%`}></div>
        </div>
        <div class="metric-foot mono">
          {#if transferStore.stats}
            {formatBytes(transferStore.stats.memory.usedBytes)} / {formatBytes(transferStore.stats.memory.totalBytes)}
          {:else}
            --
          {/if}
        </div>
      </div>

      <div class="metric-card">
        <div class="metric-head">
          <span class="metric-label">VPS Disk</span>
          <span class="metric-value mono">{diskPercent.toFixed(1)}%</span>
        </div>
        <div class="bar-track">
          <div class="bar-fill tone-{usageTone(diskPercent)}" style:width={`${diskPercent}%`}></div>
        </div>
        <div class="metric-foot mono">
          {#if transferStore.stats?.disk.totalBytes}
            {formatBytes(transferStore.stats.disk.freeBytes)} free of {formatBytes(transferStore.stats.disk.totalBytes)}
          {:else}
            --
          {/if}
        </div>
      </div>

      <div class="metric-card">
        <div class="metric-head">
          <span class="metric-label">Drive Quota</span>
          <span class="metric-value mono">
            {drivePercent !== null ? `${drivePercent.toFixed(1)}%` : '--'}
          </span>
        </div>
        <div class="bar-track">
          <div
            class="bar-fill tone-{drivePercent !== null ? usageTone(drivePercent) : 'muted'}"
            style:width={`${drivePercent ?? 0}%`}
          ></div>
        </div>
        <div class="metric-foot mono">
          {#if transferStore.stats?.driveQuota}
            {formatBytes(transferStore.stats.driveQuota.freeBytes)} free of {formatBytes(transferStore.stats.driveQuota.totalBytes)}
          {:else}
            rclone remote unlinked
          {/if}
        </div>
      </div>
    </section>
  </div>
</div>

<style>
  .drawer {
    display: grid;
    grid-template-rows: 0fr;
    opacity: 0;
    transition:
      grid-template-rows var(--uw-duration-normal) var(--uw-easing-emphasized),
      opacity var(--uw-duration-normal) var(--uw-easing-standard),
      margin-top var(--uw-duration-normal) var(--uw-easing-emphasized);
    margin-top: 0;
  }

  .drawer.open {
    grid-template-rows: 1fr;
    opacity: 1;
    margin-top: var(--uw-space-4);
  }

  .drawer-inner {
    overflow: hidden;
  }

  .telemetry-grid {
    display: grid;
    grid-template-columns: repeat(5, minmax(0, 1fr));
    gap: var(--uw-space-3);
    padding: var(--uw-space-3);
    background: var(--uw-bg-subtle);
    border: 1px solid var(--uw-border-subtle);
    border-radius: var(--uw-radius-xl);
  }

  @media (max-width: 64rem) {
    .telemetry-grid {
      grid-template-columns: repeat(2, minmax(0, 1fr));
    }
  }

  @media (max-width: 36rem) {
    .telemetry-grid {
      grid-template-columns: 1fr;
    }
  }

  .metric-card {
    display: flex;
    flex-direction: column;
    gap: var(--uw-space-2);
    padding: var(--uw-space-3);
    background: var(--uw-bg-surface);
    border: 1px solid var(--uw-border-subtle);
    border-radius: var(--uw-radius-lg);
    box-shadow: var(--uw-shadow-sm);
  }

  .metric-head {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: var(--uw-space-2);
  }

  .metric-label {
    font-size: var(--uw-font-size-xs);
    font-weight: var(--uw-font-weight-semibold);
    text-transform: uppercase;
    letter-spacing: var(--uw-letter-spacing-wider);
    color: var(--uw-fg-muted);
  }

  .metric-value {
    font-size: var(--uw-font-size-sm);
    font-weight: var(--uw-font-weight-bold);
    color: var(--uw-fg-heading);
  }

  .metric-sub,
  .metric-foot {
    font-size: var(--uw-font-size-xs);
    color: var(--uw-fg-muted);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .throughput-rows {
    display: flex;
    flex-direction: column;
    gap: var(--uw-space-1);
    font-size: var(--uw-font-size-xs);
  }

  .speed-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--uw-space-2);
  }

  .speed-row strong {
    color: var(--uw-fg-heading);
    font-weight: var(--uw-font-weight-semibold);
  }

  .dir {
    font-weight: var(--uw-font-weight-semibold);
  }

  .dir-down {
    color: var(--uw-info-fg);
  }

  .dir-up {
    color: var(--uw-brand-fg);
  }

  .bar-track {
    width: 100%;
    height: 0.375rem;
    border-radius: var(--uw-radius-full);
    background: var(--uw-bg-subtle);
    overflow: hidden;
  }

  .bar-fill {
    height: 100%;
    border-radius: var(--uw-radius-full);
    transition: width var(--uw-duration-normal) var(--uw-easing-standard);
  }

  .bar-fill.tone-success {
    background: var(--uw-brand-solid);
  }

  .bar-fill.tone-warning {
    background: var(--uw-warning-solid);
  }

  .bar-fill.tone-danger {
    background: var(--uw-danger-solid);
  }

  .bar-fill.tone-muted {
    background: var(--uw-border-default);
  }
</style>
