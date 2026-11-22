<script lang="ts">
  import { cancelAllActive, clearFinishedJobs, retryAllFailed } from '../api/client';
  import { toasts } from '../stores/toasts.svelte';
  import { transferStore } from '../stores/transferStore.svelte';
  import JobCard from './JobCard.svelte';

  type FilterTab = 'all' | 'active' | 'completed' | 'failed';

  let activeFilter = $state<FilterTab>('all');
  let searchQuery = $state('');
  let busyBulk = $state<'clear' | 'retry' | 'cancel' | null>(null);

  let completedCount = $derived(
    transferStore.jobs.filter((j) => j.status === 'completed').length,
  );
  let failedOnlyCount = $derived(
    transferStore.jobs.filter((j) => j.status === 'failed').length,
  );
  let failedCount = $derived(
    transferStore.jobs.filter((j) => j.status === 'failed' || j.status === 'cancelled').length,
  );
  let finishedCount = $derived(completedCount + failedCount);

  let filteredJobs = $derived.by(() => {
    let base = transferStore.jobs;
    if (activeFilter === 'active') base = transferStore.activeJobs;
    else if (activeFilter === 'completed') base = base.filter((j) => j.status === 'completed');
    else if (activeFilter === 'failed') {
      base = base.filter((j) => j.status === 'failed' || j.status === 'cancelled');
    }

    const q = searchQuery.trim().toLowerCase();
    if (!q) return base;
    return base.filter((j) => {
      const name = (j.resolvedFilename || '').toLowerCase();
      return (
        name.includes(q) ||
        j.url.toLowerCase().includes(q) ||
        j.destinationRemote.toLowerCase().includes(q)
      );
    });
  });

  const tabs = $derived<Array<{ id: FilterTab; label: string; count: number }>>([
    { id: 'all', label: 'All', count: transferStore.jobs.length },
    { id: 'active', label: 'Active', count: transferStore.activeCount },
    { id: 'completed', label: 'Done', count: completedCount },
    { id: 'failed', label: 'Failed', count: failedCount },
  ]);

  async function handleClearFinished() {
    busyBulk = 'clear';
    try {
      const removed = await clearFinishedJobs();
      if (removed > 0) {
        toasts.push('info', `Cleared ${removed} finished transfer(s).`);
      }
    } catch (err) {
      toasts.push('danger', err instanceof Error ? err.message : 'Failed to clear finished jobs');
    } finally {
      busyBulk = null;
    }
  }

  async function handleRetryFailed() {
    busyBulk = 'retry';
    try {
      const retried = await retryAllFailed();
      toasts.push('success', `Re-queued ${retried} failed transfer(s).`);
    } catch (err) {
      toasts.push('danger', err instanceof Error ? err.message : 'Failed to retry jobs');
    } finally {
      busyBulk = null;
    }
  }

  async function handleCancelAll() {
    busyBulk = 'cancel';
    try {
      const cancelled = await cancelAllActive();
      toasts.push('info', `Cancelled ${cancelled} active transfer(s).`);
    } catch (err) {
      toasts.push('danger', err instanceof Error ? err.message : 'Failed to cancel active jobs');
    } finally {
      busyBulk = null;
    }
  }
</script>

<section class="queue-panel">
  <div class="queue-head">
    <div>
      <h2>Transfer Queue</h2>
      <p class="queue-sub">Live status, progress, and per-job output</p>
    </div>

    <div class="bulk-actions">
      {#if failedOnlyCount > 0}
        <button
          type="button"
          class="bulk-btn"
          disabled={busyBulk !== null}
          onclick={handleRetryFailed}
        >
          {busyBulk === 'retry' ? 'Retrying...' : `Retry Failed (${failedOnlyCount})`}
        </button>
      {/if}

      {#if transferStore.activeCount > 0}
        <button
          type="button"
          class="bulk-btn danger"
          disabled={busyBulk !== null}
          onclick={handleCancelAll}
        >
          {busyBulk === 'cancel' ? 'Cancelling...' : 'Cancel All'}
        </button>
      {/if}

      <button
        type="button"
        class="bulk-btn"
        disabled={busyBulk !== null || finishedCount === 0}
        onclick={handleClearFinished}
      >
        {busyBulk === 'clear' ? 'Clearing...' : 'Clear Finished'}
      </button>
    </div>
  </div>

  <div class="toolbar">
    <div class="filter-bar">
      {#each tabs as tab (tab.id)}
        <button
          type="button"
          class="filter-pill"
          class:active={activeFilter === tab.id}
          onclick={() => (activeFilter = tab.id)}
        >
          <span>{tab.label}</span>
          <span class="pill-count mono">{tab.count}</span>
        </button>
      {/each}
    </div>

    {#if transferStore.jobs.length > 0}
      <input
        type="search"
        class="search-input"
        bind:value={searchQuery}
        placeholder="Filter by file, URL, or folder..."
      />
    {/if}
  </div>

  {#if filteredJobs.length === 0}
    <div class="empty-state">
      <span class="material-symbols-outlined empty-icon">cloud_sync</span>
      <p class="empty-title">
        {#if transferStore.jobs.length === 0}
          No transfers yet
        {:else if searchQuery.trim()}
          No matches for "{searchQuery.trim()}"
        {:else}
          No {activeFilter} transfers
        {/if}
      </p>
      <p class="empty-sub">
        {#if transferStore.jobs.length === 0}
          Paste a URL on the left and hit Queue Download to start.
        {:else}
          Clear the search or switch filters above to view other transfers.
        {/if}
      </p>
    </div>
  {:else}
    <div class="job-list">
      {#each filteredJobs as job (job.id)}
        <JobCard {job} />
      {/each}
    </div>
  {/if}
</section>

<style>
  .queue-panel {
    background: var(--uw-bg-surface);
    border: 1px solid var(--uw-border-subtle);
    border-radius: var(--uw-radius-xl);
    padding: var(--uw-space-5);
    box-shadow: var(--uw-shadow-md);
    display: flex;
    flex-direction: column;
    gap: var(--uw-space-4);
  }

  .queue-head {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: var(--uw-space-3);
  }

  .queue-head h2 {
    font-size: var(--uw-font-size-lg);
    font-weight: var(--uw-font-weight-bold);
    line-height: var(--uw-line-height-tight);
  }

  .queue-sub {
    color: var(--uw-fg-muted);
    font-size: var(--uw-font-size-xs);
    margin-top: var(--uw-space-0-5);
  }

  .bulk-actions {
    display: flex;
    flex-wrap: wrap;
    gap: var(--uw-space-2);
  }

  .bulk-btn {
    border: 1px solid var(--uw-border-default);
    background: var(--uw-bg-subtle);
    color: var(--uw-fg-default);
    border-radius: var(--uw-radius-md);
    padding: var(--uw-space-1) var(--uw-space-3);
    font-family: var(--uw-font-sans);
    font-size: var(--uw-font-size-xs);
    font-weight: var(--uw-font-weight-semibold);
    cursor: pointer;
    transition:
      background-color var(--uw-duration-fast) var(--uw-easing-standard),
      border-color var(--uw-duration-fast) var(--uw-easing-standard);
  }

  .bulk-btn:hover:not(:disabled) {
    background: var(--uw-bg-surface-hover);
    border-color: var(--uw-border-strong);
  }

  .bulk-btn.danger {
    color: var(--uw-danger-fg);
    border-color: var(--uw-danger-border);
    background: var(--uw-danger-bg);
  }

  .bulk-btn.danger:hover:not(:disabled) {
    background: var(--uw-danger-bg-hover);
  }

  .bulk-btn:disabled {
    opacity: 0.45;
    cursor: not-allowed;
  }

  .toolbar {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: var(--uw-space-2);
  }

  .search-input {
    flex: 1;
    min-width: 11rem;
    max-width: 16rem;
    background: var(--uw-bg-subtle);
    color: var(--uw-fg-default);
    border: 1px solid var(--uw-border-default);
    border-radius: var(--uw-radius-full);
    padding: var(--uw-space-1) var(--uw-space-3);
    font-family: var(--uw-font-sans);
    font-size: var(--uw-font-size-xs);
    transition:
      border-color var(--uw-duration-fast) var(--uw-easing-standard),
      box-shadow var(--uw-duration-fast) var(--uw-easing-standard);
  }

  .search-input:focus {
    outline: none;
    border-color: var(--uw-focus-ring);
    box-shadow: 0 0 0 3px color-mix(in oklch, var(--uw-brand-solid) 18%, transparent);
  }

  .filter-bar {
    display: flex;
    flex-wrap: wrap;
    gap: var(--uw-space-2);
  }

  .filter-pill {
    display: inline-flex;
    align-items: center;
    gap: var(--uw-space-2);
    border: 1px solid var(--uw-border-subtle);
    background: var(--uw-bg-subtle);
    color: var(--uw-fg-muted);
    border-radius: var(--uw-radius-full);
    padding: var(--uw-space-1) var(--uw-space-3);
    font-family: var(--uw-font-sans);
    font-size: var(--uw-font-size-xs);
    font-weight: var(--uw-font-weight-semibold);
    cursor: pointer;
    transition:
      background-color var(--uw-duration-fast) var(--uw-easing-standard),
      border-color var(--uw-duration-fast) var(--uw-easing-standard),
      color var(--uw-duration-fast) var(--uw-easing-standard);
  }

  .filter-pill:hover {
    color: var(--uw-fg-default);
    border-color: var(--uw-border-default);
  }

  .filter-pill.active {
    background: var(--uw-brand-bg);
    border-color: var(--uw-brand-border);
    color: var(--uw-brand-fg);
  }

  .pill-count {
    font-size: 0.7rem;
    opacity: 0.85;
  }

  .empty-state {
    display: flex;
    flex-direction: column;
    align-items: center;
    text-align: center;
    padding: var(--uw-space-10) var(--uw-space-4);
    border: 1px dashed var(--uw-border-subtle);
    border-radius: var(--uw-radius-lg);
    background: var(--uw-bg-subtle);
  }

  .empty-icon {
    font-size: 2.25rem;
    color: var(--uw-fg-muted);
    opacity: 0.6;
    margin-bottom: var(--uw-space-2);
    font-variation-settings:
      'FILL' 1,
      'wght' 300,
      'GRAD' 0,
      'opsz' 24;
  }

  .empty-title {
    font-size: var(--uw-font-size-sm);
    font-weight: var(--uw-font-weight-semibold);
    color: var(--uw-fg-heading);
  }

  .empty-sub {
    font-size: var(--uw-font-size-xs);
    color: var(--uw-fg-muted);
    margin-top: var(--uw-space-1);
    max-width: 24rem;
  }

  .job-list {
    display: flex;
    flex-direction: column;
    gap: var(--uw-space-3);
  }
</style>
