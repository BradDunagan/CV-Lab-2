<script>
  /**
   * The session log — design-lab-model.md §5.
   *
   * One append-only list, and the point of the whole project: op name, op
   * version, fully-resolved parameters, versioned input refs, and a content
   * hash of the output. `A = gaussian(A)` shows `A#2 ← gaussian(A#1, …)`,
   * because names move and history does not.
   */
  import { sessionLog } from '../lab.svelte.js';

  /** @type {HTMLElement|undefined} */
  let list = $state();

  // Follow the tail, the way a console does.
  $effect(() => {
    void sessionLog.entries.length;
    if (list) list.scrollTop = list.scrollHeight;
  });

  function shapeOf(out) {
    if (out.kind === 'buffer') {
      return `${out.width}×${out.height}×${out.channels} ${out.dtype} ${out.space}`;
    }
    if (out.kind === 'features') {
      return `${out.count} feature${out.count === 1 ? '' : 's'}`;
    }
    const pairs = Object.entries(out.values)
      .map(([k, x]) => `${k}: ${typeof x === 'number' ? x.toPrecision(6) : x}`);
    return `{ ${pairs.join(', ')} }`;
  }
</script>

<div class="log-pane" bind:this={list}>
  {#if sessionLog.entries.length === 0}
    <p class="empty">The log is empty. Every command appends one entry here.</p>
  {/if}
  {#each sessionLog.entries as item, i (i)}
    {#if item.kind === 'error'}
      <div class="line err">{item.source}
     {item.message}</div>
    {:else}
      <div class="line">
        <span class="n">#{item.entry.n}</span>
        {#if item.entry.produced}
          <span class="slot">{item.entry.produced.slot}#{item.entry.produced.version}</span> ←
        {/if}
        {item.entry.text}
        <div class="hash">sha256:{item.entry.output.hash.slice(0, 12)}…  {shapeOf(item.entry.output)}</div>
      </div>
    {/if}
  {/each}
</div>

<style>
  .log-pane {
    width: 100%;
    height: 100%;
    overflow: auto;
    padding: 6px 8px;
    box-sizing: border-box;
    background: var(--cv-tile-bg, #101014);
    color: var(--cv-text, #d8d8e0);
    font: 12px/1.45 ui-monospace, Menlo, Consolas, monospace;
    white-space: pre-wrap;
  }

  .line { margin-bottom: 4px; }
  .n { color: var(--cv-dim, #7c7c8a); }
  .slot { color: var(--cv-accent, #6ea8fe); font-weight: 600; }
  .hash { color: var(--cv-dim, #7c7c8a); padding-left: 3.2em; }
  .err { color: #ff7b81; }
  .empty { color: var(--cv-dim, #7c7c8a); margin: 0; }
</style>
