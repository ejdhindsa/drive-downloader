<script lang="ts">
  import ThemeToggle from './components/ThemeToggle.svelte';
</script>

<div class="shell">
  <header class="topbar">
    <div class="brand">
      <span class="brand-mark" aria-hidden="true"></span>
      <div>
        <h1>Drive Downloader</h1>
        <p class="subtitle">Staged &amp; direct transfers to Google Drive</p>
      </div>
    </div>

    <ThemeToggle />
  </header>

  <main class="workspace">
    <section class="panel">
      <h2>Frontend Workspace Ready</h2>
      <p>
        Svelte 5 + Vite + <code>@unwreck/core</code> is mounted. The reactive transfer composer,
        live queue, and telemetry header will plug in next.
      </p>
    </section>
  </main>
</div>

<style>
  .shell {
    max-width: 78rem;
    margin: 0 auto;
    padding: var(--uw-space-6) var(--uw-space-4) var(--uw-space-12);
  }

  .topbar {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: var(--uw-space-4);
    padding-bottom: var(--uw-space-6);
    border-bottom: 1px solid var(--uw-border-subtle);
  }

  .brand {
    display: flex;
    align-items: center;
    gap: var(--uw-space-3);
  }

  .brand-mark {
    width: var(--uw-space-3);
    height: var(--uw-space-8);
    border-radius: var(--uw-radius-full);
    background: var(--uw-brand-solid);
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

  .workspace {
    margin-top: var(--uw-space-6);
  }

  .panel {
    background: var(--uw-bg-surface);
    border: 1px solid var(--uw-border-subtle);
    border-radius: var(--uw-radius-xl);
    padding: var(--uw-space-6);
    box-shadow: var(--uw-shadow-sm);
  }

  .panel h2 {
    font-size: var(--uw-font-size-lg);
    font-weight: var(--uw-font-weight-semibold);
    margin-bottom: var(--uw-space-2);
  }

  .panel p {
    color: var(--uw-fg-muted);
    font-size: var(--uw-font-size-sm);
  }

  .panel code {
    color: var(--uw-brand-fg);
    background: var(--uw-brand-bg);
    padding: var(--uw-space-0-5) var(--uw-space-2);
    border-radius: var(--uw-radius-sm);
    font-size: var(--uw-font-size-xs);
  }
</style>
