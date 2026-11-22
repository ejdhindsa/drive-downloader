<script lang="ts">
  import { triggerMediaRefresh } from '../api/client';
  import { toasts } from '../stores/toasts.svelte';
  import { transferStore } from '../stores/transferStore.svelte';
  import BookmarkletModal from './BookmarkletModal.svelte';
  import TelemetryBar from './TelemetryBar.svelte';
  import ThemeToggle from './ThemeToggle.svelte';

  const STORAGE_KEY = 'drive-downloader:telemetry-open';

  function readInitialOpen(): boolean {
    try {
      return localStorage.getItem(STORAGE_KEY) === '1';
    } catch {
      return false;
    }
  }

  let telemetryOpen = $state(readInitialOpen());
  let refreshing = $state(false);
  let bookmarkletOpen = $state(false);

  $effect(() => {
    transferStore.setTelemetryOpen(telemetryOpen);
    try {
      localStorage.setItem(STORAGE_KEY, telemetryOpen ? '1' : '0');
    } catch {
      // Ignore storage quota / private mode failures.
    }
  });

  let statusLabel = $derived(
    transferStore.connectionState === 'live'
      ? 'Live'
      : transferStore.connectionState === 'reconnecting'
        ? 'Reconnecting'
        : 'Connecting',
  );

  let telemetryTone = $derived.by<'success' | 'warning' | 'danger'>(() => {
    const stats = transferStore.stats;
    if (!stats) return 'success';
    const peak = Math.max(stats.cpu.percent, stats.memory.usedPercent, stats.disk.usedPercent);
    if (peak >= 90) return 'danger';
    if (peak >= 75) return 'warning';
    return 'success';
  });

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

  async function handleToggleAlerts() {
    const outcome = await transferStore.toggleBrowserNotifications();
    if (outcome === 'enabled') {
      const mins = Math.max(
        0,
        Math.round((transferStore.config?.notifyInactiveSeconds ?? 300) / 60),
      );
      toasts.push(
        'success',
        mins > 0
          ? `Browser alerts enabled (fires after ${mins}m of tab inactivity).`
          : 'Browser alerts enabled.',
      );
    } else if (outcome === 'disabled') {
      toasts.push('info', 'Browser alerts disabled.');
    } else if (outcome === 'denied') {
      toasts.push('danger', 'Notification permission was denied by your browser.');
    } else {
      toasts.push('info', 'Browser notifications are not supported here.');
    }
  }
</script>

<header class="header-wrap">
  <div class="topbar">
    <div class="brand">
      <span class="material-symbols-outlined brand-icon" aria-hidden="true">cloud_sync</span>
      <div>
        <h1>Drive Downloader</h1>
        <p class="subtitle">Staged &amp; direct transfers to Google Drive</p>
      </div>
    </div>

    <div class="controls">
      {#if transferStore.activeCount > 0}
        <div class="pill active-pill">
          <span class="badge-count">{transferStore.activeCount}</span>
          <span>Active</span>
        </div>
      {/if}

      <div class="pill sse-pill">
        <span class="status-dot state-{transferStore.connectionState}" aria-hidden="true"></span>
        <span>{statusLabel}</span>
      </div>

      {#if transferStore.config?.proxyConfigured}
        <div class="pill proxy-pill" title="Outbound downloads routed through configured proxy">
          Proxy
        </div>
      {/if}

      <button
        type="button"
        class="action-btn telemetry-btn"
        class:open={telemetryOpen}
        aria-expanded={telemetryOpen}
        onclick={() => (telemetryOpen = !telemetryOpen)}
      >
        <span class="metric-dot tone-{telemetryTone}" aria-hidden="true"></span>
        <span>System</span>
        <svg class="chevron" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
          <path
            d="M4 6l4 4 4-4"
            fill="none"
            stroke="currentColor"
            stroke-width="1.75"
            stroke-linecap="round"
            stroke-linejoin="round"
          />
        </svg>
      </button>

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

      <button type="button" class="action-btn" onclick={() => (bookmarkletOpen = true)}>
        Bookmarklet
      </button>

      {#if transferStore.notificationPermission !== 'unsupported'}
        <button
          type="button"
          class="action-btn alerts-btn"
          class:enabled={transferStore.notificationsEnabled}
          onclick={handleToggleAlerts}
        >
          <span
            class="alert-dot"
            class:on={transferStore.notificationsEnabled}
            aria-hidden="true"
          ></span>
          <span>{transferStore.notificationsEnabled ? 'Alerts On' : 'Alerts'}</span>
        </button>
      {/if}

      <ThemeToggle />
    </div>
  </div>

  <TelemetryBar open={telemetryOpen} />
</header>

<BookmarkletModal open={bookmarkletOpen} onClose={() => (bookmarkletOpen = false)} />

<style>
  .header-wrap {
    padding-bottom: var(--uw-space-5);
    border-bottom: 1px solid var(--uw-border-subtle);
  }

  .topbar {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: var(--uw-space-4);
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

  .controls {
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

  .active-pill {
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

  .proxy-pill {
    background: var(--uw-info-bg);
    border-color: var(--uw-info-border);
    color: var(--uw-info-fg);
  }

  .status-dot,
  .metric-dot {
    width: 0.5rem;
    height: 0.5rem;
    border-radius: var(--uw-radius-full);
  }

  .status-dot.state-live,
  .metric-dot.tone-success {
    background: var(--uw-success-solid);
  }

  .status-dot.state-connecting,
  .metric-dot.tone-warning {
    background: var(--uw-warning-solid);
  }

  .status-dot.state-reconnecting,
  .metric-dot.tone-danger {
    background: var(--uw-danger-solid);
  }

  .action-btn {
    display: inline-flex;
    align-items: center;
    gap: var(--uw-space-2);
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

  .telemetry-btn.open {
    background: var(--uw-brand-bg);
    border-color: var(--uw-brand-border);
    color: var(--uw-brand-fg);
  }

  .alerts-btn.enabled {
    background: var(--uw-brand-bg);
    border-color: var(--uw-brand-border);
    color: var(--uw-brand-fg);
  }

  .alert-dot {
    width: 0.45rem;
    height: 0.45rem;
    border-radius: var(--uw-radius-full);
    background: var(--uw-fg-muted);
  }

  .alert-dot.on {
    background: var(--uw-brand-solid);
  }

  .chevron {
    transition: transform var(--uw-duration-normal) var(--uw-easing-emphasized);
  }

  .telemetry-btn.open .chevron {
    transform: rotate(180deg);
  }
</style>
