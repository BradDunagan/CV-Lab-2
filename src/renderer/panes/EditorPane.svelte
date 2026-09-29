<script>
  /**
   * The Scene Editor frame's right-hand pane: where pt-lab renders.
   *
   * Like the Generate frame's render pane, this draws nothing itself. pt-lab
   * runs in a view of its own, from dist-generate/, which the main process
   * lays over this pane's rectangle -- so this reports that rectangle, and
   * says plainly when there is no editor to show.
   *
   * The controls are a paneless column in the pane next door, built by
   * editor-controls.svelte.js, and this pane attaches it -- as GeneratePane
   * attaches its own -- because this is the pane that knows when the editor
   * is up. The column owns nothing: it sends commands to the editor page and
   * draws the snapshots the page publishes, which arrive here.
   *
   * It is not the renderer's business to read or write a scene. The editor
   * page does that through a preload of its own, and the Generate pane hears
   * about a saved scene from the main process directly.
   */
  import { onMount } from 'svelte';
  import { paneStore } from 'paneless';
  import { lab, setStatus } from '../lab.svelte.js';
  import { attachEditorControls } from './editor-controls.svelte.js';

  let { paneId } = $props();

  /** null while it is fine, or the generator's sentence saying what is not. */
  let unavailable = $state(null);

  /** @type {HTMLElement|undefined} */
  let box = $state();

  /** The controls pane is this pane's sibling -- see GeneratePane. */
  const controlsPaneId = () => {
    const parent = paneStore.getPane(paneId)?.parentId;
    return parent ? paneStore.getPane(parent)?.leftChildId ?? null : null;
  };

  /** @type {ReturnType<typeof attachEditorControls>|null} */
  let controls = null;

  /**
   * Reported on resize AND on any pane-store change, for the reason
   * GeneratePane gives: dragging a frame moves a pane without resizing it.
   */
  function reportBounds() {
    if (!box || unavailable) return;
    const r = box.getBoundingClientRect();
    lab.editor.setViewBounds({ x: r.x, y: r.y, width: r.width, height: r.height });
  }

  onMount(() => {
    const offState = lab.editor.onState((snapshot) => controls?.update(snapshot));

    lab.editor.open().then((problem) => {
      unavailable = problem;
      if (problem) {
        setStatus(problem.split('\n')[0], 'error');
        return;
      }
      queueMicrotask(reportBounds);
      const target = controlsPaneId();
      if (target) {
        controls = attachEditorControls(target, lab.editor, {
          onError: (message) => setStatus(message, 'error'),
        });
        controls.update(null);
      }
      // A frame reopened around an editor that was already running -- Keep
      // Editing -- has missed every snapshot so far; ask for the current one.
      lab.editor.call('refresh').catch(() => { /* not loaded yet; it will publish */ });
    }).catch((err) => setStatus(err.message, 'error'));

    const observer = new ResizeObserver(reportBounds);
    if (box) observer.observe(box);
    const onWindowResize = () => reportBounds();
    window.addEventListener('resize', onWindowResize);
    const unsubscribePanes = paneStore.subscribe(() => queueMicrotask(reportBounds));

    return () => {
      observer.disconnect();
      window.removeEventListener('resize', onWindowResize);
      unsubscribePanes();
      offState();
      controls?.dispose();
      controls = null;
      /*
       * Only when the pane is really gone. paneless can unmount a pane's
       * component without closing it -- moving it, tabbing it -- and closing
       * the editor then would throw away whatever was being composed. The
       * store has settled by the next tick, so ask it then.
       */
      setTimeout(() => {
        if (paneStore.getPane(paneId)) return;
        lab.editor.close().catch((err) => setStatus(err.message, 'error'));
      }, 0);
    };
  });
</script>

<div class="editor-pane" bind:this={box} data-pane={paneId}>
  {#if unavailable}
    <div class="unavailable">
      <p><b>{unavailable.split('\n')[0]}</b></p>
      <pre>{unavailable.split('\n').slice(1).join('\n')}</pre>
      <p>The Scene Editor is part of the generator bundle, so it needs the same build.</p>
    </div>
  {:else}
    <p class="placeholder">Starting pt-lab's editor…</p>
  {/if}
</div>

<style>
  .editor-pane {
    width: 100%; height: 100%;
    padding: 8px; box-sizing: border-box; overflow: auto;
    background: #1c1c1c;
    color: #bbbbbb;
    font: 12px ui-monospace, Menlo, Consolas, monospace;
  }
  .unavailable {
    background: var(--cv-tile-bg, #ffffff);
    color: var(--cv-text, #333333);
    padding: 8px; border-radius: 3px;
  }
  .unavailable pre { white-space: pre-wrap; margin: 0.5em 0; }
  .placeholder { margin: 0; }
</style>
