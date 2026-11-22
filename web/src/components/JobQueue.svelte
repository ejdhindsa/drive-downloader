<script lang="ts">
  import { clearFinishedJobs } from '../api/client';
  import { toasts } from '../stores/toasts.svelte';
  import { transferStore } from '../stores/transferStore.svelte';
  import JobCard from './JobCard.svelte';

  type FilterTab = 'all' | 'active' | 'completed' | 'failed';

  let activeFilter = $state<FilterTab>('all');
  let clearing = $state(false);

  let completedCount = $derived(
    transferStore.jobs.filter((j) => j.status === 'completed').length,
  );
  let failedCount = $derived(
    transferStore.jobs.filter((j) => j.status === 'failed' || j.status === 'cancelled').length,
  );
  let finishedCount = $derived(completedCount + failedCount);

  let filteredJobs = $derived.by(() => {
    if (activeFilter === 'active') return transferStore.activeJobs;
    if (activeFilter === 'completed') {
      return transferStore.jobs.filter((j) => j.status === 'completed');
    }
    if (activeFilter === 'failed') {
      return transferStore.jobs.filter((j) => j.status === 'failed' || j.status === 'cancelled');
    }
    return transferStore.jobs;
  });

  const tabs = $derived<Array<{ id: FilterTab; label: string; count: number }>>([
    { id: 'all', label: 'All', count: transferStore.jobs.length },
    { id: 'active', label: 'Active', count: transferStore.activeCount },
    { id: 'completed', label: 'Done', count: completedCount },
    { id: 'failed', label: 'Failed', count: failedCount },
  ]);

  async function handleClearFinished() {
    clearing = true;
    try {
      const removed = await clearFinishedJobs();
      if (removed > 0) {
        toasts.push('info', `Cleared ${removed} finished transfer(s).`);
      }
    } catch (err) {
      toasts.push('danger', err instanceof Error ? err.message : 'Failed to clear finished jobs');
    } finally {
      clearing = false;
    }
  }
</script>

<section class="queue-panel">
  <div class="queue-head">
    <div>
      <h2>Transfer Queue</h2>
      <p class="queue-sub">Live status, progress, and per-job output</p>
    </div>

    <button
      type="button"
      class="clear-btn"
      disabled={clearing || finishedCount === 0}
      onclick={handleClearFinished}
    >
      {clearing ? 'Clearing...' : 'Clear Finished'}
    </button>
  </div>

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

  {#if filteredJobs.length === 0}
    <div class="empty-state">
      <span class="material-symbols-outlined empty-icon">cloud_sync</span>
      <p class="empty-title">
        {transferStore.jobs.length === 0 ? 'No transfers yet' : `No ${activeFilter} transfers`}
      </p>
      <p class="empty-sub">
        {transferStore.jobs.length === 0
          ? 'Paste a URL on the left and hit Queue Download to start.'
          : 'Switch filters above to view other transfers.'}
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

  .clear-btn {
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

  .clear-btn:hover:not(:disabled) {
    background: var(--uw-bg-surface-hover);
    border-color: var(--uw-border-strong);
  }

  .clear-btn:disabled {
    opacity: 0.45;
    cursor: not-allowed;
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
