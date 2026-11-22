<script lang="ts">
  import { toasts } from '../stores/toasts.svelte';

  interface Props {
    open: boolean;
    onClose: () => void;
  }

  let { open, onClose }: Props = $props();

  let appOrigin = $state(typeof window !== 'undefined' ? window.location.origin : '');

  let cleanOrigin = $derived(appOrigin.trim().replace(/\/+$/, ''));

  let inspectBookmarklet = $derived(
    `javascript:(()=>{const o=${JSON.stringify(cleanOrigin)};window.open(o+'/?inspect='+encodeURIComponent(location.href),'_blank','noopener');})();`,
  );

  let grabLinksBookmarklet = $derived.by(() => {
    const script =
      `(()=>{const o=${JSON.stringify(cleanOrigin)};` +
      `const ext=/\\.(mp4|mkv|avi|mov|webm|m4v|zip|7z|rar|tar|gz|tgz|bz2|xz|mp3|flac|m4a|epub|pdf|iso|bin|gguf|safetensors|part\\d+\\.rar|7z\\.\\d{3,})$/i;` +
      `const host=/^(?:www\\.)?(pixeldrain\\.com|drive\\.google\\.com|docs\\.google\\.com|drive\\.usercontent\\.google\\.com|gofile\\.io|mediafire\\.com|dropbox\\.com|github\\.com|huggingface\\.co|archive\\.org|buzzheavier\\.com|1fichier\\.com)$/i;` +
      `const out=[];const seen=new Set();` +
      `for(const a of document.querySelectorAll('a[href]')){try{const u=new URL(a.href,location.href);if(u.protocol!=='http:'&&u.protocol!=='https:')continue;u.hash='';const s=u.toString();if(seen.has(s))continue;if(host.test(u.hostname)||ext.test(u.pathname)){seen.add(s);out.push(s);if(out.length>=50)break;}}catch{}}` +
      `if(out.length){window.open(o+'/#links='+encodeURIComponent(out.join('\\n')),'_blank','noopener');}else{window.open(o+'/?inspect='+encodeURIComponent(location.href),'_blank','noopener');}})();`;
    return `javascript:${script}`;
  });

  $effect(() => {
    if (!open) return;
    const onKeydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onClose();
      }
    };
    window.addEventListener('keydown', onKeydown);
    return () => window.removeEventListener('keydown', onKeydown);
  });

  async function copyBookmarklet(label: string, code: string) {
    try {
      await navigator.clipboard.writeText(code);
      toasts.push('success', `${label} bookmarklet copied to clipboard.`);
    } catch {
      toasts.push('danger', 'Clipboard write failed — drag the link to your bookmarks bar instead.');
    }
  }
</script>

{#if open}
  <div
    class="modal-backdrop"
    onclick={(e) => {
      if (e.target === e.currentTarget) {
        onClose();
      }
    }}
  >
    <div class="modal-card">
      <div class="modal-head">
        <div>
          <h3>Browser Bookmarklets</h3>
          <p class="head-sub">
            Drag either pill onto your browser bookmarks bar. Opened links only pre-load or inspect
            and never auto-queue transfers.
          </p>
        </div>
        <button type="button" class="close-btn" onclick={onClose}>Close</button>
      </div>

      <div class="origin-field">
        <label for="bookmarklet-origin">Drive Downloader URL</label>
        <input
          id="bookmarklet-origin"
          type="text"
          class="mono"
          bind:value={appOrigin}
          placeholder="https://downloader.example.com"
        />
      </div>

      <div class="bm-list">
        <div class="bm-card">
          <div class="bm-copy">
            <strong>Inspect Current Page</strong>
            <p>
              Sends the active tab URL to <code>/?inspect=...</code> so Drive Downloader fetches and
              lists downloadable files or hoster links on the page.
            </p>
          </div>
          <div class="bm-actions">
            <a
              class="drag-pill"
              href={inspectBookmarklet}
              onclick={(e) => {
                e.preventDefault();
                toasts.push('info', 'Drag this pill to your bookmarks bar or click Copy.');
              }}
            >
              Inspect in Drive DL
            </a>
            <button
              type="button"
              class="copy-btn"
              onclick={() => copyBookmarklet('Inspect Current Page', inspectBookmarklet)}
            >
              Copy
            </button>
          </div>
        </div>

        <div class="bm-card">
          <div class="bm-copy">
            <strong>Grab Links from Tab</strong>
            <p>
              Extracts up to 50 file and supported hoster links directly from your live browser DOM
              (works on JS-rendered or authenticated pages) and loads them into the composer.
            </p>
          </div>
          <div class="bm-actions">
            <a
              class="drag-pill"
              href={grabLinksBookmarklet}
              onclick={(e) => {
                e.preventDefault();
                toasts.push('info', 'Drag this pill to your bookmarks bar or click Copy.');
              }}
            >
              Send Links to Drive DL
            </a>
            <button
              type="button"
              class="copy-btn"
              onclick={() => copyBookmarklet('Grab Links from Tab', grabLinksBookmarklet)}
            >
              Copy
            </button>
          </div>
        </div>
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
    width: min(40rem, 100%);
    display: flex;
    flex-direction: column;
    gap: var(--uw-space-4);
    padding: var(--uw-space-5);
    background: var(--uw-bg-surface);
    border: 1px solid var(--uw-border-default);
    border-radius: var(--uw-radius-xl);
    box-shadow: var(--uw-shadow-md);
  }

  .modal-head {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: var(--uw-space-3);
  }

  .modal-head h3 {
    font-size: var(--uw-font-size-lg);
    font-weight: var(--uw-font-weight-bold);
  }

  .head-sub {
    margin-top: var(--uw-space-1);
    font-size: var(--uw-font-size-xs);
    color: var(--uw-fg-muted);
    line-height: var(--uw-line-height-snug);
  }

  .close-btn,
  .copy-btn {
    border: 1px solid var(--uw-border-default);
    background: var(--uw-bg-subtle);
    color: var(--uw-fg-default);
    border-radius: var(--uw-radius-md);
    padding: var(--uw-space-2) var(--uw-space-3);
    font-family: var(--uw-font-sans);
    font-size: var(--uw-font-size-xs);
    font-weight: var(--uw-font-weight-semibold);
    cursor: pointer;
    flex-shrink: 0;
    line-height: 1.2;
  }

  .origin-field {
    display: flex;
    flex-direction: column;
    gap: var(--uw-space-2);
  }

  .origin-field label {
    font-size: var(--uw-font-size-xs);
    font-weight: var(--uw-font-weight-semibold);
    color: var(--uw-fg-muted);
  }

  .origin-field input {
    width: 100%;
    background: var(--uw-bg-subtle);
    color: var(--uw-fg-default);
    border: 1px solid var(--uw-border-default);
    border-radius: var(--uw-radius-md);
    padding: var(--uw-space-2) var(--uw-space-3);
    font-size: var(--uw-font-size-xs);
  }

  .bm-list {
    display: flex;
    flex-direction: column;
    gap: var(--uw-space-3);
  }

  .bm-card {
    display: flex;
    flex-direction: column;
    gap: var(--uw-space-3);
    padding: var(--uw-space-3);
    border-radius: var(--uw-radius-lg);
    background: var(--uw-bg-subtle);
    border: 1px solid var(--uw-border-subtle);
  }

  .bm-copy strong {
    font-size: var(--uw-font-size-sm);
    color: var(--uw-fg-heading);
  }

  .bm-copy p {
    margin-top: var(--uw-space-1);
    font-size: var(--uw-font-size-xs);
    color: var(--uw-fg-muted);
    line-height: var(--uw-line-height-snug);
  }

  .bm-actions {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--uw-space-2);
  }

  .drag-pill {
    display: inline-flex;
    align-items: center;
    padding: var(--uw-space-2) var(--uw-space-4);
    border-radius: var(--uw-radius-full);
    background: var(--uw-brand-solid);
    color: var(--uw-brand-on-solid);
    font-size: var(--uw-font-size-xs);
    font-weight: var(--uw-font-weight-semibold);
    line-height: 1.2;
    white-space: nowrap;
    text-decoration: none;
    cursor: grab;
  }

  .drag-pill:hover {
    background: var(--uw-brand-solid-hover);
  }
</style>
