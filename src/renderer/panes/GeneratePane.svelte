<script>
  /**
   * Generate images with pt-lab, and watch it happen.
   *
   * This pane still does NOT host the path tracer. pt-lab is three.js plus an
   * OIDN WASM blob behind a GPU renderer, and putting it in the renderer would
   * cost the app a few megabytes and CI a whole extra checkout for something
   * the interface does not otherwise need. It gets its own webContents, loaded
   * from dist-generate/, and progress comes back over IPC.
   *
   * What this pane now does is say WHERE that webContents goes. The main
   * process lays a WebContentsView over this pane's rectangle, so "watch it
   * converge" is literal and is the default: the tracer runs in front of you
   * while the sweep proceeds. It used to be a separate window behind a
   * checkbox, which meant that most of the time nobody saw it at all.
   *
   * paneless moves and resizes this pane and the main process cannot see any
   * of it, so the geometry is reported from here. The pane is the authority on
   * where it is; main is the authority on what goes there.
   *
   * The controls are a paneless control column in the pane next door, built by
   * generate-controls.svelte.js. Every control is still one field in the
   * options object and one key the driver already understands, which is what
   * made growing the old pane cheap -- nothing about that boundary changed
   * when the controls stopped being DOM.
   */
  import { onMount } from 'svelte';
  import { paneStore } from 'paneless';
  import { attachGenerateControls } from './generate-controls.svelte.js';
  import { lab, setStatus } from '../lab.svelte.js';

  let { paneId } = $props();

  let unavailable = $state(null);
  let running = $state(false);
  let done = $state(null);

  /** @type {{index:number,total:number,name:string,elapsedMs:number}[]} */
  let shots = $state([]);
  let ready = $state(null);

  /** @type {HTMLElement|undefined} */
  let box = $state();

  const DEFAULTS = {
    // Replaced on mount by whatever the main process nominates. A relative
    // path would resolve against a working directory a packaged app never
    // chose, which on macOS is `/`.
    out: '',
    scene: 'helmet',
    size: 384,
    samples: 48,
    positions: 3,
    lighting: 2,
    // 'default' means "whatever this scene asks for" -- the helmet wants a
    // plain room, the cube wants an area-lit one so that every strong edge in
    // frame has geometry behind it.
    room: 'default',
    truth: false,
    aovs: false,
    denoise: false,
  };

  /** Whatever the controls currently say. The column owns the fields; this is
   *  the copy everything else reads. */
  let current = $state({ ...DEFAULTS });

  let total = $derived(current.positions * current.lighting);
  let estimate = $derived(total * Math.max(6, Math.round(current.samples * 0.42)));

  /**
   * The controls pane is this pane's sibling.
   *
   * Found through paneless rather than passed in, for the same reason the slot
   * column reads its slot off its sibling: the pane tree is what survives a
   * layout change, and a prop threaded from App.svelte would not.
   */
  const controlsPaneId = () => {
    const parent = paneStore.getPane(paneId)?.parentId;
    return parent ? paneStore.getPane(parent)?.leftChildId ?? null : null;
  };

  /** @type {ReturnType<typeof attachGenerateControls>|null} */
  let controls = null;

  /**
   * The prose under the controls: what is about to happen, or what is.
   *
   * One string rather than markup, because it is drawn as a paneless label --
   * one tspan per newline, and no wrapping of its own -- so the column wraps
   * it and this only decides the words.
   */
  const hintText = () => {
    if (running && ready) {
      const recent = shots.slice(-6).map(
        (s) => `${s.index + 1}/${s.total} ${s.name} ${(s.elapsedMs / 1000).toFixed(1)}s` +
          (s.truth ? ` gt ${s.truth.visibleEdges}/${s.truth.edges} edges` : '')
      );
      return [`${shots.length} of ${ready.total} done`, '', ...recent].join('\n');
    }
    if (running) return 'Loading the model and building its BVH...';

    const lines = [];
    if (done && !done.ok) {
      lines.push(`Failed: ${done.error}`, '');
    } else if (done) {
      lines.push(`${done.files.length} image(s) written. Run them with:`, '',
        'npm run lab -- --script pipelines/geometry.lab --as linear' +
          `${current.truth ? ` --truth ${current.out}` : ''} --out results/ ${current.out}/*.png`,
        ...(current.truth ? ['', 'then  npm run score -- results/'] : []), '');
    }
    lines.push(`Roughly ${estimate}s for ${total} image${total === 1 ? '' : 's'}.`);
    lines.push(current.scene === 'cube'
      ? 'A cube has twelve edges and eight vertices in known places, nine and ' +
        'seven of them visible from a general viewpoint, which is what makes ' +
        '"is this corner real" a question with an answer.'
      : 'A room isolates the subject; "none" uses pt-lab\'s HDR environment, ' +
        'whose blurred background dominates the edge count.');
    return lines.join('\n');
  };

  function refreshControls() {
    controls?.update({
      running,
      hint: hintText(),
      runLabel: running ? 'Generating...' : `Generate ${total}`,
    });
  }

  /*
   * Redraw the column whenever anything it displays changes. Cheap: the column
   * writes only the properties that actually differ.
   */
  $effect(() => {
    void running; void done; void shots; void ready; void current;
    void total; void estimate;
    refreshControls();
  });

  /**
   * Tell the main process where the render goes.
   *
   * Reported on resize AND on any pane-store change, because a pane can move
   * without changing size -- dragging the frame does exactly that, and a view
   * left at the old rectangle sits over the wrong part of the window.
   */
  function reportBounds() {
    if (!box) return;
    const r = box.getBoundingClientRect();
    lab.generate.setViewBounds({ x: r.x, y: r.y, width: r.width, height: r.height });
  }

  onMount(() => {
    lab.generate.check().then((problem) => {
      unavailable = problem;
      if (problem) return;
      const target = controlsPaneId();
      if (!target) return;
      controls = attachGenerateControls(target, current, {
        onRun: (opts) => { current = opts; start(opts); },
        onChange: (opts) => { current = opts; },
      });
      refreshControls();
    });

    lab.generate.defaults().then(({ out }) => {
      if (current.out) return;
      current = { ...current, out };
      controls?.setField('out', out);
    });

    const observer = new ResizeObserver(reportBounds);
    if (box) observer.observe(box);
    const onWindowResize = () => reportBounds();
    window.addEventListener('resize', onWindowResize);
    const unsubscribePanes = paneStore.subscribe(() => queueMicrotask(reportBounds));

    const offProgress = lab.generate.onProgress((progress) => {
      if (progress.type === 'ready') ready = progress;
      else if (progress.type === 'shot') shots = [...shots, progress];
    });

    return () => {
      observer.disconnect();
      window.removeEventListener('resize', onWindowResize);
      unsubscribePanes();
      offProgress();
      controls?.dispose();
      controls = null;
    };
  });

  async function start(opts) {
    running = true;
    done = null;
    shots = [];
    ready = null;
    setStatus(`Generating ${opts.positions * opts.lighting} image(s)...`);

    /*
     * Three states, and they are all different. `default` leaves the key off
     * so the scene's own room applies; `none` is this app's word for pt-lab's
     * default HDR-environment scene, which is not one of its room kinds; a
     * name is a room kind.
     */
    const { room, ...rest } = opts;
    const result = await lab.generate.run({
      ...rest,
      ...(room === 'default' ? {} : { room: room === 'none' ? null : room }),
    });

    running = false;
    done = result;
    setStatus(
      result.ok
        ? `Generated ${result.files.length} image(s) in ${opts.out}`
        : `Generation failed: ${result.error}`,
      result.ok ? 'ok' : 'error'
    );
  }
</script>

<div class="generate-pane" bind:this={box} data-pane={paneId} data-running={running}>
  {#if unavailable}
    <!--
      The first line of the message is the headline and the rest is detail.
      A fixed heading was fine while the only case was a missing build; it is
      wrong for a STALE one, which is a different problem with a different fix.
    -->
    <div class="unavailable">
      <p><b>{unavailable.split('\n')[0]}</b></p>
      <pre>{unavailable.split('\n').slice(1).join('\n')}</pre>
    </div>
  {:else if !running}
    <!--
      Only ever visible between runs. While a sweep is in flight the main
      process lays pt-lab's own webContents over this whole pane.
    -->
    <p class="placeholder">
      {#if done && done.ok}
        {done.files.length} image(s) written to <code>{current.out}</code>.
        Press <b>Generate</b> to render another sweep here.
      {:else if done}
        <span class="err">{done.error}</span>
      {:else}
        pt-lab renders here, live, while a sweep runs.
      {/if}
    </p>
  {/if}
</div>

<style>
  .generate-pane {
    width: 100%; height: 100%;
    display: flex; flex-direction: column; gap: 6px;
    padding: 8px; box-sizing: border-box; overflow: auto;
    background: var(--cv-tile-bg, #ffffff);
    color: var(--cv-text, #333333);
    font: 12px ui-monospace, Menlo, Consolas, monospace;
  }
  .placeholder { margin: auto; text-align: center; color: var(--cv-dim, #666666); }
  .placeholder code { color: var(--cv-accent, #2a7edf); }
  .err { color: #c0362c; }
  .unavailable { color: var(--cv-dim, #666666); }
  .unavailable pre { white-space: pre-wrap; color: #c0362c; }
</style>
