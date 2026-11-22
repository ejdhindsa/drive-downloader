<script lang="ts">
  import {
    type ThemePreference,
    getPreference,
    setTheme,
    subscribe,
  } from '@unwreck/core/theme';

  const options: Array<{ value: ThemePreference; label: string }> = [
    { value: 'light', label: 'Light' },
    { value: 'system', label: 'Auto' },
    { value: 'dark', label: 'Dark' },
  ];

  let preference = $state<ThemePreference>(getPreference());

  $effect(() => {
    return subscribe(() => {
      preference = getPreference();
    });
  });

  function selectTheme(next: ThemePreference) {
    preference = next;
    setTheme(next);
  }
</script>

<div class="theme-switch" role="group" aria-label="Color theme">
  {#each options as option (option.value)}
    <button
      type="button"
      class="option"
      class:active={preference === option.value}
      aria-pressed={preference === option.value}
      onclick={() => selectTheme(option.value)}
    >
      {option.label}
    </button>
  {/each}
</div>

<style>
  .theme-switch {
    display: inline-flex;
    align-items: center;
    gap: var(--uw-space-0-5);
    padding: var(--uw-space-0-5);
    background: var(--uw-bg-subtle);
    border: 1px solid var(--uw-border-subtle);
    border-radius: var(--uw-radius-full);
  }

  .option {
    border: 0;
    background: transparent;
    color: var(--uw-fg-muted);
    font-family: var(--uw-font-sans);
    font-size: var(--uw-font-size-xs);
    font-weight: var(--uw-font-weight-medium);
    padding: var(--uw-space-1) var(--uw-space-3);
    border-radius: var(--uw-radius-full);
    cursor: pointer;
    transition:
      background-color var(--uw-duration-fast) var(--uw-easing-standard),
      color var(--uw-duration-fast) var(--uw-easing-standard);
  }

  .option:hover {
    color: var(--uw-fg-default);
  }

  .option.active {
    background: var(--uw-bg-surface);
    color: var(--uw-fg-heading);
    box-shadow: var(--uw-shadow-sm);
  }
</style>
