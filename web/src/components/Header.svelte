<script lang="ts">
  import { triggerMediaRefresh } from '../api/client';
  import { toasts } from '../stores/toasts.svelte';
  import { transferStore } from '../stores/transferStore.svelte';
  import { formatBytes, formatSpeed } from '../utils/format';
  import ThemeToggle from './ThemeToggle.svelte';

  let refreshing = $state(false);

  let freeDiskLabel = $derived(
    transferStore.config?.disk?.freeBytes
      ? `${formatBytes(transferStore.config.disk.freeBytes)} free`
      : 'Disk --',
  );

  let statusLabel = $derived(
    transferStore.connectionState === 'live'
      ? 'Live'
      : transferStore.connectionState === 'reconnecting'
        ? 'Reconnecting'
        : 'Connecting',
  );

  async function handleRefreshMedia() {
    refreshing = true;
    try {
      const result = await triggerMediaRefresh();
      const summary = result.messages.length ? result.messages.join(' • ') : 'Media refresh triggered';
      toasts.push('success', summary);
    } catch (err) {
      toasts.push('danger', err instanceof Error ? err.message : 'Media refresh failed');
    } finally {
      refreshing = false;
    }
  }
</script>

<header class="topbar">
  <div class="brand">
    <span class="material-symbols-outlined brand-icon" aria-hidden="true">cloud_sync</span>
    <div>
      <h1>Drive Downloader</h1>
      <p class="subtitle">Staged &amp; direct transfers to Google Drive</p>
    </div>
  </div>

  <div class="telemetry">
    {#if transferStore.activeCount > 0}
      <div class="pill speed-pill">
        <span class="badge-count">{transferStore.activeCount}</span>
        <span class="mono">{formatSpeed(transferStore.totalSpeedBytesPerSec)}</span>
      </div>
    {/if}

    <div class="pill disk-pill" title="VPS staging disk headroom">
      <div class="disk-meta">
        <span class="disk-label">{freeDiskLabel}</span>
        {#if transferStore.diskUsedPercent !== null}
          <span class="disk-pct mono">{transferStore.diskUsedPercent}%</span>
        {/if}
      </div>
      <div class="disk-track" aria-hidden="true">
        <div
          class="disk-fill tone-{transferStore.diskTone}"
          style:width={`${transferStore.diskUsedPercent ?? 0}%`}
        ></div>
      </div>
    </div>

    <div class="pill sse-pill">
      <span class="status-dot state-{transferStore.connectionState}" aria-hidden="true"></span>
      <span>{statusLabel}</span>
    </div>

    {#if transferStore.config?.proxyConfigured}
      <div class="pill proxy-pill" title="Outbound downloads routed through configured proxy">
        Proxy
      </div>
    {/if}

    {#if transferStore.hasMediaRefresh}
      <button
        type="button"
        class="action-btn"
        disabled={refreshing}
        onclick={handleRefreshMedia}
      >
        {refreshing ? 'Refreshing...' : 'Refresh Media'}
      </button>
    {/if}

    <ThemeToggle />
  </div>
</header>

<style>
  .topbar {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: var(--uw-space-4);
    padding-bottom: var(--uw-space-5);
    border-bottom: 1px solid var(--uw-border-subtle);
  }

  .brand {
    display: flex;
    align-items: center;
    gap: var(--uw-space-3);
  }

  .brand-icon {
    font-size: 2rem;
    color: var(--uw-brand-solid);
    flex-shrink: 0;
    font-variation-settings:
      'FILL' 1,
      'wght' 300,
      'GRAD' 0,
      'opsz' 24;
  }

  .brand h1 {
    font-size: var(--uw-font-size-xl);
    font-weight: var(--uw-font-weight-bold);
    line-height: var(--uw-line-height-tight);
  }

  .subtitle {
    color: var(--uw-fg-muted);
    font-size: var(--uw-font-size-xs);
    margin-top: var(--uw-space-0-5);
  }

  .telemetry {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--uw-space-2);
  }

  .pill {
    display: inline-flex;
    align-items: center;
    gap: var(--uw-space-2);
    padding: var(--uw-space-1) var(--uw-space-3);
    min-height: 2rem;
    background: var(--uw-bg-surface);
    border: 1px solid var(--uw-border-subtle);
    border-radius: var(--uw-radius-full);
    color: var(--uw-fg-muted);
    font-size: var(--uw-font-size-xs);
    font-weight: var(--uw-font-weight-medium);
  }

  .speed-pill {
    background: var(--uw-brand-bg);
    border-color: var(--uw-brand-border);
    color: var(--uw-brand-fg);
  }

  .badge-count {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: 1.25rem;
    height: 1.25rem;
    padding: 0 var(--uw-space-1);
    border-radius: var(--uw-radius-full);
    background: var(--uw-brand-solid);
    color: var(--uw-brand-on-solid);
    font-weight: var(--uw-font-weight-bold);
  }

  .disk-pill {
    flex-direction: column;
    align-items: stretch;
    gap: var(--uw-space-1);
    min-width: 8.5rem;
    padding: var(--uw-space-1) var(--uw-space-3);
    border-radius: var(--uw-radius-lg);
  }

  .disk-meta {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--uw-space-2);
    line-height: var(--uw-line-height-none);
  }

  .disk-label {
    color: var(--uw-fg-default);
  }

  .disk-pct {
    color: var(--uw-fg-muted);
  }

  .disk-track {
    width: 100%;
    height: 0.25rem;
    border-radius: var(--uw-radius-full);
    background: var(--uw-bg-subtle);
    overflow: hidden;
  }

  .disk-fill {
    height: 100%;
    border-radius: var(--uw-radius-full);
    transition: width var(--uw-duration-normal) var(--uw-easing-standard);
  }

  .disk-fill.tone-success {
    background: var(--uw-success-solid);
  }

  .disk-fill.tone-warning {
    background: var(--uw-warning-solid);
  }

  .disk-fill.tone-danger {
    background: var(--uw-danger-solid);
  }

  .proxy-pill {
    background: var(--uw-info-bg);
    border-color: var(--uw-info-border);
    color: var(--uw-info-fg);
  }

  .status-dot {
    width: 0.5rem;
    height: 0.5rem;
    border-radius: var(--uw-radius-full);
  }

  .status-dot.state-live {
    background: var(--uw-success-solid);
  }

  .status-dot.state-connecting {
    background: var(--uw-warning-solid);
  }

  .status-dot.state-reconnecting {
    background: var(--uw-danger-solid);
  }

  .action-btn {
    border: 1px solid var(--uw-border-default);
    background: var(--uw-bg-surface);
    color: var(--uw-fg-default);
    border-radius: var(--uw-radius-full);
    padding: var(--uw-space-1) var(--uw-space-3);
    min-height: 2rem;
    font-family: var(--uw-font-sans);
    font-size: var(--uw-font-size-xs);
    font-weight: var(--uw-font-weight-semibold);
    cursor: pointer;
    transition:
      background-color var(--uw-duration-fast) var(--uw-easing-standard),
      border-color var(--uw-duration-fast) var(--uw-easing-standard);
  }

  .action-btn:hover:not(:disabled) {
    background: var(--uw-bg-surface-hover);
    border-color: var(--uw-border-strong);
  }

  .action-btn:disabled {
    opacity: 0.55;
    cursor: not-allowed;
  }
</style>
