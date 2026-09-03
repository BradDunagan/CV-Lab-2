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
  import { lab, setStatus, actions, pipelineRun } from '../lab.svelte.js';

  let { paneId } = $props();

  let unavailable = $state(null);
  /** null until asked; [] means scenes/ holds nothing the pane can offer. */
  let scenes = $state(null);
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
    // Replaced on mount by the first scene in scenes/. There is no built-in
    // fallback: the pane offers files and nothing else, so an empty scenes/
    // means there is nothing to render rather than something to render badly.
    scene: '',
    size: 384,
    samples: 48,
    positions: 3,
    lighting: 2,
    truth: false,
    aovs: false,
    denoise: false,
  };

  /** Whatever the controls currently say. The column owns the fields; this is
   *  the copy everything else reads. */
  let current = $state({ ...DEFAULTS });

  /**
   * The contact sheet: one entry per image the last sweep wrote.
   *
   * Built from the `shot` progress events rather than by listing the output
   * directory, so it holds exactly what THIS run produced. A directory would
   * also hold whatever was there before, and clicking a stale image to watch
   * the pipeline run over it is a good way to draw a conclusion about the
   * wrong picture.
   */
  let sheet = $state([]);

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
    lines.push('The scene comes from scenes/, composed in pt-lab, and carries ' +
      'its own room and lighting. Ground truth is only as useful as the ' +
      'subject: edges that are paint rather than geometry cannot be scored.');
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

  /*
   * Draw each thumbnail once its canvas is in the document.
   *
   * The preload finds the canvas by id and draws into it, so this has to run
   * AFTER Svelte has put the element there -- hence the effect on `sheet`
   * rather than a call at the point the file arrived.
   */
  $effect(() => {
    /*
     * `running` is read on purpose. The sheet fills DURING a sweep, while the
     * markup is still showing the render -- so at the moment a file arrives
     * there is no canvas to draw into, and an effect that watched only `sheet`
     * ran too early and never again. It has to re-run when the sheet becomes
     * visible, which is when `running` goes false.
     */
    void running;
    for (const shot of sheet) {
      const id = `gen-thumb-${paneId}-${shot.name}`;
      if (!document.getElementById(id)) continue;
      lab.thumbnail(id, shot.file).catch((err) => setStatus(err.message, 'error'));
    }
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
    Promise.all([lab.generate.check(), lab.generate.scenes()]).then(([problem, found]) => {
      unavailable = problem;
      scenes = found;
      if (problem || found.length === 0) return;
      const target = controlsPaneId();
      if (!target) return;
      current = { ...current, scene: `saved:${found[0]}` };
      controls = attachGenerateControls(target, current, found, {
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
      else if (progress.type === 'shot') {
        shots = [...shots, progress];
        if (progress.file) {
          sheet = [...sheet, {
            name: progress.name?.replace(/\.png$/, '') ?? `shot ${shots.length}`,
            file: progress.file,
            // Ground truth sits beside the image under the same stem, and the
            // pipeline's match() stages need it. Absent when --truth was off,
            // in which case the run simply stops being scored.
            truth: progress.truth ? progress.file.replace(/\.png$/, '.gt.json') : null,
          }];
        }
      }
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
    sheet = [];
    ready = null;
    setStatus(`Generating ${opts.positions * opts.lighting} image(s)...`);

    /*
     * No `room` key at all, which the driver reads as "the scene's own room".
     * A scene composed in pt-lab records the room it was composed in, so
     * overriding it from here could only ever contradict the file. The CLI
     * keeps `--room` for the experiment that wants it: one subject, several
     * backgrounds.
     */
    const result = await lab.generate.run({ ...opts });

    running = false;
    done = result;

    /*
     * The controls have done their job. Collapsing them hands the whole frame
     * to the contact sheet, which is what there is to look at now -- and
     * paneless keeps the column on a tab, so changing a parameter and going
     * again is one click rather than a reopened frame.
     */
    if (result.ok && result.files.length > 0) {
      const target = controlsPaneId();
      if (target) paneStore.collapsePaneToTab(target, 0.4);
    }

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
  {:else if scenes && scenes.length === 0}
    <!--
      Nothing to offer, said plainly. The pane renders scenes/ and only
      scenes/, so an empty directory is not a broken generator -- it is a
      generator with no subject, and the fix is a file rather than a build.
    -->
    <div class="unavailable">
      <p><b>No scenes to render.</b></p>
      <pre>The Generate pane offers the scenes in scenes/, composed in pt-lab's
editor and exported as JSON. There are none.

Add one as scenes/&lt;name&gt;.json, or scenes/&lt;name&gt;.local.json to keep it
out of the repository.</pre>
    </div>
  {:else if !running && sheet.length > 0}
    <!--
      The contact sheet. Only between runs: while a sweep is in flight the main
      process lays pt-lab's own webContents over this whole pane.

      Clicking one runs the pipeline over it. The thumbnails are drawn by the
      preload into canvases by id, the same handshake SlotPane uses -- these
      are files on disk, and no pixels cross the bridge to get here.
    -->
    <div class="sheet">
      {#each sheet as shot (shot.file)}
        <button
          class="shot"
          class:current={pipelineRun.image === shot.file}
          disabled={pipelineRun.busy}
          title={shot.file}
          onclick={() => actions.runPipelineOn(shot.file, shot.truth)}
        >
          <canvas id={`gen-thumb-${paneId}-${shot.name}`} width="128" height="128"></canvas>
          <span class="name">{shot.name}</span>
        </button>
      {/each}
    </div>
    <p class="sheet-hint">
      {#if pipelineRun.busy}
        Running the pipeline over <code>{pipelineRun.image?.split('/').pop()}</code>
        — step {pipelineRun.step} of {pipelineRun.total}.
      {:else}
        Click an image to run <code>pipelines/geometry.lab</code> over it. Any
        slot frames open now are closed first.
      {/if}
    </p>
  {:else if !running}
    <p class="placeholder">
      {#if done}
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
  .sheet {
    display: flex; flex-wrap: wrap; gap: 8px;
    align-content: flex-start; overflow: auto;
    padding: 2px;
  }
  .shot {
    display: flex; flex-direction: column; align-items: center; gap: 2px;
    padding: 3px; cursor: pointer;
    background: var(--cv-input, #ffffff);
    border: 1px solid var(--cv-border, #cccccc);
    border-radius: 3px;
    color: inherit; font: inherit;
  }
  .shot:hover:not(:disabled) { border-color: var(--cv-accent, #2a7edf); }
  .shot.current { border-color: var(--cv-accent, #2a7edf); box-shadow: 0 0 0 1px var(--cv-accent, #2a7edf); }
  .shot:disabled { opacity: 0.6; cursor: default; }
  .shot canvas { display: block; width: 128px; height: 128px; }
  .shot .name { font-size: 10px; color: var(--cv-dim, #666666); }
  .sheet-hint { margin: 0; flex: 0 0 auto; color: var(--cv-dim, #666666); }
  .sheet-hint code { color: var(--cv-accent, #2a7edf); }

  .placeholder { margin: auto; text-align: center; color: var(--cv-dim, #666666); }
  .placeholder code { color: var(--cv-accent, #2a7edf); }
  .err { color: #c0362c; }
  .unavailable { color: var(--cv-dim, #666666); }
  .unavailable pre { white-space: pre-wrap; color: #c0362c; }
</style>
