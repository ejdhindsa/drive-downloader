<script lang="ts">
  import type { CustomHeader } from '../api/types';

  interface Props {
    headers: CustomHeader[];
    disabled: boolean;
  }

  let { headers = $bindable(), disabled }: Props = $props();

  let open = $state(false);

  function addRow() {
    headers = [...headers, { name: '', value: '' }];
    open = true;
  }

  function removeRow(index: number) {
    headers = headers.filter((_, idx) => idx !== index);
  }
</script>

<div class="headers-box" class:disabled class:open>
  <button type="button" class="headers-trigger" onclick={() => (open = !open)}>
    <span class="trigger-left">
      <svg viewBox="0 0 20 20" width="15" height="15">
        <path
          d="M3 5h14M3 10h10M3 15h6"
          fill="none"
          stroke="currentColor"
          stroke-width="1.75"
          stroke-linecap="round"
        />
      </svg>
      <span>Custom HTTP Headers</span>
    </span>
    <span class="trigger-right">
      <span class="summary-meta">
        {#if disabled}
          Staged mode only
        {:else if headers.length > 0}
          {headers.length} configured
        {:else}
          Optional
        {/if}
      </span>
      <svg class="chevron" viewBox="0 0 16 16" width="14" height="14">
        <path
          d="M4 6l4 4 4-4"
          fill="none"
          stroke="currentColor"
          stroke-width="1.75"
          stroke-linecap="round"
          stroke-linejoin="round"
        />
      </svg>
    </span>
  </button>

  <div class="collapse" class:open>
    <div class="collapse-inner">
      <div class="headers-body">
        {#if disabled}
          <p class="direct-note">
            Custom HTTP headers are disabled in Direct mode because <code>rclone copyurl</code> applies
            headers globally to Google Drive API requests.
          </p>
        {/if}

        {#if headers.length > 0}
          <div class="rows">
            {#each headers as header, idx (idx)}
              <div class="row">
                <input
                  type="text"
                  placeholder="Header (e.g. Referer)"
                  bind:value={header.name}
                  {disabled}
                />
                <input
                  type="text"
                  placeholder="Value"
                  bind:value={header.value}
                  {disabled}
                />
                <button
                  type="button"
                  class="remove-btn"
                  {disabled}
                  onclick={() => removeRow(idx)}
                >
                  <svg viewBox="0 0 16 16" width="13" height="13">
                    <path
                      d="M4 4l8 8M12 4l-8 8"
                      fill="none"
                      stroke="currentColor"
                      stroke-width="1.75"
                      stroke-linecap="round"
                    />
                  </svg>
                </button>
              </div>
            {/each}
          </div>
        {/if}

        <button type="button" class="add-btn" {disabled} onclick={addRow}>
          + Add Header
        </button>
      </div>
    </div>
  </div>
</div>

<style>
  .headers-box {
    background: var(--uw-bg-subtle);
    border: 1px solid var(--uw-border-subtle);
    border-radius: var(--uw-radius-lg);
    transition:
      opacity var(--uw-duration-fast) var(--uw-easing-standard),
      border-color var(--uw-duration-fast) var(--uw-easing-standard);
  }

  .headers-box.open {
    border-color: var(--uw-border-default);
  }

  .headers-box.disabled {
    opacity: 0.65;
  }

  .headers-trigger {
    width: 100%;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--uw-space-2);
    border: 0;
    background: transparent;
    padding: var(--uw-space-3);
    cursor: pointer;
    font-family: var(--uw-font-sans);
    font-size: var(--uw-font-size-xs);
    font-weight: var(--uw-font-weight-semibold);
    color: var(--uw-fg-default);
  }

  .trigger-left,
  .trigger-right {
    display: inline-flex;
    align-items: center;
    gap: var(--uw-space-2);
  }

  .trigger-left svg {
    color: var(--uw-fg-muted);
  }

  .summary-meta {
    color: var(--uw-fg-muted);
    font-weight: var(--uw-font-weight-medium);
  }

  .chevron {
    color: var(--uw-fg-muted);
    transition: transform var(--uw-duration-normal) var(--uw-easing-emphasized);
  }

  .headers-box.open .chevron {
    transform: rotate(180deg);
  }

  .collapse {
    display: grid;
    grid-template-rows: 0fr;
    opacity: 0;
    transition:
      grid-template-rows var(--uw-duration-normal) var(--uw-easing-emphasized),
      opacity var(--uw-duration-fast) var(--uw-easing-standard);
  }

  .collapse.open {
    grid-template-rows: 1fr;
    opacity: 1;
  }

  .collapse-inner {
    overflow: hidden;
  }

  .headers-body {
    display: flex;
    flex-direction: column;
    gap: var(--uw-space-3);
    padding: 0 var(--uw-space-3) var(--uw-space-3);
    border-top: 1px solid var(--uw-border-subtle);
    padding-top: var(--uw-space-3);
  }

  .direct-note {
    font-size: var(--uw-font-size-xs);
    color: var(--uw-warning-fg);
    background: var(--uw-warning-bg);
    border: 1px solid var(--uw-warning-border);
    border-radius: var(--uw-radius-md);
    padding: var(--uw-space-2) var(--uw-space-3);
  }

  .rows {
    display: flex;
    flex-direction: column;
    gap: var(--uw-space-2);
  }

  .row {
    display: grid;
    grid-template-columns: minmax(0, 1fr) minmax(0, 1.4fr) auto;
    gap: var(--uw-space-2);
  }

  @media (max-width: 36rem) {
    .row {
      grid-template-columns: 1fr auto;
    }

    .row input:first-child {
      grid-column: 1 / -1;
    }
  }

  input {
    width: 100%;
    background: var(--uw-bg-surface);
    color: var(--uw-fg-default);
    border: 1px solid var(--uw-border-default);
    border-radius: var(--uw-radius-md);
    padding: var(--uw-space-2) var(--uw-space-3);
    font-family: var(--uw-font-mono);
    font-size: var(--uw-font-size-xs);
    transition:
      border-color var(--uw-duration-fast) var(--uw-easing-standard),
      box-shadow var(--uw-duration-fast) var(--uw-easing-standard);
  }

  input:focus {
    outline: none;
    border-color: var(--uw-focus-ring);
    box-shadow: 0 0 0 3px color-mix(in oklch, var(--uw-brand-solid) 18%, transparent);
  }

  input:disabled {
    opacity: 0.55;
    cursor: not-allowed;
  }

  .remove-btn,
  .add-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    border: 1px solid var(--uw-border-default);
    background: var(--uw-bg-surface);
    color: var(--uw-fg-default);
    border-radius: var(--uw-radius-md);
    font-family: var(--uw-font-sans);
    font-size: var(--uw-font-size-xs);
    font-weight: var(--uw-font-weight-semibold);
    cursor: pointer;
    transition:
      background-color var(--uw-duration-fast) var(--uw-easing-standard),
      border-color var(--uw-duration-fast) var(--uw-easing-standard),
      transform var(--uw-duration-fast) var(--uw-easing-standard);
  }

  .remove-btn {
    padding: 0 var(--uw-space-2);
    color: var(--uw-danger-fg);
    border-color: var(--uw-danger-border);
    background: var(--uw-danger-bg);
  }

  .remove-btn:hover:not(:disabled) {
    background: var(--uw-danger-bg-hover);
  }

  .add-btn {
    align-self: flex-start;
    padding: var(--uw-space-1) var(--uw-space-3);
  }

  .add-btn:hover:not(:disabled) {
    background: var(--uw-bg-surface-hover);
    border-color: var(--uw-border-strong);
  }

  button:active:not(:disabled) {
    transform: translateY(1px);
  }

  button:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
</style>
