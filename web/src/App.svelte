<script lang="ts">
  import Header from './components/Header.svelte';
  import JobQueue from './components/JobQueue.svelte';
  import ToastStack from './components/ToastStack.svelte';
  import TransferComposer from './components/TransferComposer.svelte';
  import { transferStore } from './stores/transferStore.svelte';

  $effect(() => {
    return transferStore.start();
  });

  $effect(() => {
    document.title = transferStore.tabTitle;
  });
</script>

<div class="shell">
  <Header />

  <main class="workspace">
    <TransferComposer />
    <JobQueue />
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
</style>
