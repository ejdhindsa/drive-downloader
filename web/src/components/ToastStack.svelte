<script lang="ts">
  import { toasts } from '../stores/toasts.svelte';
</script>

{#if toasts.items.length > 0}
  <div class="toast-stack" role="status" aria-live="polite">
    {#each toasts.items as toast (toast.id)}
      <div class="toast variant-{toast.variant}">
        <span class="toast-msg">{toast.message}</span>
        <button
          type="button"
          class="dismiss"
          aria-label="Dismiss notification"
          onclick={() => toasts.dismiss(toast.id)}
        >
          ×
        </button>
      </div>
    {/each}
  </div>
{/if}

<style>
  .toast-stack {
    position: fixed;
    right: var(--uw-space-5);
    bottom: var(--uw-space-5);
    z-index: var(--uw-z-toast);
    display: flex;
    flex-direction: column;
    gap: var(--uw-space-2);
    max-width: min(24rem, calc(100vw - 2rem));
  }

  .toast {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--uw-space-3);
    padding: var(--uw-space-3) var(--uw-space-4);
    border-radius: var(--uw-radius-lg);
    border: 1px solid var(--uw-border-default);
    background: var(--uw-bg-surface);
    color: var(--uw-fg-default);
    font-size: var(--uw-font-size-sm);
    box-shadow: var(--uw-shadow-lg);
  }

  .toast.variant-success {
    background: var(--uw-success-bg);
    border-color: var(--uw-success-border);
    color: var(--uw-success-fg);
  }

  .toast.variant-danger {
    background: var(--uw-danger-bg);
    border-color: var(--uw-danger-border);
    color: var(--uw-danger-fg);
  }

  .toast.variant-info {
    background: var(--uw-info-bg);
    border-color: var(--uw-info-border);
    color: var(--uw-info-fg);
  }

  .toast-msg {
    word-break: break-word;
  }

  .dismiss {
    border: 0;
    background: transparent;
    color: inherit;
    font-size: var(--uw-font-size-lg);
    line-height: var(--uw-line-height-none);
    padding: 0 var(--uw-space-1);
    cursor: pointer;
    opacity: 0.75;
  }

  .dismiss:hover {
    opacity: 1;
  }
</style>
