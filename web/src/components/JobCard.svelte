<script lang="ts">
  import { cancelJob, deleteJob, pauseJob, prioritizeJob, resumeJob, retryJob } from '../api/client';
  import type { Job } from '../api/types';
  import { toasts } from '../stores/toasts.svelte';
  import { formatBytes, formatDuration, formatEta, formatSpeed } from '../utils/format';

  interface Props {
    job: Job;
  }

  let { job }: Props = $props();

  let busyAction = $state<'cancel' | 'pause' | 'resume' | 'prioritize' | 'retry' | 'delete' | null>(null);
  let logsOpen = $state(false);
  let logPre = $state<HTMLPreElement | null>(null);

  let isActive = $derived(
    job.status === 'queued' ||
      job.status === 'paused' ||
      job.status === 'resolving' ||
      job.status === 'downloading' ||
      job.status === 'extracting' ||
      job.status === 'uploading',
  );

  let canPause = $derived(
    job.status === 'queued' || (job.status === 'downloading' && job.mode === 'staged'),
  );
  let isPaused = $derived(job.status === 'paused');
  let canPrioritize = $derived(job.status === 'queued');
  let isRetryable = $derived(job.status === 'failed' || job.status === 'cancelled');
  let title = $derived(job.resolvedFilename || job.url);
  let duration = $derived(formatDuration(job.startedAt, job.finishedAt));

  let fileKind = $derived.by<'video' | 'archive' | 'audio' | 'book' | 'file'>(() => {
    const lower = title.toLowerCase();
    if (/\.(mkv|mp4|avi|mov|webm|m4v)$/.test(lower)) return 'video';
    if (/\.(zip|7z|rar|tar|tgz|tar\.gz|tar\.bz2|tar\.xz|txz)(\.\d{3,})?$/.test(lower)) return 'archive';
    if (/\.(mp3|flac|m4a|m4b|ogg|wav|opus)$/.test(lower)) return 'audio';
    if (/\.(epub|pdf|mobi|azw3|cbz|cbr)$/.test(lower)) return 'book';
    return 'file';
  });

  let steps = $derived.by(() => {
    const showResolve =
      job.status === 'resolving' || Boolean(job.resolverName && job.resolverName !== 'Direct');
    const resolveStep = showResolve ? [{ id: 'resolving', label: 'Resolve' }] : [];
    const list =
      job.mode === 'direct'
        ? [
            { id: 'queued', label: 'Queue' },
            ...resolveStep,
            { id: 'uploading', label: 'Stream' },
            { id: 'completed', label: 'Done' },
          ]
        : [
            { id: 'queued', label: 'Queue' },
            ...resolveStep,
            { id: 'downloading', label: 'Download' },
            ...(job.autoExtract ? [{ id: 'extracting', label: 'Extract' }] : []),
            { id: 'uploading', label: 'Upload' },
            { id: 'completed', label: 'Done' },
          ];

    const statusOrder = list.map((s) => s.id);
    const activeIndex = statusOrder.indexOf(job.status);

    return list.map((step, idx) => {
      let state: 'done' | 'active' | 'failed' | 'pending' = 'pending';
      if (job.status === 'completed') {
        state = 'done';
      } else if (job.status === 'failed' || job.status === 'cancelled') {
        state = idx === 0 ? 'done' : idx === 1 ? 'failed' : 'pending';
      } else if (activeIndex >= 0) {
        if (idx < activeIndex) state = 'done';
        else if (idx === activeIndex) state = 'active';
      }
      return { ...step, state };
    });
  });

  let progressWidth = $derived(
    job.status === 'resolving' || job.status === 'extracting'
      ? 100
      : job.status === 'completed'
        ? 100
        : Math.max(0, Math.min(100, job.progress?.percent ?? 0)),
  );

  let createdLabel = $derived(new Date(job.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }));

  $effect(() => {
    if (logsOpen && logPre && job.logs.length > 0) {
      logPre.scrollTop = logPre.scrollHeight;
    }
  });

  function logTone(line: string): 'error' | 'aria' | 'rclone' | 'extract' | 'plain' {
    if (line.includes('ERROR:') || line.includes('[ERROR]')) return 'error';
    if (line.includes('[aria2c]')) return 'aria';
    if (line.includes('[rclone]')) return 'rclone';
    if (line.includes('[extract]')) return 'extract';
    return 'plain';
  }

  async function runAction(action: 'cancel' | 'pause' | 'resume' | 'prioritize' | 'retry' | 'delete') {
    busyAction = action;
    try {
      if (action === 'cancel') {
        await cancelJob(job.id);
      } else if (action === 'pause') {
        await pauseJob(job.id);
      } else if (action === 'resume') {
        await resumeJob(job.id);
      } else if (action === 'prioritize') {
        await prioritizeJob(job.id);
        toasts.push('info', 'Moved to front of queue.');
      } else if (action === 'retry') {
        await retryJob(job.id);
      } else {
        await deleteJob(job.id);
      }
    } catch (err) {
      toasts.push('danger', err instanceof Error ? err.message : `Failed to ${action} job`);
    } finally {
      busyAction = null;
    }
  }

  async function copyLogs() {
    try {
      await navigator.clipboard.writeText(job.logs.join('\n'));
      toasts.push('info', 'Copied job logs.');
    } catch {
      toasts.push('danger', 'Could not copy logs to clipboard.');
    }
  }
</script>

<article class="job-card status-{job.status}">
  <div class="job-head">
    <div class="title-block">
      <span class="kind-badge kind-{fileKind}">
        {#if fileKind === 'video'}
          <svg viewBox="0 0 20 20" width="15" height="15">
            <rect x="2.5" y="4.5" width="15" height="11" rx="2" fill="none" stroke="currentColor" stroke-width="1.5" />
            <path d="M8.5 7.5l4.5 2.5-4.5 2.5v-5Z" fill="currentColor" />
          </svg>
        {:else if fileKind === 'archive'}
          <svg viewBox="0 0 20 20" width="15" height="15">
            <rect x="3" y="3.5" width="14" height="13" rx="2" fill="none" stroke="currentColor" stroke-width="1.5" />
            <path d="M10 3.5v13M8.5 7h3M8.5 10h3M8.5 13h3" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" />
          </svg>
        {:else if fileKind === 'audio'}
          <svg viewBox="0 0 20 20" width="15" height="15">
            <path d="M8 14.5V5.5l8-1.5v9" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" />
            <circle cx="6" cy="14.5" r="2" fill="none" stroke="currentColor" stroke-width="1.5" />
            <circle cx="14" cy="13" r="2" fill="none" stroke="currentColor" stroke-width="1.5" />
          </svg>
        {:else if fileKind === 'book'}
          <svg viewBox="0 0 20 20" width="15" height="15">
            <path d="M4 4.5A1.5 1.5 0 0 1 5.5 3H16v13.5H5.5A1.5 1.5 0 0 1 4 15V4.5Z" fill="none" stroke="currentColor" stroke-width="1.5" />
            <path d="M4 13.5h12" stroke="currentColor" stroke-width="1.5" />
          </svg>
        {:else}
          <svg viewBox="0 0 20 20" width="15" height="15">
            <path d="M5 3h6l4 4v10H5V3Z" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" />
            <path d="M11 3v4h4" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" />
          </svg>
        {/if}
      </span>

      <div class="title-text">
        <div class="job-title">{title}</div>
        <div class="job-url mono">{job.url}</div>
      </div>
    </div>

    <div class="badges">
      {#if job.status === 'queued' && job.priority}
        <span class="badge priority-badge">Priority</span>
      {/if}
      {#if job.resolverName && job.resolverName !== 'Direct'}
        <span class="badge resolver-badge">{job.resolverName}</span>
      {/if}
      {#if job.partUrls && job.partUrls.length > 1}
        <span class="badge parts-badge">{job.partUrls.length} parts</span>
      {/if}
      <span class="badge mode-badge">{job.mode === 'direct' ? 'Direct' : 'Staged 16x'}</span>
      <span class="badge status-badge badge-{job.status}">{job.status}</span>
    </div>
  </div>

  <div class="job-dest mono">→ {job.destinationRemote}</div>

  <div class="stepper">
    {#each steps as step, idx (step.id)}
      <div class="step step-{step.state}">
        <span class="step-dot"></span>
        <span class="step-label">{step.label}</span>
      </div>
      {#if idx < steps.length - 1}
        <span class="step-line" class:filled={step.state === 'done'}></span>
      {/if}
    {/each}
  </div>

  <div class="progress-track">
    <div
      class="progress-fill bar-{job.status}"
      class:animated={job.status === 'downloading' || job.status === 'uploading'}
      style:width={`${progressWidth}%`}
    ></div>
  </div>

  <div class="stats-row">
    <span class="stats-primary mono">
      {#if job.status === 'downloading' || job.status === 'uploading'}
        {job.progress.percent}% • {formatBytes(job.progress.bytesDone)} /
        {job.progress.bytesTotal > 0 ? formatBytes(job.progress.bytesTotal) : '?'} •
        {formatSpeed(job.progress.speedBytesPerSec)} • ETA {formatEta(job.progress.etaSeconds)}
      {:else if job.status === 'completed' && duration}
        Completed in {duration}
        {#if job.progress.bytesTotal > 0}
          • {formatBytes(job.progress.bytesTotal)}
        {/if}
      {:else}
        {job.phaseLabel}
      {/if}
    </span>
    <span class="stats-time mono">{createdLabel}</span>
  </div>

  {#if job.error}
    <div class="job-error">{job.error}</div>
  {/if}

  <div class="card-footer">
    <div class="actions">
      {#if canPrioritize}
        <button
          type="button"
          class="btn"
          disabled={busyAction !== null}
          onclick={() => void runAction('prioritize')}
        >
          {busyAction === 'prioritize' ? 'Moving...' : '↑ Top'}
        </button>
      {/if}
      {#if canPause}
        <button
          type="button"
          class="btn"
          disabled={busyAction !== null}
          onclick={() => void runAction('pause')}
        >
          {busyAction === 'pause' ? 'Pausing...' : 'Pause'}
        </button>
      {/if}
      {#if isPaused}
        <button
          type="button"
          class="btn primary"
          disabled={busyAction !== null}
          onclick={() => void runAction('resume')}
        >
          {busyAction === 'resume' ? 'Resuming...' : 'Resume'}
        </button>
      {/if}
      {#if isActive}
        <button
          type="button"
          class="btn danger"
          disabled={busyAction !== null}
          onclick={() => void runAction('cancel')}
        >
          {busyAction === 'cancel' ? 'Cancelling...' : 'Cancel'}
        </button>
      {/if}
      {#if isRetryable}
        <button
          type="button"
          class="btn"
          disabled={busyAction !== null}
          onclick={() => void runAction('retry')}
        >
          {busyAction === 'retry' ? 'Retrying...' : 'Retry'}
        </button>
      {/if}
      {#if !isActive}
        <button
          type="button"
          class="btn danger"
          disabled={busyAction !== null}
          onclick={() => void runAction('delete')}
        >
          {busyAction === 'delete' ? 'Removing...' : 'Remove'}
        </button>
      {/if}
    </div>

    <button
      type="button"
      class="logs-toggle"
      class:open={logsOpen}
      onclick={() => (logsOpen = !logsOpen)}
    >
      <span>Logs ({job.logs.length})</span>
      <svg class="chevron" viewBox="0 0 16 16" width="13" height="13">
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
  </div>

  <div class="logs-drawer" class:open={logsOpen}>
    <div class="logs-inner">
      <div class="logs-box">
        <div class="logs-bar">
          <span class="mono">Output</span>
          <button type="button" class="copy-btn" onclick={copyLogs}>Copy</button>
        </div>
        <pre class="logs-pre mono" bind:this={logPre}>
{#each job.logs as line, i (i)}<span class="log-line tone-{logTone(line)}">{line}</span>{'\n'}{/each}</pre>
      </div>
    </div>
  </div>
</article>

<style>
  .job-card {
    position: relative;
    overflow: hidden;
    background: var(--uw-bg-subtle);
    border: 1px solid var(--uw-border-subtle);
    border-left-width: 3px;
    border-radius: var(--uw-radius-lg);
    padding: var(--uw-space-4);
    display: flex;
    flex-direction: column;
    gap: var(--uw-space-3);
    transition:
      border-color var(--uw-duration-fast) var(--uw-easing-standard),
      box-shadow var(--uw-duration-fast) var(--uw-easing-standard);
  }

  .job-card:hover {
    border-color: var(--uw-border-default);
    box-shadow: var(--uw-shadow-sm);
  }

  .job-card.status-queued {
    border-left-color: var(--uw-neutral-solid);
  }

  .job-card.status-paused {
    border-left-color: var(--uw-warning-solid);
  }

  .job-card.status-resolving,
  .job-card.status-downloading {
    border-left-color: var(--uw-info-solid);
  }

  .job-card.status-extracting {
    border-left-color: var(--uw-warning-solid);
  }

  .job-card.status-uploading,
  .job-card.status-completed {
    border-left-color: var(--uw-brand-solid);
  }

  .job-card.status-failed {
    border-left-color: var(--uw-danger-solid);
  }

  .job-card.status-cancelled {
    border-left-color: var(--uw-border-strong);
  }

  .job-head {
    display: flex;
    flex-wrap: wrap;
    align-items: flex-start;
    justify-content: space-between;
    gap: var(--uw-space-3);
  }

  .title-block {
    display: flex;
    align-items: flex-start;
    gap: var(--uw-space-2);
    min-width: 0;
    flex: 1;
  }

  .kind-badge {
    width: 2rem;
    height: 2rem;
    border-radius: var(--uw-radius-md);
    display: inline-flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
    background: var(--uw-bg-surface);
    border: 1px solid var(--uw-border-subtle);
    color: var(--uw-fg-muted);
  }

  .kind-badge.kind-video {
    background: var(--uw-info-bg);
    border-color: var(--uw-info-border);
    color: var(--uw-info-fg);
  }

  .kind-badge.kind-archive {
    background: var(--uw-warning-bg);
    border-color: var(--uw-warning-border);
    color: var(--uw-warning-fg);
  }

  .kind-badge.kind-audio,
  .kind-badge.kind-book {
    background: var(--uw-brand-bg);
    border-color: var(--uw-brand-border);
    color: var(--uw-brand-fg);
  }

  .title-text {
    min-width: 0;
    flex: 1;
  }

  .job-title {
    font-size: var(--uw-font-size-sm);
    font-weight: var(--uw-font-weight-semibold);
    color: var(--uw-fg-heading);
    word-break: break-word;
    line-height: var(--uw-line-height-snug);
  }

  .job-url {
    font-size: 0.72rem;
    color: var(--uw-fg-muted);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    margin-top: 2px;
  }

  .badges {
    display: inline-flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--uw-space-1);
    flex-shrink: 0;
  }

  .badge {
    font-size: 0.68rem;
    font-weight: var(--uw-font-weight-bold);
    text-transform: uppercase;
    letter-spacing: var(--uw-letter-spacing-wider);
    padding: 2px var(--uw-space-2);
    border-radius: var(--uw-radius-full);
    border: 1px solid var(--uw-border-subtle);
  }

  .mode-badge {
    background: var(--uw-bg-surface);
    color: var(--uw-fg-muted);
  }

  .badge-queued {
    background: var(--uw-neutral-bg);
    color: var(--uw-neutral-fg);
  }

  .badge-paused {
    background: var(--uw-warning-bg);
    border-color: var(--uw-warning-border);
    color: var(--uw-warning-fg);
  }

  .priority-badge {
    background: var(--uw-info-bg);
    border-color: var(--uw-info-border);
    color: var(--uw-info-fg);
  }

  .parts-badge {
    background: var(--uw-warning-bg);
    border-color: var(--uw-warning-border);
    color: var(--uw-warning-fg);
  }

  .resolver-badge {
    background: var(--uw-brand-bg);
    border-color: var(--uw-brand-border);
    color: var(--uw-brand-fg);
  }

  .badge-resolving,
  .badge-downloading {
    background: var(--uw-info-bg);
    border-color: var(--uw-info-border);
    color: var(--uw-info-fg);
  }

  .badge-extracting {
    background: var(--uw-warning-bg);
    border-color: var(--uw-warning-border);
    color: var(--uw-warning-fg);
  }

  .badge-uploading,
  .badge-completed {
    background: var(--uw-brand-bg);
    border-color: var(--uw-brand-border);
    color: var(--uw-brand-fg);
  }

  .badge-failed {
    background: var(--uw-danger-bg);
    border-color: var(--uw-danger-border);
    color: var(--uw-danger-fg);
  }

  .badge-cancelled {
    background: var(--uw-neutral-bg);
    color: var(--uw-fg-muted);
  }

  .job-dest {
    font-size: var(--uw-font-size-xs);
    color: var(--uw-brand-fg);
    word-break: break-all;
  }

  .stepper {
    display: flex;
    align-items: center;
    gap: var(--uw-space-1);
  }

  .step {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    font-size: 0.7rem;
    font-weight: var(--uw-font-weight-medium);
    color: var(--uw-fg-muted);
    white-space: nowrap;
  }

  .step-dot {
    width: 0.45rem;
    height: 0.45rem;
    border-radius: var(--uw-radius-full);
    background: var(--uw-border-default);
    flex-shrink: 0;
  }

  .step-done {
    color: var(--uw-fg-default);
  }

  .step-done .step-dot {
    background: var(--uw-brand-solid);
  }

  .step-active {
    color: var(--uw-fg-heading);
    font-weight: var(--uw-font-weight-semibold);
  }

  .step-active .step-dot {
    background: var(--uw-info-solid);
    box-shadow: 0 0 0 3px color-mix(in oklch, var(--uw-info-solid) 25%, transparent);
    animation: pulse-dot 1.4s ease-in-out infinite;
  }

  .step-failed {
    color: var(--uw-danger-fg);
  }

  .step-failed .step-dot {
    background: var(--uw-danger-solid);
  }

  .step-line {
    flex: 1;
    height: 1.5px;
    min-width: 0.75rem;
    background: var(--uw-border-subtle);
    border-radius: var(--uw-radius-full);
  }

  .step-line.filled {
    background: var(--uw-brand-solid);
  }

  @keyframes pulse-dot {
    0%,
    100% {
      opacity: 1;
    }
    50% {
      opacity: 0.45;
    }
  }

  .progress-track {
    width: 100%;
    height: 0.45rem;
    background: var(--uw-bg-surface);
    border: 1px solid var(--uw-border-subtle);
    border-radius: var(--uw-radius-full);
    overflow: hidden;
  }

  .progress-fill {
    height: 100%;
    border-radius: var(--uw-radius-full);
    background: var(--uw-brand-solid);
    transition: width var(--uw-duration-normal) var(--uw-easing-standard);
  }

  .progress-fill.bar-resolving {
    background: var(--uw-info-solid);
    animation: pulse-dot 1.2s ease-in-out infinite;
  }

  .progress-fill.bar-downloading {
    background: var(--uw-info-solid);
  }

  .progress-fill.bar-extracting {
    background: var(--uw-warning-solid);
    animation: pulse-dot 1.2s ease-in-out infinite;
  }

  .progress-fill.bar-uploading,
  .progress-fill.bar-completed {
    background: var(--uw-brand-solid);
  }

  .progress-fill.bar-failed {
    background: var(--uw-danger-solid);
  }

  .progress-fill.bar-cancelled {
    background: var(--uw-border-strong);
  }

  .progress-fill.animated {
    background-image: linear-gradient(
      90deg,
      transparent 0%,
      oklch(1 0 0 / 0.22) 50%,
      transparent 100%
    );
    background-size: 200% 100%;
    animation: shimmer 1.6s linear infinite;
  }

  @keyframes shimmer {
    from {
      background-position: 200% 0;
    }
    to {
      background-position: -200% 0;
    }
  }

  .stats-row {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: var(--uw-space-2);
    font-size: var(--uw-font-size-xs);
    color: var(--uw-fg-muted);
  }

  .stats-primary {
    color: var(--uw-fg-default);
  }

  .job-error {
    font-size: var(--uw-font-size-xs);
    color: var(--uw-danger-fg);
    background: var(--uw-danger-bg);
    border: 1px solid var(--uw-danger-border);
    border-radius: var(--uw-radius-md);
    padding: var(--uw-space-2) var(--uw-space-3);
    word-break: break-word;
  }

  .card-footer {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: var(--uw-space-2);
  }

  .actions {
    display: inline-flex;
    gap: var(--uw-space-2);
  }

  .btn {
    border: 1px solid var(--uw-border-default);
    background: var(--uw-bg-surface);
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

  .btn:hover:not(:disabled) {
    background: var(--uw-bg-surface-hover);
    border-color: var(--uw-border-strong);
  }

  .btn.primary {
    background: var(--uw-brand-bg);
    border-color: var(--uw-brand-border);
    color: var(--uw-brand-fg);
  }

  .btn.primary:hover:not(:disabled) {
    background: var(--uw-brand-bg-hover);
  }

  .btn.danger {
    color: var(--uw-danger-fg);
    border-color: var(--uw-danger-border);
    background: var(--uw-danger-bg);
  }

  .btn.danger:hover:not(:disabled) {
    background: var(--uw-danger-bg-hover);
  }

  .btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .logs-toggle {
    display: inline-flex;
    align-items: center;
    gap: var(--uw-space-1);
    border: 0;
    background: transparent;
    color: var(--uw-fg-muted);
    font-family: var(--uw-font-sans);
    font-size: var(--uw-font-size-xs);
    font-weight: var(--uw-font-weight-semibold);
    cursor: pointer;
    padding: var(--uw-space-1) var(--uw-space-2);
    border-radius: var(--uw-radius-sm);
    transition: color var(--uw-duration-fast) var(--uw-easing-standard);
  }

  .logs-toggle:hover {
    color: var(--uw-fg-default);
  }

  .chevron {
    transition: transform var(--uw-duration-normal) var(--uw-easing-emphasized);
  }

  .logs-toggle.open .chevron {
    transform: rotate(180deg);
  }

  .logs-drawer {
    display: grid;
    grid-template-rows: 0fr;
    opacity: 0;
    transition:
      grid-template-rows var(--uw-duration-normal) var(--uw-easing-emphasized),
      opacity var(--uw-duration-fast) var(--uw-easing-standard);
    margin-top: calc(var(--uw-space-3) * -1);
  }

  .logs-drawer.open {
    grid-template-rows: 1fr;
    opacity: 1;
    margin-top: 0;
  }

  .logs-inner {
    overflow: hidden;
  }

  .logs-box {
    background: var(--uw-bg-canvas);
    border: 1px solid var(--uw-border-subtle);
    border-radius: var(--uw-radius-md);
    overflow: hidden;
  }

  .logs-bar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: var(--uw-space-1) var(--uw-space-3);
    background: var(--uw-bg-surface);
    border-bottom: 1px solid var(--uw-border-subtle);
    font-size: 0.7rem;
    color: var(--uw-fg-muted);
  }

  .copy-btn {
    border: 1px solid var(--uw-border-default);
    background: var(--uw-bg-subtle);
    color: var(--uw-fg-default);
    border-radius: var(--uw-radius-xs);
    padding: 1px var(--uw-space-2);
    font-family: var(--uw-font-sans);
    font-size: 0.68rem;
    font-weight: var(--uw-font-weight-semibold);
    cursor: pointer;
  }

  .copy-btn:hover {
    background: var(--uw-bg-surface-hover);
  }

  .logs-pre {
    margin: 0;
    padding: var(--uw-space-3);
    font-size: 0.72rem;
    line-height: var(--uw-line-height-snug);
    max-height: 11rem;
    overflow-y: auto;
    white-space: pre-wrap;
    word-break: break-word;
    color: var(--uw-fg-muted);
  }

  .log-line.tone-error {
    color: var(--uw-danger-fg);
  }

  .log-line.tone-aria {
    color: var(--uw-info-fg);
  }

  .log-line.tone-rclone {
    color: var(--uw-brand-fg);
  }

  .log-line.tone-extract {
    color: var(--uw-warning-fg);
  }
</style>
