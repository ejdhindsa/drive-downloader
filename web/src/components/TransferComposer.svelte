<script lang="ts">
  import { enqueueJobs } from '../api/client';
  import type { ConflictPolicy, CustomHeader, TransferMode } from '../api/types';
  import { toasts } from '../stores/toasts.svelte';
  import { transferStore } from '../stores/transferStore.svelte';
  import { looksLikeCurlCommand, parseCurlCommand } from '../utils/curlParser';
  import { suggestMediaDestination } from '../utils/mediaHints';
  import FolderBrowser from './FolderBrowser.svelte';
  import HeadersEditor from './HeadersEditor.svelte';

  const ADVANCED_STORAGE_KEY = 'drive-downloader:composer-advanced';

  function readInitialAdvanced(): boolean {
    try {
      return localStorage.getItem(ADVANCED_STORAGE_KEY) === '1';
    } catch {
      return false;
    }
  }

  let showAdvanced = $state(readInitialAdvanced());
  let rawUrls = $state('');
  let dragging = $state(false);
  let selectedPath = $state('');
  let topFolders = $state<string[]>([]);
  let newSubfolder = $state('');
  let customFilename = $state('');
  let mode = $state<TransferMode>('staged');
  let conflictPolicy = $state<ConflictPolicy>('skip');
  let autoExtract = $state(true);
  let archivePassword = $state('');
  let autoRefreshJellyfin = $state(true);
  let headers = $state<CustomHeader[]>([]);
  let submitting = $state(false);

  $effect(() => {
    try {
      localStorage.setItem(ADVANCED_STORAGE_KEY, showAdvanced ? '1' : '0');
    } catch {
      // Ignore storage quota or private-mode restrictions.
    }
  });

  let parsedUrls = $derived(
    rawUrls
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean),
  );

  let uniqueUrlCount = $derived(new Set(parsedUrls).size);
  let hasDuplicates = $derived(parsedUrls.length > uniqueUrlCount);
  let isBatch = $derived(parsedUrls.length > 1);
  let isDirect = $derived(mode === 'direct');

  let activeHeaderCount = $derived(
    isDirect ? 0 : headers.filter((h) => h.name.trim() || h.value.trim()).length,
  );

  let pathParts = $derived(
    selectedPath
      .split('/')
      .map((s) => s.trim())
      .filter(Boolean),
  );

  let topFolder = $derived(pathParts[0] ?? '');
  let nestedSubfolder = $derived(pathParts.slice(1).join('/'));

  let suggestion = $derived(suggestMediaDestination(parsedUrls, topFolders));

  let multipartSummary = $derived.by(() => {
    if (isDirect || !autoExtract || parsedUrls.length < 2) return null;
    const groups = new Map<string, Set<number>>();
    for (const raw of parsedUrls) {
      let name = '';
      try {
        name = decodeURIComponent(new URL(raw).pathname.split('/').filter(Boolean).pop() ?? '');
      } catch {
        continue;
      }
      let key: string | null = null;
      let order = 0;
      const m1 = /^(.+)\.part(\d+)\.rar$/i.exec(name);
      const m2 = /^(.+\.(?:7z|zip|rar))\.(\d{3,})$/i.exec(name);
      const m3 = /^(.+)\.(rar|r\d{2,3})$/i.exec(name);
      const m4 = /^(.+)\.(zip|z\d{2,3})$/i.exec(name);
      if (m1) {
        key = `rar-part:${m1[1].toLowerCase()}`;
        order = Number.parseInt(m1[2], 10);
      } else if (m2) {
        key = `split-num:${m2[1].toLowerCase()}`;
        order = Number.parseInt(m2[2], 10);
      } else if (m3) {
        key = `rar-legacy:${m3[1].toLowerCase()}`;
        order = m3[2].toLowerCase() === 'rar' ? -1 : Number.parseInt(m3[2].slice(1), 10);
      } else if (m4) {
        key = `zip-split:${m4[1].toLowerCase()}`;
        order = m4[2].toLowerCase() === 'zip' ? -1 : Number.parseInt(m4[2].slice(1), 10);
      }
      if (!key) continue;
      let set = groups.get(key);
      if (!set) {
        set = new Set();
        groups.set(key, set);
      }
      set.add(order);
    }

    let groupCount = 0;
    let totalParts = 0;
    for (const parts of groups.values()) {
      if (parts.size >= 2) {
        groupCount += 1;
        totalParts += parts.size;
      }
    }
    return groupCount > 0 ? { groupCount, totalParts } : null;
  });

  let destinationPreview = $derived.by(() => {
    const root = transferStore.config?.rcloneRoot || 'gdrive:Media';
    const cleanNewSub = newSubfolder.trim().replace(/^\/+|\/+$/g, '');
    const parts = [topFolder, nestedSubfolder, cleanNewSub].filter(Boolean);
    const base = parts.length > 0 ? `${root}/${parts.join('/')}` : root;
    const fileSuffix = !isBatch && customFilename.trim() ? `/${customFilename.trim()}` : '/';
    return `${base}${fileSuffix}`;
  });

  function applySuggestion() {
    if (!suggestion) return;
    selectedPath = suggestion.folder;
    newSubfolder = suggestion.subfolder;
    toasts.push('info', `Target set to ${suggestion.label}`);
  }

  function extractUrlsFromText(text: string): string[] {
    const matches = text.match(/https?:\/\/[^\s"'<>]+/gi) ?? [];
    return Array.from(new Set(matches.map((u) => u.replace(/[),.;]+$/, ''))));
  }

  function applyCurlImport(rawText: string): boolean {
    const parsed = parseCurlCommand(rawText);
    if (!parsed) return false;
    rawUrls = parsed.url;
    if (parsed.headers.length > 0) {
      headers = parsed.headers;
      mode = 'staged';
      showAdvanced = true;
    }
    toasts.push(
      'success',
      `Imported cURL (${parsed.headers.length} ${parsed.headers.length === 1 ? 'header' : 'headers'}).`,
    );
    return true;
  }

  async function handlePasteClipboard() {
    try {
      const clip = (await navigator.clipboard.readText()).trim();
      if (!clip) {
        toasts.push('info', 'Clipboard is empty.');
        return;
      }
      if (applyCurlImport(clip)) return;
      const extracted = extractUrlsFromText(clip);
      const additions = extracted.length > 0 ? extracted : [clip];
      const merged = Array.from(new Set([...parsedUrls, ...additions]));
      rawUrls = merged.join('\n');
    } catch {
      toasts.push('danger', 'Clipboard permission denied—paste with Ctrl+V.');
    }
  }

  function handleTextareaPaste(event: ClipboardEvent) {
    const pasted = event.clipboardData?.getData('text/plain') ?? '';
    if (looksLikeCurlCommand(pasted)) {
      event.preventDefault();
      applyCurlImport(pasted);
    }
  }

  function handleCleanUrls() {
    const extracted = extractUrlsFromText(rawUrls);
    if (extracted.length > 0) {
      rawUrls = extracted.join('\n');
      toasts.push('info', `Kept ${extracted.length} unique URL(s).`);
    } else {
      rawUrls = Array.from(new Set(parsedUrls)).join('\n');
    }
  }

  async function handleDrop(event: DragEvent) {
    event.preventDefault();
    dragging = false;

    const file = event.dataTransfer?.files?.[0];
    if (file) {
      if (file.size > 512 * 1024) {
        toasts.push('danger', 'Dropped file is too large (max 512 KB text list).');
        return;
      }
      const text = await file.text();
      const extracted = extractUrlsFromText(text);
      if (extracted.length === 0) {
        toasts.push('info', 'No http(s) URLs found in dropped file.');
        return;
      }
      rawUrls = Array.from(new Set([...parsedUrls, ...extracted])).join('\n');
      toasts.push('success', `Imported ${extracted.length} URL(s) from ${file.name}.`);
      return;
    }

    const droppedText = event.dataTransfer?.getData('text/plain')?.trim();
    if (droppedText) {
      const extracted = extractUrlsFromText(droppedText);
      const next = extracted.length > 0 ? extracted : [droppedText];
      rawUrls = Array.from(new Set([...parsedUrls, ...next])).join('\n');
    }
  }

  function handleKeydown(event: KeyboardEvent) {
    if ((event.ctrlKey || event.metaKey) && event.key === 'Enter' && !submitting) {
      event.preventDefault();
      void handleSubmit();
    }
  }

  async function handleSubmit(event?: SubmitEvent) {
    event?.preventDefault();
    if (parsedUrls.length === 0) {
      toasts.push('danger', 'Paste at least one http:// or https:// URL.');
      return;
    }
    if (!topFolder) {
      toasts.push('danger', 'Select or create a destination Drive folder inside Media/.');
      return;
    }

    const activeHeaders = isDirect
      ? []
      : headers
          .map((h) => ({ name: h.name.trim(), value: h.value.trim() }))
          .filter((h) => h.name || h.value);

    submitting = true;
    try {
      const jobs = await enqueueJobs({
        urls: parsedUrls,
        folder: topFolder,
        existingSubfolder: nestedSubfolder,
        newSubfolder: newSubfolder.trim(),
        customFilename: isBatch ? '' : customFilename.trim(),
        mode,
        conflictPolicy,
        autoExtract: isDirect ? false : autoExtract,
        archivePassword: !isDirect && autoExtract && archivePassword ? archivePassword : undefined,
        autoRefreshJellyfin: transferStore.hasMediaRefresh ? autoRefreshJellyfin : false,
        headers: activeHeaders,
      });

      rawUrls = '';
      customFilename = '';
      archivePassword = '';
      toasts.push(
        'success',
        `Queued ${jobs.length} ${jobs.length === 1 ? 'transfer' : 'transfers'}.`,
      );
    } catch (err) {
      toasts.push('danger', err instanceof Error ? err.message : 'Failed to queue download');
    } finally {
      submitting = false;
    }
  }
</script>

<section
  class="composer-card"
  class:dragging
  ondragover={(e) => {
    e.preventDefault();
    dragging = true;
  }}
  ondragleave={(e) => {
    if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
      dragging = false;
    }
  }}
  ondrop={handleDrop}
>
  <div class="accent-strip"></div>

  <div class="card-head">
    <div>
      <h2>New Transfer</h2>
      <p class="card-sub">Drop links or a `.txt` list, pick a target, and ship</p>
    </div>

    <div class="mode-switch">
      <span class="switch-thumb" class:right={showAdvanced}></span>
      <button
        type="button"
        class="switch-btn"
        class:active={!showAdvanced}
        onclick={() => (showAdvanced = false)}
      >
        Simple
      </button>
      <button
        type="button"
        class="switch-btn"
        class:active={showAdvanced}
        onclick={() => (showAdvanced = true)}
      >
        Advanced
      </button>
    </div>
  </div>

  <form class="form" onsubmit={handleSubmit}>
    <div class="url-well" class:has-value={parsedUrls.length > 0}>
      <div class="well-bar">
        <label for="urls-input">Download URL(s)</label>
        <div class="well-actions">
          <span class="url-count mono" class:batch={isBatch}>
            {parsedUrls.length === 0
              ? 'Empty'
              : parsedUrls.length === 1
                ? '1 URL'
                : `${parsedUrls.length} URLs`}
          </span>
          <button type="button" class="mini-btn" onclick={handlePasteClipboard}>Paste</button>
          {#if hasDuplicates || rawUrls.includes(' ')}
            <button type="button" class="mini-btn accent" onclick={handleCleanUrls}>Clean</button>
          {/if}
          {#if rawUrls.length > 0}
            <button type="button" class="mini-btn" onclick={() => (rawUrls = '')}>Clear</button>
          {/if}
        </div>
      </div>

      <textarea
        id="urls-input"
        bind:value={rawUrls}
        onpaste={handleTextareaPaste}
        onkeydown={handleKeydown}
        placeholder="Paste URLs (one per line) or a DevTools 'Copy as cURL' command"
        rows="4"
        required
      ></textarea>

      {#if dragging}
        <div class="drop-overlay">
          <span>Drop URLs or a `.txt` link list</span>
        </div>
      {/if}
    </div>

    {#if multipartSummary}
      <div class="multipart-banner">
        <span class="multipart-tag">Multi-part</span>
        <span class="multipart-text">
          {multipartSummary.totalParts} archive parts detected — will download & extract together as
          {multipartSummary.groupCount}
          {multipartSummary.groupCount === 1 ? 'transfer' : 'transfers'}
        </span>
      </div>
    {/if}

    {#if suggestion}
      <button type="button" class="hint-banner" onclick={applySuggestion}>
        <span class="hint-tag">Smart path</span>
        <span class="hint-path mono">{suggestion.label}</span>
        <span class="hint-apply">Apply</span>
      </button>
    {/if}

    <FolderBrowser bind:selectedPath bind:topFolders />

    <div class="dest-ribbon mono">
      <span class="dest-dot"></span>
      <span class="dest-path">{destinationPreview}</span>
    </div>

    {#if !showAdvanced}
      <div class="quick-summary">
        <button type="button" class="summary-chip" onclick={() => (showAdvanced = true)}>
          {isDirect ? 'Direct RAM stream' : 'Staged 16x'}
        </button>
        {#if !isDirect && autoExtract}
          <button type="button" class="summary-chip" onclick={() => (showAdvanced = true)}>
            Auto-extract
          </button>
        {/if}
        {#if transferStore.hasMediaRefresh && autoRefreshJellyfin}
          <button type="button" class="summary-chip" onclick={() => (showAdvanced = true)}>
            Auto-refresh media
          </button>
        {/if}
        {#if newSubfolder.trim()}
          <button type="button" class="summary-chip accent" onclick={() => (showAdvanced = true)}>
            +{newSubfolder.trim()}
          </button>
        {/if}
        {#if !isBatch && customFilename.trim()}
          <button type="button" class="summary-chip accent" onclick={() => (showAdvanced = true)}>
            Rename: {customFilename.trim()}
          </button>
        {/if}
        {#if activeHeaderCount > 0}
          <button type="button" class="summary-chip accent" onclick={() => (showAdvanced = true)}>
            {activeHeaderCount} {activeHeaderCount === 1 ? 'header' : 'headers'}
          </button>
        {/if}
        {#if conflictPolicy !== 'skip'}
          <button type="button" class="summary-chip accent" onclick={() => (showAdvanced = true)}>
            Conflict: {conflictPolicy}
          </button>
        {/if}
        {#if archivePassword}
          <button type="button" class="summary-chip accent" onclick={() => (showAdvanced = true)}>
            Password set
          </button>
        {/if}
      </div>
    {/if}

    <div class="advanced-drawer" class:open={showAdvanced}>
      <div class="advanced-inner">
        <div class="advanced-content">
          <div class="split-grid">
            <div class="field">
              <label for="new-subfolder">New Subfolder</label>
              <input
                id="new-subfolder"
                type="text"
                bind:value={newSubfolder}
                placeholder="e.g. Show Name/Season 01"
              />
            </div>

            <div class="field">
              <label for="custom-filename">Custom Filename</label>
              <input
                id="custom-filename"
                type="text"
                bind:value={customFilename}
                disabled={isBatch}
                placeholder={isBatch ? 'Disabled for batches' : 'Auto-detect from URL'}
              />
            </div>
          </div>

          <div class="field">
            <span class="field-label">Transfer Engine</span>
            <div class="split-grid">
              <label class="mode-card" class:selected={mode === 'staged'}>
                <input type="radio" name="mode" value="staged" bind:group={mode} />
                <span class="radio-dot"></span>
                <div class="mode-copy">
                  <div class="mode-head">
                    <span class="mode-title">Staged 16x</span>
                    <span class="mode-tag mono">aria2c</span>
                  </div>
                  <p class="mode-desc">Multi-stream to NVMe, extracts archives, moves &amp; cleans up.</p>
                </div>
              </label>

              <label class="mode-card" class:selected={mode === 'direct'}>
                <input type="radio" name="mode" value="direct" bind:group={mode} />
                <span class="radio-dot"></span>
                <div class="mode-copy">
                  <div class="mode-head">
                    <span class="mode-title">Direct Stream</span>
                    <span class="mode-tag mono">RAM</span>
                  </div>
                  <p class="mode-desc">Zero VPS disk usage via rclone copyurl. Single stream only.</p>
                </div>
              </label>
            </div>
          </div>

          <div class="field">
            <span class="field-label">If File Already Exists on Drive</span>
            <div class="policy-row">
              {#each [
                { id: 'skip', label: 'Skip & Warn' },
                { id: 'rename', label: 'Auto-rename' },
                { id: 'overwrite', label: 'Overwrite' },
              ] as opt (opt.id)}
                <button
                  type="button"
                  class="policy-btn"
                  class:selected={conflictPolicy === opt.id}
                  onclick={() => (conflictPolicy = opt.id as ConflictPolicy)}
                >
                  {opt.label}
                </button>
              {/each}
            </div>
          </div>

          <div class="toggles">
            <label class="switch-row" class:disabled={isDirect}>
              <span class="switch-label">
                <strong>Auto-extract archives</strong>
                <small>.zip, .7z, .tar.*, .rar before uploading</small>
              </span>
              <span class="pill-toggle">
                <input type="checkbox" bind:checked={autoExtract} disabled={isDirect} />
                <span class="pill-track"><span class="pill-knob"></span></span>
              </span>
            </label>

            {#if !isDirect && autoExtract}
              <div class="field">
                <label for="archive-password">Archive Password (optional, never saved)</label>
                <input
                  id="archive-password"
                  type="password"
                  autocomplete="off"
                  bind:value={archivePassword}
                  placeholder="Leave empty for unencrypted archives"
                />
              </div>
            {/if}

            {#if transferStore.hasMediaRefresh}
              <label class="switch-row">
                <span class="switch-label">
                  <strong>Auto-refresh library</strong>
                  <small>Ping Jellyfin &amp; rclone VFS when complete</small>
                </span>
                <span class="pill-toggle">
                  <input type="checkbox" bind:checked={autoRefreshJellyfin} />
                  <span class="pill-track"><span class="pill-knob"></span></span>
                </span>
              </label>
            {/if}
          </div>

          <HeadersEditor bind:headers disabled={isDirect} />
        </div>
      </div>
    </div>

    <div class="form-footer">
      <span class="queue-meta">
        {#if transferStore.config}
          Max {transferStore.config.maxConcurrentJobs} concurrent • <kbd>Ctrl</kbd>+<kbd>Enter</kbd>
        {:else}
          <kbd>Ctrl</kbd>+<kbd>Enter</kbd> to queue
        {/if}
      </span>

      <button type="submit" class="submit-btn" disabled={submitting}>
        {#if submitting}
          <span class="btn-spinner"></span>
          <span>Queueing...</span>
        {:else if isBatch}
          <span>Queue {parsedUrls.length} Downloads</span>
        {:else}
          <span>Queue Download</span>
        {/if}
      </button>
    </div>
  </form>
</section>

<style>
  .composer-card {
    position: relative;
    overflow: hidden;
    background: var(--uw-bg-surface);
    border: 1px solid var(--uw-border-subtle);
    border-radius: var(--uw-radius-xl);
    padding: var(--uw-space-5);
    box-shadow: var(--uw-shadow-md);
    transition:
      border-color var(--uw-duration-fast) var(--uw-easing-standard),
      box-shadow var(--uw-duration-normal) var(--uw-easing-standard);
  }

  .composer-card.dragging {
    border-color: var(--uw-brand-solid);
    box-shadow:
      var(--uw-shadow-md),
      0 0 0 3px color-mix(in oklch, var(--uw-brand-solid) 24%, transparent);
  }

  .accent-strip {
    position: absolute;
    inset: 0 0 auto 0;
    height: 3px;
    background: linear-gradient(
      90deg,
      var(--uw-brand-solid) 0%,
      color-mix(in oklch, var(--uw-brand-solid) 55%, var(--uw-info-solid)) 55%,
      transparent 100%
    );
  }

  .card-head {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: var(--uw-space-3);
    margin-bottom: var(--uw-space-4);
  }

  .card-head h2 {
    font-size: var(--uw-font-size-lg);
    font-weight: var(--uw-font-weight-bold);
    line-height: var(--uw-line-height-tight);
  }

  .card-sub {
    color: var(--uw-fg-muted);
    font-size: var(--uw-font-size-xs);
    margin-top: var(--uw-space-0-5);
  }

  .mode-switch {
    position: relative;
    display: grid;
    grid-template-columns: repeat(2, 1fr);
    padding: 3px;
    background: var(--uw-bg-subtle);
    border: 1px solid var(--uw-border-subtle);
    border-radius: var(--uw-radius-full);
    min-width: 11rem;
  }

  .switch-thumb {
    position: absolute;
    top: 3px;
    left: 3px;
    width: calc(50% - 3px);
    height: calc(100% - 6px);
    border-radius: var(--uw-radius-full);
    background: var(--uw-brand-solid);
    box-shadow: var(--uw-shadow-sm);
    transition: transform var(--uw-duration-normal) var(--uw-easing-emphasized);
  }

  .switch-thumb.right {
    transform: translateX(100%);
  }

  .switch-btn {
    position: relative;
    z-index: 1;
    border: 0;
    background: transparent;
    color: var(--uw-fg-muted);
    font-family: var(--uw-font-sans);
    font-size: var(--uw-font-size-xs);
    font-weight: var(--uw-font-weight-semibold);
    padding: var(--uw-space-1) var(--uw-space-3);
    border-radius: var(--uw-radius-full);
    cursor: pointer;
    transition: color var(--uw-duration-fast) var(--uw-easing-standard);
  }

  .switch-btn.active {
    color: var(--uw-brand-on-solid);
  }

  .form {
    display: flex;
    flex-direction: column;
    gap: var(--uw-space-4);
  }

  .url-well {
    position: relative;
    background: var(--uw-bg-subtle);
    border: 1px solid var(--uw-border-default);
    border-radius: var(--uw-radius-lg);
    overflow: hidden;
    transition:
      border-color var(--uw-duration-fast) var(--uw-easing-standard),
      box-shadow var(--uw-duration-fast) var(--uw-easing-standard);
  }

  .url-well:focus-within {
    border-color: var(--uw-focus-ring);
    box-shadow: 0 0 0 3px color-mix(in oklch, var(--uw-brand-solid) 18%, transparent);
  }

  .well-bar {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: var(--uw-space-2);
    padding: var(--uw-space-2) var(--uw-space-3);
    border-bottom: 1px solid var(--uw-border-subtle);
    background: color-mix(in oklch, var(--uw-bg-surface) 55%, var(--uw-bg-subtle));
  }

  .well-actions {
    display: inline-flex;
    align-items: center;
    gap: var(--uw-space-1);
  }

  .url-count {
    font-size: var(--uw-font-size-xs);
    color: var(--uw-fg-muted);
    margin-right: var(--uw-space-1);
  }

  .url-count.batch {
    color: var(--uw-brand-fg);
    font-weight: var(--uw-font-weight-semibold);
  }

  .mini-btn {
    border: 1px solid var(--uw-border-subtle);
    background: var(--uw-bg-surface);
    color: var(--uw-fg-muted);
    border-radius: var(--uw-radius-sm);
    padding: var(--uw-space-0-5) var(--uw-space-2);
    font-family: var(--uw-font-sans);
    font-size: var(--uw-font-size-xs);
    font-weight: var(--uw-font-weight-medium);
    cursor: pointer;
    transition:
      color var(--uw-duration-fast) var(--uw-easing-standard),
      background-color var(--uw-duration-fast) var(--uw-easing-standard),
      border-color var(--uw-duration-fast) var(--uw-easing-standard);
  }

  .mini-btn:hover {
    color: var(--uw-fg-default);
    border-color: var(--uw-border-strong);
    background: var(--uw-bg-surface-hover);
  }

  .mini-btn.accent {
    background: var(--uw-brand-bg);
    border-color: var(--uw-brand-border);
    color: var(--uw-brand-fg);
  }

  .url-well textarea {
    display: block;
    width: 100%;
    border: 0;
    background: transparent;
    color: var(--uw-fg-default);
    padding: var(--uw-space-3);
    font-family: var(--uw-font-mono);
    font-size: var(--uw-font-size-xs);
    line-height: var(--uw-line-height-normal);
    resize: vertical;
    min-height: 5.5rem;
  }

  .url-well textarea:focus {
    outline: none;
  }

  .drop-overlay {
    position: absolute;
    inset: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    background: color-mix(in oklch, var(--uw-brand-bg) 88%, transparent);
    backdrop-filter: blur(2px);
    color: var(--uw-brand-fg);
    font-size: var(--uw-font-size-sm);
    font-weight: var(--uw-font-weight-semibold);
    pointer-events: none;
  }

  .multipart-banner {
    display: flex;
    align-items: center;
    gap: var(--uw-space-2);
    padding: var(--uw-space-2) var(--uw-space-3);
    border-radius: var(--uw-radius-md);
    border: 1px solid var(--uw-warning-border);
    background: var(--uw-warning-bg);
    color: var(--uw-warning-fg);
    font-size: var(--uw-font-size-xs);
    animation: panelIn var(--uw-duration-normal) var(--uw-easing-emphasized);
  }

  .multipart-tag {
    font-size: 0.68rem;
    font-weight: var(--uw-font-weight-bold);
    text-transform: uppercase;
    letter-spacing: var(--uw-letter-spacing-wider);
    padding: 2px var(--uw-space-2);
    border-radius: var(--uw-radius-full);
    background: color-mix(in oklch, var(--uw-warning-solid) 20%, transparent);
    flex-shrink: 0;
  }

  .multipart-text {
    line-height: var(--uw-line-height-snug);
  }

  .hint-banner {
    display: flex;
    align-items: center;
    gap: var(--uw-space-2);
    width: 100%;
    padding: var(--uw-space-2) var(--uw-space-3);
    background: var(--uw-info-bg);
    border: 1px solid var(--uw-info-border);
    border-radius: var(--uw-radius-lg);
    color: var(--uw-info-fg);
    font-family: var(--uw-font-sans);
    font-size: var(--uw-font-size-xs);
    cursor: pointer;
    text-align: left;
    transition: background-color var(--uw-duration-fast) var(--uw-easing-standard);
  }

  .hint-banner:hover {
    background: var(--uw-info-bg-hover);
  }

  .hint-tag {
    font-weight: var(--uw-font-weight-bold);
    text-transform: uppercase;
    letter-spacing: var(--uw-letter-spacing-wider);
    font-size: 0.65rem;
    flex-shrink: 0;
  }

  .hint-path {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .hint-apply {
    font-weight: var(--uw-font-weight-semibold);
    flex-shrink: 0;
  }

  .field {
    display: flex;
    flex-direction: column;
    gap: var(--uw-space-2);
  }

  label,
  .field-label {
    font-size: var(--uw-font-size-xs);
    font-weight: var(--uw-font-weight-semibold);
    color: var(--uw-fg-muted);
  }

  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }

  input[type='text'],
  input[type='password'] {
    width: 100%;
    background: var(--uw-bg-subtle);
    color: var(--uw-fg-default);
    border: 1px solid var(--uw-border-default);
    border-radius: var(--uw-radius-md);
    padding: var(--uw-space-2) var(--uw-space-3);
    font-family: var(--uw-font-sans);
    font-size: var(--uw-font-size-sm);
    transition:
      border-color var(--uw-duration-fast) var(--uw-easing-standard),
      box-shadow var(--uw-duration-fast) var(--uw-easing-standard);
  }

  input[type='text']:focus,
  input[type='password']:focus {
    outline: none;
    border-color: var(--uw-focus-ring);
    box-shadow: 0 0 0 3px color-mix(in oklch, var(--uw-brand-solid) 18%, transparent);
  }

  .policy-row {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: var(--uw-space-2);
  }

  .policy-btn {
    border: 1px solid var(--uw-border-default);
    background: var(--uw-bg-subtle);
    color: var(--uw-fg-muted);
    border-radius: var(--uw-radius-md);
    padding: var(--uw-space-2);
    font-family: var(--uw-font-sans);
    font-size: var(--uw-font-size-xs);
    font-weight: var(--uw-font-weight-semibold);
    cursor: pointer;
    transition:
      background-color var(--uw-duration-fast) var(--uw-easing-standard),
      border-color var(--uw-duration-fast) var(--uw-easing-standard),
      color var(--uw-duration-fast) var(--uw-easing-standard);
  }

  .policy-btn:hover {
    color: var(--uw-fg-default);
    border-color: var(--uw-border-strong);
  }

  .policy-btn.selected {
    background: var(--uw-brand-bg);
    border-color: var(--uw-brand-solid);
    color: var(--uw-brand-fg);
  }

  input:disabled {
    opacity: 0.55;
    cursor: not-allowed;
  }

  .dest-ribbon {
    display: flex;
    align-items: center;
    gap: var(--uw-space-2);
    padding: var(--uw-space-2) var(--uw-space-3);
    border-radius: var(--uw-radius-lg);
    background: var(--uw-brand-bg);
    border: 1px solid var(--uw-brand-border);
    color: var(--uw-brand-fg);
    font-size: var(--uw-font-size-xs);
  }

  .dest-dot {
    width: 0.45rem;
    height: 0.45rem;
    border-radius: var(--uw-radius-full);
    background: var(--uw-brand-solid);
    flex-shrink: 0;
  }

  .dest-path {
    word-break: break-all;
  }

  .quick-summary {
    display: flex;
    flex-wrap: wrap;
    gap: var(--uw-space-2);
  }

  .summary-chip {
    border: 1px solid var(--uw-border-subtle);
    background: var(--uw-bg-subtle);
    color: var(--uw-fg-muted);
    border-radius: var(--uw-radius-full);
    padding: var(--uw-space-0-5) var(--uw-space-3);
    font-family: var(--uw-font-sans);
    font-size: var(--uw-font-size-xs);
    font-weight: var(--uw-font-weight-medium);
    cursor: pointer;
    transition:
      border-color var(--uw-duration-fast) var(--uw-easing-standard),
      color var(--uw-duration-fast) var(--uw-easing-standard);
  }

  .summary-chip:hover {
    border-color: var(--uw-border-strong);
    color: var(--uw-fg-default);
  }

  .summary-chip.accent {
    background: var(--uw-info-bg);
    border-color: var(--uw-info-border);
    color: var(--uw-info-fg);
  }

  .advanced-drawer {
    display: grid;
    grid-template-rows: 0fr;
    opacity: 0;
    transform: translateY(-6px);
    transition:
      grid-template-rows var(--uw-duration-slow) var(--uw-easing-emphasized),
      opacity var(--uw-duration-normal) var(--uw-easing-standard),
      transform var(--uw-duration-normal) var(--uw-easing-emphasized);
    margin-top: calc(var(--uw-space-4) * -1);
  }

  .advanced-drawer.open {
    grid-template-rows: 1fr;
    opacity: 1;
    transform: translateY(0);
    margin-top: 0;
  }

  .advanced-inner {
    overflow: hidden;
  }

  .advanced-content {
    display: flex;
    flex-direction: column;
    gap: var(--uw-space-4);
    padding-top: var(--uw-space-4);
    border-top: 1px dashed var(--uw-border-subtle);
  }

  .split-grid {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: var(--uw-space-3);
  }

  @media (max-width: 36rem) {
    .split-grid {
      grid-template-columns: 1fr;
    }
  }

  .mode-card {
    position: relative;
    display: flex;
    align-items: flex-start;
    gap: var(--uw-space-2);
    padding: var(--uw-space-3);
    background: var(--uw-bg-subtle);
    border: 1px solid var(--uw-border-subtle);
    border-radius: var(--uw-radius-lg);
    cursor: pointer;
    transition:
      background-color var(--uw-duration-fast) var(--uw-easing-standard),
      border-color var(--uw-duration-fast) var(--uw-easing-standard),
      transform var(--uw-duration-fast) var(--uw-easing-standard);
  }

  .mode-card:hover {
    border-color: var(--uw-border-strong);
    transform: translateY(-1px);
  }

  .mode-card.selected {
    background: var(--uw-brand-bg);
    border-color: var(--uw-brand-solid);
  }

  .mode-card input {
    position: absolute;
    opacity: 0;
    pointer-events: none;
  }

  .radio-dot {
    width: 1rem;
    height: 1rem;
    margin-top: 2px;
    border-radius: var(--uw-radius-full);
    border: 2px solid var(--uw-border-strong);
    flex-shrink: 0;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    transition: border-color var(--uw-duration-fast) var(--uw-easing-standard);
  }

  .radio-dot::after {
    content: '';
    width: 0.45rem;
    height: 0.45rem;
    border-radius: var(--uw-radius-full);
    background: var(--uw-brand-solid);
    transform: scale(0);
    transition: transform var(--uw-duration-fast) var(--uw-easing-emphasized);
  }

  .mode-card.selected .radio-dot {
    border-color: var(--uw-brand-solid);
  }

  .mode-card.selected .radio-dot::after {
    transform: scale(1);
  }

  .mode-copy {
    flex: 1;
    min-width: 0;
  }

  .mode-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--uw-space-2);
  }

  .mode-title {
    font-size: var(--uw-font-size-sm);
    font-weight: var(--uw-font-weight-semibold);
    color: var(--uw-fg-heading);
  }

  .mode-tag {
    font-size: 0.6875rem;
    padding: 1px var(--uw-space-1);
    border-radius: var(--uw-radius-xs);
    background: var(--uw-bg-surface);
    border: 1px solid var(--uw-border-subtle);
    color: var(--uw-fg-muted);
  }

  .mode-desc {
    font-size: var(--uw-font-size-xs);
    color: var(--uw-fg-muted);
    margin-top: var(--uw-space-1);
    line-height: var(--uw-line-height-snug);
  }

  .toggles {
    display: flex;
    flex-direction: column;
    gap: var(--uw-space-2);
  }

  .switch-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--uw-space-3);
    padding: var(--uw-space-2) var(--uw-space-3);
    background: var(--uw-bg-subtle);
    border: 1px solid var(--uw-border-subtle);
    border-radius: var(--uw-radius-lg);
    cursor: pointer;
    transition: opacity var(--uw-duration-fast) var(--uw-easing-standard);
  }

  .switch-row.disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .switch-label {
    display: flex;
    flex-direction: column;
    gap: 1px;
  }

  .switch-label strong {
    font-size: var(--uw-font-size-xs);
    font-weight: var(--uw-font-weight-semibold);
    color: var(--uw-fg-default);
  }

  .switch-label small {
    font-size: var(--uw-font-size-xs);
    color: var(--uw-fg-muted);
    font-weight: var(--uw-font-weight-normal);
  }

  .pill-toggle {
    position: relative;
    display: inline-flex;
    flex-shrink: 0;
  }

  .pill-toggle input {
    position: absolute;
    opacity: 0;
    pointer-events: none;
  }

  .pill-track {
    width: 2.25rem;
    height: 1.25rem;
    border-radius: var(--uw-radius-full);
    background: var(--uw-border-default);
    padding: 2px;
    display: inline-flex;
    align-items: center;
    transition: background-color var(--uw-duration-fast) var(--uw-easing-standard);
  }

  .pill-knob {
    width: 1rem;
    height: 1rem;
    border-radius: var(--uw-radius-full);
    background: var(--uw-bg-canvas);
    box-shadow: var(--uw-shadow-sm);
    transition: transform var(--uw-duration-fast) var(--uw-easing-emphasized);
  }

  .pill-toggle input:checked + .pill-track {
    background: var(--uw-brand-solid);
  }

  .pill-toggle input:checked + .pill-track .pill-knob {
    transform: translateX(1rem);
  }

  .form-footer {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: var(--uw-space-3);
    padding-top: var(--uw-space-2);
  }

  .queue-meta {
    font-size: var(--uw-font-size-xs);
    color: var(--uw-fg-muted);
  }

  kbd {
    font-family: var(--uw-font-mono);
    font-size: 0.7rem;
    padding: 1px var(--uw-space-1);
    border-radius: var(--uw-radius-xs);
    background: var(--uw-bg-subtle);
    border: 1px solid var(--uw-border-default);
    color: var(--uw-fg-default);
  }

  .submit-btn {
    display: inline-flex;
    align-items: center;
    gap: var(--uw-space-2);
    border: 0;
    background: var(--uw-brand-solid);
    color: var(--uw-brand-on-solid);
    border-radius: var(--uw-radius-lg);
    padding: var(--uw-space-2) var(--uw-space-5);
    font-family: var(--uw-font-sans);
    font-size: var(--uw-font-size-sm);
    font-weight: var(--uw-font-weight-semibold);
    cursor: pointer;
    box-shadow: var(--uw-shadow-sm);
    transition:
      background-color var(--uw-duration-fast) var(--uw-easing-standard),
      transform var(--uw-duration-fast) var(--uw-easing-standard),
      box-shadow var(--uw-duration-fast) var(--uw-easing-standard);
  }

  .submit-btn:hover:not(:disabled) {
    background: var(--uw-brand-solid-hover);
    transform: translateY(-1px);
    box-shadow: var(--uw-shadow-md);
  }

  .submit-btn:active:not(:disabled) {
    transform: translateY(0);
  }

  .submit-btn:disabled {
    opacity: 0.55;
    cursor: not-allowed;
  }

  .btn-spinner {
    width: 0.85rem;
    height: 0.85rem;
    border-radius: var(--uw-radius-full);
    border: 2px solid currentColor;
    border-top-color: transparent;
    animation: spin 0.7s linear infinite;
  }
</style>
