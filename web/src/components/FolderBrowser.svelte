<script lang="ts">
  import { createFolder, fetchFolders } from '../api/client';
  import { toasts } from '../stores/toasts.svelte';

  const LAST_PATH_KEY = 'drive-downloader:last-dest-path';

  interface Props {
    selectedPath: string;
    topFolders: string[];
  }

  let { selectedPath = $bindable(), topFolders = $bindable() }: Props = $props();

  let currentChildren = $state<string[]>([]);
  let loading = $state(false);
  let loadError = $state('');
  let creatingOpen = $state(false);
  let newFolderName = $state('');
  let creating = $state(false);
  let initialized = false;

  let segments = $derived(
    selectedPath
      .split('/')
      .map((s) => s.trim())
      .filter(Boolean),
  );

  function saveLastPath(path: string) {
    try {
      localStorage.setItem(LAST_PATH_KEY, path);
    } catch {
      // Ignore storage failures in private browsing.
    }
  }

  function readLastPath(): string {
    try {
      return localStorage.getItem(LAST_PATH_KEY) ?? '';
    } catch {
      return '';
    }
  }

  async function loadDir(path: string, refresh = false) {
    loading = true;
    loadError = '';
    try {
      const data = await fetchFolders(path, refresh);
      const list = data.folders ?? [];
      if (!path) {
        topFolders = list;
      }
      currentChildren = list;
      return list;
    } catch (err) {
      loadError = err instanceof Error ? err.message : 'Could not list Drive folders';
      currentChildren = [];
      return null;
    } finally {
      loading = false;
    }
  }

  async function navigate(nextPath: string, refresh = false) {
    const normalized = nextPath
      .split('/')
      .map((s) => s.trim())
      .filter(Boolean)
      .join('/');
    selectedPath = normalized;
    saveLastPath(normalized);
    await loadDir(normalized, refresh);
  }

  async function handleCreateFolder() {
    const cleaned = newFolderName.trim().replace(/^\/+|\/+$/g, '');
    if (!cleaned) return;

    const fullPath = selectedPath ? `${selectedPath}/${cleaned}` : cleaned;
    creating = true;
    try {
      const created = await createFolder(fullPath);
      newFolderName = '';
      creatingOpen = false;
      toasts.push('success', `Created ${created.path}`);
      if (!selectedPath) {
        await loadDir('', true);
      }
      await navigate(created.path, true);
    } catch (err) {
      toasts.push('danger', err instanceof Error ? err.message : 'Failed to create folder');
    } finally {
      creating = false;
    }
  }

  $effect(() => {
    if (initialized) return;
    initialized = true;

    void (async () => {
      const roots = await loadDir('', false);
      if (!roots) return;
      const saved = readLastPath();
      if (saved) {
        const first = saved.split('/')[0];
        if (roots.includes(first)) {
          selectedPath = saved;
          await loadDir(saved, false);
          return;
        }
      }
      if (roots.length > 0 && !selectedPath) {
        selectedPath = roots[0];
        await loadDir(roots[0], false);
      }
    })();
  });
</script>

<div class="browser">
  <div class="browser-head">
    <span class="label">Destination Folder</span>
    <div class="head-actions">
      <button
        type="button"
        class="tool-btn"
        class:active={creatingOpen}
        onclick={() => (creatingOpen = !creatingOpen)}
      >
        + New Folder
      </button>
      <button
        type="button"
        class="tool-btn"
        class:spinning={loading}
        disabled={loading}
        onclick={() => void loadDir(selectedPath, true)}
      >
        <svg viewBox="0 0 20 20" width="13" height="13">
          <path
            d="M16 10a6 6 0 1 1-1.76-4.24M16 4v3.5h-3.5"
            fill="none"
            stroke="currentColor"
            stroke-width="1.75"
            stroke-linecap="round"
            stroke-linejoin="round"
          />
        </svg>
        <span>{loading ? 'Syncing' : 'Refresh'}</span>
      </button>
    </div>
  </div>

  <div class="breadcrumbs mono">
    <button
      type="button"
      class="crumb"
      class:current={segments.length === 0}
      onclick={() => void navigate('')}
    >
      Media
    </button>
    {#each segments as seg, idx (idx)}
      <span class="sep">/</span>
      <button
        type="button"
        class="crumb"
        class:current={idx === segments.length - 1}
        onclick={() => void navigate(segments.slice(0, idx + 1).join('/'))}
      >
        {seg}
      </button>
    {/each}
  </div>

  <div class="create-drawer" class:open={creatingOpen}>
    <div class="create-inner">
      <div class="create-row">
        <input
          type="text"
          bind:value={newFolderName}
          placeholder={selectedPath ? `New folder inside ${selectedPath}/` : 'New folder inside Media/'}
          onkeydown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              void handleCreateFolder();
            }
          }}
        />
        <button
          type="button"
          class="create-submit"
          disabled={creating || !newFolderName.trim()}
          onclick={() => void handleCreateFolder()}
        >
          {creating ? 'Creating...' : 'Create'}
        </button>
      </div>
    </div>
  </div>

  {#if currentChildren.length > 0}
    <div class="folder-chips">
      {#each currentChildren as child (child)}
        {@const childPath = selectedPath ? `${selectedPath}/${child}` : child}
        <button
          type="button"
          class="folder-chip"
          onclick={() => void navigate(childPath)}
        >
          <svg viewBox="0 0 20 20" width="14" height="14">
            <path
              d="M2.5 5.5A1.5 1.5 0 0 1 4 4h3.2l1.6 1.8H16a1.5 1.5 0 0 1 1.5 1.5v7.2A1.5 1.5 0 0 1 16 16H4a1.5 1.5 0 0 1-1.5-1.5v-9Z"
              fill="none"
              stroke="currentColor"
              stroke-width="1.5"
              stroke-linejoin="round"
            />
          </svg>
          <span>{child}</span>
        </button>
      {/each}
    </div>
  {:else if !loading && !loadError && segments.length > 0}
    <p class="leaf-note">No subfolders here — files will upload straight into <code>{selectedPath}/</code>.</p>
  {/if}

  {#if loadError}
    <div class="manual-fallback">
      <input
        type="text"
        bind:value={selectedPath}
        placeholder="Enter Drive path (e.g. Movies or TVShows/Severance)"
        required
      />
      <p class="folder-hint">{loadError} — enter a folder path manually above.</p>
    </div>
  {/if}
</div>

<style>
  .browser {
    display: flex;
    flex-direction: column;
    gap: var(--uw-space-2);
  }

  .browser-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--uw-space-2);
  }

  .label {
    font-size: var(--uw-font-size-xs);
    font-weight: var(--uw-font-weight-semibold);
    color: var(--uw-fg-muted);
  }

  .head-actions {
    display: inline-flex;
    align-items: center;
    gap: var(--uw-space-2);
  }

  .tool-btn {
    display: inline-flex;
    align-items: center;
    gap: var(--uw-space-1);
    border: 1px solid var(--uw-border-subtle);
    background: var(--uw-bg-subtle);
    color: var(--uw-fg-muted);
    font-family: var(--uw-font-sans);
    font-size: var(--uw-font-size-xs);
    font-weight: var(--uw-font-weight-semibold);
    cursor: pointer;
    padding: 2px var(--uw-space-2);
    border-radius: var(--uw-radius-md);
    transition:
      color var(--uw-duration-fast) var(--uw-easing-standard),
      border-color var(--uw-duration-fast) var(--uw-easing-standard),
      background-color var(--uw-duration-fast) var(--uw-easing-standard);
  }

  .tool-btn:hover:not(:disabled) {
    color: var(--uw-fg-default);
    border-color: var(--uw-border-strong);
    background: var(--uw-bg-surface-hover);
  }

  .tool-btn.active {
    background: var(--uw-brand-bg);
    border-color: var(--uw-brand-border);
    color: var(--uw-brand-fg);
  }

  .tool-btn.spinning svg {
    animation: spin 0.9s linear infinite;
  }

  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }

  .breadcrumbs {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--uw-space-1);
    padding: var(--uw-space-2) var(--uw-space-3);
    background: var(--uw-bg-subtle);
    border: 1px solid var(--uw-border-subtle);
    border-radius: var(--uw-radius-md);
    font-size: var(--uw-font-size-xs);
  }

  .crumb {
    border: 0;
    background: transparent;
    color: var(--uw-fg-muted);
    font-family: inherit;
    font-size: inherit;
    padding: 1px var(--uw-space-1);
    border-radius: var(--uw-radius-xs);
    cursor: pointer;
    transition:
      color var(--uw-duration-fast) var(--uw-easing-standard),
      background-color var(--uw-duration-fast) var(--uw-easing-standard);
  }

  .crumb:hover {
    color: var(--uw-fg-default);
    background: var(--uw-bg-surface-hover);
  }

  .crumb.current {
    color: var(--uw-brand-fg);
    font-weight: var(--uw-font-weight-semibold);
  }

  .sep {
    color: var(--uw-border-strong);
  }

  .create-drawer {
    display: grid;
    grid-template-rows: 0fr;
    opacity: 0;
    transition:
      grid-template-rows var(--uw-duration-normal) var(--uw-easing-emphasized),
      opacity var(--uw-duration-fast) var(--uw-easing-standard);
  }

  .create-drawer.open {
    grid-template-rows: 1fr;
    opacity: 1;
  }

  .create-inner {
    overflow: hidden;
  }

  .create-row {
    display: flex;
    gap: var(--uw-space-2);
    padding-top: var(--uw-space-1);
  }

  .create-row input,
  .manual-fallback input {
    flex: 1;
    width: 100%;
    background: var(--uw-bg-subtle);
    color: var(--uw-fg-default);
    border: 1px solid var(--uw-border-default);
    border-radius: var(--uw-radius-md);
    padding: var(--uw-space-2) var(--uw-space-3);
    font-family: var(--uw-font-sans);
    font-size: var(--uw-font-size-xs);
  }

  .create-row input:focus,
  .manual-fallback input:focus {
    outline: none;
    border-color: var(--uw-focus-ring);
    box-shadow: 0 0 0 3px color-mix(in oklch, var(--uw-brand-solid) 18%, transparent);
  }

  .create-submit {
    border: 0;
    background: var(--uw-brand-solid);
    color: var(--uw-brand-on-solid);
    border-radius: var(--uw-radius-md);
    padding: 0 var(--uw-space-3);
    font-family: var(--uw-font-sans);
    font-size: var(--uw-font-size-xs);
    font-weight: var(--uw-font-weight-semibold);
    cursor: pointer;
  }

  .create-submit:hover:not(:disabled) {
    background: var(--uw-brand-solid-hover);
  }

  .create-submit:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .folder-chips {
    display: flex;
    flex-wrap: wrap;
    gap: var(--uw-space-2);
  }

  .folder-chip {
    display: inline-flex;
    align-items: center;
    gap: var(--uw-space-1);
    padding: var(--uw-space-1) var(--uw-space-3);
    background: var(--uw-bg-subtle);
    border: 1px solid var(--uw-border-default);
    border-radius: var(--uw-radius-lg);
    color: var(--uw-fg-default);
    font-family: var(--uw-font-sans);
    font-size: var(--uw-font-size-xs);
    font-weight: var(--uw-font-weight-semibold);
    cursor: pointer;
    transition:
      background-color var(--uw-duration-fast) var(--uw-easing-standard),
      border-color var(--uw-duration-fast) var(--uw-easing-standard),
      transform var(--uw-duration-fast) var(--uw-easing-standard);
  }

  .folder-chip:hover {
    border-color: var(--uw-brand-border);
    background: var(--uw-brand-bg);
    color: var(--uw-brand-fg);
    transform: translateY(-1px);
  }

  .leaf-note {
    font-size: var(--uw-font-size-xs);
    color: var(--uw-fg-muted);
  }

  .leaf-note code {
    color: var(--uw-brand-fg);
  }

  .manual-fallback {
    display: flex;
    flex-direction: column;
    gap: var(--uw-space-2);
  }

  .folder-hint {
    font-size: var(--uw-font-size-xs);
    color: var(--uw-warning-fg);
    background: var(--uw-warning-bg);
    border: 1px solid var(--uw-warning-border);
    border-radius: var(--uw-radius-md);
    padding: var(--uw-space-2) var(--uw-space-3);
  }
</style>
