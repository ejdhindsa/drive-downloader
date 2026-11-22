<script lang="ts">
  import Header from './components/Header.svelte';
  import ToastStack from './components/ToastStack.svelte';
  import { transferStore } from './stores/transferStore.svelte';

  $effect(() => {
    return transferStore.start();
  });
</script>

<div class="shell">
  <Header />

  <main class="workspace">
    <section class="panel">
      <h2>New Transfer</h2>
      <p class="muted">
        Connected to <code class="mono">{transferStore.config?.rcloneRoot ?? '...'}</code>. The
        transfer composer mounts here next.
      </p>
    </section>

    <section class="panel">
      <div class="panel-head">
        <h2>Transfer Queue</h2>
        <span class="count-pill mono">{transferStore.jobs.length}</span>
      </div>
      <p class="muted">
        Live SSE stream active ({transferStore.activeCount} running). Job cards mount here next.
      </p>
    </section>
  </main>
</div>

<ToastStack />

<style>
  .shell {
    max-width: 82rem;
    margin: 0 auto;
    padding: var(--uw-space-6) var(--uw-space-4) var(--uw-space-12);
  }

  .workspace {
    display: grid;
    grid-template-columns: minmax(0, 1fr) minmax(0, 1.15fr);
    gap: var(--uw-space-5);
    margin-top: var(--uw-space-6);
    align-items: start;
  }

  @media (max-width: 60rem) {
    .workspace {
      grid-template-columns: 1fr;
    }
  }

  .panel {
    background: var(--uw-bg-surface);
    border: 1px solid var(--uw-border-subtle);
    border-radius: var(--uw-radius-xl);
    padding: var(--uw-space-5);
    box-shadow: var(--uw-shadow-sm);
  }

  .panel-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--uw-space-3);
    margin-bottom: var(--uw-space-2);
  }

  .panel h2 {
    font-size: var(--uw-font-size-lg);
    font-weight: var(--uw-font-weight-semibold);
    margin-bottom: var(--uw-space-2);
  }

  .panel-head h2 {
    margin-bottom: 0;
  }

  .muted {
    color: var(--uw-fg-muted);
    font-size: var(--uw-font-size-sm);
  }

  .muted code {
    color: var(--uw-brand-fg);
    background: var(--uw-brand-bg);
    padding: var(--uw-space-0-5) var(--uw-space-2);
    border-radius: var(--uw-radius-sm);
    font-size: var(--uw-font-size-xs);
  }

  .count-pill {
    font-size: var(--uw-font-size-xs);
    font-weight: var(--uw-font-weight-semibold);
    color: var(--uw-fg-muted);
    background: var(--uw-bg-subtle);
    border: 1px solid var(--uw-border-subtle);
    border-radius: var(--uw-radius-full);
    padding: var(--uw-space-0-5) var(--uw-space-2);
  }
</style>
