<script lang="ts">
  import type { FileCategory, InspectResponse, ResolvedTarget } from '../api/types';
  import { formatBytes } from '../utils/format';

  interface Props {
    open: boolean;
    inspectResult: InspectResponse | null;
    submitting?: boolean;
    onClose: () => void;
    onQueueSelected: (
      selected: Array<{ url: string; customFilename?: string }>,
    ) => Promise<void> | void;
  }

  let { open, inspectResult, submitting = false, onClose, onQueueSelected }: Props = $props();

  let search = $state('');
  let selectedHoster = $state('all');
  let selectedCategory = $state<'all' | FileCategory>('all');
  let selectedMap = $state<Record<number, boolean>>({});
  let editedNames = $state<Record<number, string>>({});

  let lastResultRef: InspectResponse | null = null;

  const CATEGORY_LABELS: Record<FileCategory, string> = {
    video: 'Video',
    archive: 'Archive',
    audio: 'Audio',
    book: 'Book',
    other: 'Other',
  };

  $effect(() => {
    if (!open || !inspectResult) return;
    if (inspectResult === lastResultRef) return;
    lastResultRef = inspectResult;

    const nextSelected: Record<number, boolean> = {};
    const nextNames: Record<number, string> = {};
    inspectResult.items.forEach((item, idx) => {
      nextSelected[idx] = true;
      nextNames[idx] = item.filename ?? '';
    });
    selectedMap = nextSelected;
    editedNames = nextNames;
    search = '';
    selectedHoster = 'all';
    selectedCategory = 'all';
  });

  $effect(() => {
    if (!open) return;
    const onKeydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !submitting) {
        onClose();
      }
    };
    window.addEventListener('keydown', onKeydown);
    return () => window.removeEventListener('keydown', onKeydown);
  });

  let items = $derived(inspectResult?.items ?? []);

  let hosterCounts = $derived.by(() => {
    const counts = new Map<string, number>();
    for (const item of items) {
      counts.set(item.hoster, (counts.get(item.hoster) ?? 0) + 1);
    }
    return Array.from(counts.entries());
  });

  let categoryCounts = $derived.by(() => {
    const counts = new Map<FileCategory, number>();
    for (const item of items) {
      const cat = item.category ?? 'other';
      counts.set(cat, (counts.get(cat) ?? 0) + 1);
    }
    return (['video', 'archive', 'audio', 'book', 'other'] as FileCategory[])
      .map((cat) => ({ cat, count: counts.get(cat) ?? 0 }))
      .filter((entry) => entry.count > 0);
  });

  let visibleEntries = $derived.by(() => {
    const q = search.trim().toLowerCase();
    const entries: Array<{ item: ResolvedTarget; idx: number }> = [];
    for (let idx = 0; idx < items.length; idx += 1) {
      const item = items[idx];
      if (selectedHoster !== 'all' && item.hoster !== selectedHoster) continue;
      const cat = item.category ?? 'other';
      if (selectedCategory !== 'all' && cat !== selectedCategory) continue;
      if (q) {
        const edited = (editedNames[idx] ?? '').toLowerCase();
        const haystack = `${edited} ${item.downloadUrl.toLowerCase()} ${item.hoster.toLowerCase()}`;
        if (!haystack.includes(q)) continue;
      }
      entries.push({ item, idx });
    }
    return entries;
  });

  let selectedStats = $derived.by(() => {
    let count = 0;
    let knownBytes = 0;
    for (let idx = 0; idx < items.length; idx += 1) {
      if (!selectedMap[idx]) continue;
      count += 1;
      const sz = items[idx].sizeBytes;
      if (sz && sz > 0) knownBytes += sz;
    }
    const diskFree = inspectResult?.diskFreeBytes ?? 0;
    const minFree = inspectResult?.minFreeDiskBytes ?? 0;
    return {
      count,
      knownBytes,
      fitsOnDisk: diskFree - knownBytes >= minFree,
    };
  });

  function selectVisible(value: boolean) {
    const next = { ...selectedMap };
    for (const entry of visibleEntries) {
      next[entry.idx] = value;
    }
    selectedMap = next;
  }

  function invertVisible() {
    const next = { ...selectedMap };
    for (const entry of visibleEntries) {
      next[entry.idx] = !next[entry.idx];
    }
    selectedMap = next;
  }

  function toggleItem(idx: number) {
    selectedMap = {
      ...selectedMap,
      [idx]: !selectedMap[idx],
    };
  }

  function updateFilename(idx: number, value: string) {
    editedNames = {
      ...editedNames,
      [idx]: value,
    };
  }

  async function submitSelected() {
    if (selectedStats.count === 0 || submitting) return;
    const payload: Array<{ url: string; customFilename?: string }> = [];
    for (let idx = 0; idx < items.length; idx += 1) {
      if (!selectedMap[idx]) continue;
      const item = items[idx];
      const edited = (editedNames[idx] ?? '').trim();
      const orig = (item.filename ?? '').trim();
      const customFilename = edited && edited !== orig ? edited : undefined;
      payload.push({
        url: item.downloadUrl,
        customFilename,
      });
    }
    await onQueueSelected(payload);
  }
</script>

{#if open && inspectResult}
  <div
    class="modal-backdrop"
    onclick={(e) => {
      if (e.target === e.currentTarget && !submitting) {
        onClose();
      }
    }}
  >
    <div class="modal-card">
      <div class="modal-head">
        <div class="head-title">
          <h3>Inspect &amp; Pick</h3>
          <span class="head-sub mono">
            {selectedStats.count}/{items.length} selected
            {#if selectedStats.knownBytes > 0}
              · {formatBytes(selectedStats.knownBytes)}
            {/if}
          </span>
          {#if selectedStats.knownBytes > 0}
            <span class="disk-pill" class:danger={!selectedStats.fitsOnDisk}>
              {selectedStats.fitsOnDisk
                ? `Fits (${formatBytes(inspectResult.diskFreeBytes)} free)`
                : `Tight disk (${formatBytes(inspectResult.diskFreeBytes)} free)`}
            </span>
          {/if}
        </div>
        <button type="button" class="close-btn" disabled={submitting} onclick={onClose}>
          Close
        </button>
      </div>

      <div class="filter-bar">
        <input
          type="search"
          class="search-input"
          bind:value={search}
          placeholder="Filter by filename, URL, or hoster..."
        />

        <div class="bulk-actions">
          <button type="button" class="mini-btn" onclick={() => selectVisible(true)}>
            Select All
          </button>
          <button type="button" class="mini-btn" onclick={() => selectVisible(false)}>None</button>
          <button type="button" class="mini-btn" onclick={invertVisible}>Invert</button>
        </div>
      </div>

      {#if hosterCounts.length > 1 || categoryCounts.length > 1}
        <div class="chip-groups">
          {#if hosterCounts.length > 1}
            <div class="chip-row">
              <span class="chip-label">Hoster</span>
              <button
                type="button"
                class="filter-chip"
                class:active={selectedHoster === 'all'}
                onclick={() => (selectedHoster = 'all')}
              >
                All ({items.length})
              </button>
              {#each hosterCounts as [hoster, count] (hoster)}
                <button
                  type="button"
                  class="filter-chip"
                  class:active={selectedHoster === hoster}
                  onclick={() => (selectedHoster = hoster)}
                >
                  {hoster} ({count})
                </button>
              {/each}
            </div>
          {/if}

          {#if categoryCounts.length > 1}
            <div class="chip-row">
              <span class="chip-label">Type</span>
              <button
                type="button"
                class="filter-chip"
                class:active={selectedCategory === 'all'}
                onclick={() => (selectedCategory = 'all')}
              >
                All
              </button>
              {#each categoryCounts as entry (entry.cat)}
                <button
                  type="button"
                  class="filter-chip"
                  class:active={selectedCategory === entry.cat}
                  onclick={() => (selectedCategory = entry.cat)}
                >
                  {CATEGORY_LABELS[entry.cat]} ({entry.count})
                </button>
              {/each}
            </div>
          {/if}
        </div>
      {/if}

      <div class="items-scroll">
        {#if visibleEntries.length === 0}
          <p class="empty-msg">No links match the current filters.</p>
        {:else}
          <ul class="picker-list">
            {#each visibleEntries as { item, idx } (`${item.downloadUrl}-${idx}`)}
              <li class="picker-row" class:checked={Boolean(selectedMap[idx])}>
                <label class="check-wrap">
                  <input
                    type="checkbox"
                    checked={Boolean(selectedMap[idx])}
                    onchange={() => toggleItem(idx)}
                  />
                </label>

                <div class="row-main">
                  <input
                    type="text"
                    class="name-input"
                    value={editedNames[idx] ?? ''}
                    placeholder="Auto-detect filename"
                    oninput={(e) => updateFilename(idx, (e.currentTarget as HTMLInputElement).value)}
                  />
                  <div class="url-sub mono">{item.downloadUrl}</div>
                  {#if item.note}
                    <div class="row-note">{item.note}</div>
                  {/if}
                </div>

                <div class="row-badges">
                  <span class="hoster-pill">{item.hoster}</span>
                  <span class="cat-pill">{CATEGORY_LABELS[item.category ?? 'other']}</span>
                  {#if item.sizeBytes}
                    <span class="size-pill mono">{formatBytes(item.sizeBytes)}</span>
                  {/if}
                </div>
              </li>
            {/each}
          </ul>
        {/if}
      </div>

      {#if inspectResult.warnings.length > 0}
        <div class="warnings-box">
          {#each inspectResult.warnings as warning, wIdx (`${warning}-${wIdx}`)}
            <div class="warning-line mono">{warning}</div>
          {/each}
        </div>
      {/if}

      <div class="modal-foot">
        <button type="button" class="cancel-btn" disabled={submitting} onclick={onClose}>
          Cancel
        </button>
        <button
          type="button"
          class="queue-btn"
          disabled={selectedStats.count === 0 || submitting}
          onclick={submitSelected}
        >
          {submitting ? 'Queueing...' : `Queue Selected (${selectedStats.count})`}
        </button>
      </div>
    </div>
  </div>
{/if}

<style>
  .modal-backdrop {
    position: fixed;
    inset: 0;
    z-index: 60;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: var(--uw-space-4);
    background: color-mix(in oklch, var(--uw-bg-canvas) 68%, black 32%);
    backdrop-filter: blur(4px);
  }

  .modal-card {
    width: min(56rem, 100%);
    max-height: min(88vh, 52rem);
    display: flex;
    flex-direction: column;
    gap: var(--uw-space-3);
    padding: var(--uw-space-5);
    background: var(--uw-bg-surface);
    border: 1px solid var(--uw-border-default);
    border-radius: var(--uw-radius-xl);
    box-shadow: var(--uw-shadow-xl, var(--uw-shadow-md));
  }

  .modal-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--uw-space-3);
  }

  .head-title {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: var(--uw-space-2);
  }

  .head-title h3 {
    font-size: var(--uw-font-size-lg);
    font-weight: var(--uw-font-weight-bold);
  }

  .head-sub {
    font-size: var(--uw-font-size-xs);
    color: var(--uw-fg-muted);
  }

  .disk-pill {
    font-size: 0.7rem;
    font-weight: var(--uw-font-weight-semibold);
    padding: 2px var(--uw-space-2);
    border-radius: var(--uw-radius-full);
    background: var(--uw-brand-bg);
    border: 1px solid var(--uw-brand-border);
    color: var(--uw-brand-fg);
  }

  .disk-pill.danger {
    background: var(--uw-danger-bg);
    border-color: var(--uw-danger-border);
    color: var(--uw-danger-fg);
  }

  .close-btn,
  .cancel-btn {
    border: 1px solid var(--uw-border-default);
    background: var(--uw-bg-subtle);
    color: var(--uw-fg-default);
    border-radius: var(--uw-radius-md);
    padding: var(--uw-space-1) var(--uw-space-3);
    font-family: var(--uw-font-sans);
    font-size: var(--uw-font-size-xs);
    font-weight: var(--uw-font-weight-semibold);
    cursor: pointer;
  }

  .filter-bar {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--uw-space-2);
  }

  .search-input {
    flex: 1;
    min-width: 14rem;
    background: var(--uw-bg-subtle);
    color: var(--uw-fg-default);
    border: 1px solid var(--uw-border-default);
    border-radius: var(--uw-radius-md);
    padding: var(--uw-space-1-5) var(--uw-space-3);
    font-family: var(--uw-font-sans);
    font-size: var(--uw-font-size-xs);
  }

  .bulk-actions {
    display: inline-flex;
    gap: var(--uw-space-1);
  }

  .mini-btn {
    border: 1px solid var(--uw-border-subtle);
    background: var(--uw-bg-subtle);
    color: var(--uw-fg-muted);
    border-radius: var(--uw-radius-sm);
    padding: var(--uw-space-1) var(--uw-space-2);
    font-family: var(--uw-font-sans);
    font-size: var(--uw-font-size-xs);
    font-weight: var(--uw-font-weight-medium);
    cursor: pointer;
  }

  .mini-btn:hover {
    color: var(--uw-fg-default);
    border-color: var(--uw-border-strong);
  }

  .chip-groups {
    display: flex;
    flex-direction: column;
    gap: var(--uw-space-1-5);
  }

  .chip-row {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--uw-space-1);
  }

  .chip-label {
    font-size: 0.7rem;
    font-weight: var(--uw-font-weight-semibold);
    color: var(--uw-fg-muted);
    margin-right: var(--uw-space-1);
  }

  .filter-chip {
    border: 1px solid var(--uw-border-subtle);
    background: var(--uw-bg-subtle);
    color: var(--uw-fg-muted);
    border-radius: var(--uw-radius-full);
    padding: 2px var(--uw-space-2);
    font-family: var(--uw-font-sans);
    font-size: 0.72rem;
    font-weight: var(--uw-font-weight-medium);
    cursor: pointer;
  }

  .filter-chip.active {
    background: var(--uw-brand-bg);
    border-color: var(--uw-brand-border);
    color: var(--uw-brand-fg);
    font-weight: var(--uw-font-weight-semibold);
  }

  .items-scroll {
    flex: 1;
    min-height: 8rem;
    overflow-y: auto;
    border: 1px solid var(--uw-border-subtle);
    border-radius: var(--uw-radius-lg);
    background: var(--uw-bg-subtle);
    padding: var(--uw-space-2);
  }

  .empty-msg {
    text-align: center;
    padding: var(--uw-space-6);
    color: var(--uw-fg-muted);
    font-size: var(--uw-font-size-sm);
  }

  .picker-list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: var(--uw-space-1-5);
  }

  .picker-row {
    display: flex;
    align-items: center;
    gap: var(--uw-space-2);
    padding: var(--uw-space-2);
    border-radius: var(--uw-radius-md);
    background: var(--uw-bg-surface);
    border: 1px solid var(--uw-border-subtle);
    opacity: 0.7;
  }

  .picker-row.checked {
    opacity: 1;
    border-color: var(--uw-border-default);
  }

  .check-wrap {
    display: inline-flex;
    align-items: center;
    cursor: pointer;
  }

  .check-wrap input {
    width: 1rem;
    height: 1rem;
    accent-color: var(--uw-brand-solid);
  }

  .row-main {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 3px;
  }

  .name-input {
    width: 100%;
    background: var(--uw-bg-subtle);
    color: var(--uw-fg-default);
    border: 1px solid var(--uw-border-subtle);
    border-radius: var(--uw-radius-sm);
    padding: 3px var(--uw-space-2);
    font-family: var(--uw-font-sans);
    font-size: var(--uw-font-size-xs);
    font-weight: var(--uw-font-weight-medium);
  }

  .name-input:focus {
    outline: none;
    border-color: var(--uw-focus-ring);
  }

  .url-sub {
    font-size: 0.68rem;
    color: var(--uw-fg-muted);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .row-note {
    font-size: 0.68rem;
    color: var(--uw-warning-fg);
  }

  .row-badges {
    display: inline-flex;
    align-items: center;
    gap: var(--uw-space-1);
    flex-shrink: 0;
  }

  .hoster-pill,
  .cat-pill {
    font-size: 0.65rem;
    font-weight: var(--uw-font-weight-bold);
    text-transform: uppercase;
    letter-spacing: var(--uw-letter-spacing-wider);
    padding: 2px 6px;
    border-radius: var(--uw-radius-full);
  }

  .hoster-pill {
    background: var(--uw-info-bg);
    border: 1px solid var(--uw-info-border);
    color: var(--uw-info-fg);
  }

  .cat-pill {
    background: var(--uw-bg-subtle);
    border: 1px solid var(--uw-border-default);
    color: var(--uw-fg-muted);
  }

  .size-pill {
    font-size: 0.72rem;
    color: var(--uw-fg-muted);
    min-width: 4.2rem;
    text-align: right;
  }

  .warnings-box {
    max-height: 5rem;
    overflow-y: auto;
    padding: var(--uw-space-2);
    border-radius: var(--uw-radius-md);
    background: var(--uw-danger-bg);
    border: 1px solid var(--uw-danger-border);
  }

  .warning-line {
    font-size: 0.7rem;
    color: var(--uw-danger-fg);
    word-break: break-word;
  }

  .modal-foot {
    display: flex;
    align-items: center;
    justify-content: flex-end;
    gap: var(--uw-space-2);
    padding-top: var(--uw-space-1);
  }

  .queue-btn {
    border: 0;
    background: var(--uw-brand-solid);
    color: var(--uw-brand-on-solid);
    border-radius: var(--uw-radius-md);
    padding: var(--uw-space-2) var(--uw-space-4);
    font-family: var(--uw-font-sans);
    font-size: var(--uw-font-size-xs);
    font-weight: var(--uw-font-weight-semibold);
    cursor: pointer;
  }

  .queue-btn:hover:not(:disabled) {
    background: var(--uw-brand-solid-hover);
  }

  .queue-btn:disabled,
  .close-btn:disabled,
  .cancel-btn:disabled {
    opacity: 0.55;
    cursor: not-allowed;
  }
</style>
