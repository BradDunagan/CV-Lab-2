<script>
  /**
   * Generate images with pt-lab, and watch it happen.
   *
   * This pane does NOT host the path tracer. pt-lab is three.js plus an OIDN
   * WASM blob behind a GPU renderer, and bundling it here would cost the app a
   * few megabytes and CI a whole extra checkout for something the interface
   * does not otherwise need. The main process runs it in its own window and
   * sends progress back; this shows the progress.
   *
   * That also makes "watch it converge" literal rather than metaphorical: tick
   * `show the render window` and pt-lab's own window appears, path tracing in
   * front of you, while this pane tracks the sweep.
   *
   * Deliberately a first increment. The parameters below are the ones the CLI
   * already takes; the room kinds, camera and material controls pt-lab exposes
   * are the obvious next things to grow here.
   */
  import { onMount } from 'svelte';
  import { lab, setStatus } from '../lab.svelte.js';

  let unavailable = $state(null);
  let running = $state(false);
  let done = $state(null);

  /** @type {{index:number,total:number,name:string,elapsedMs:number}[]} */
  let shots = $state([]);
  let ready = $state(null);

  const options = $state({
    out: 'generated',
    size: 384,
    samples: 48,
    positions: 3,
    lighting: 2,
    room: 'room',
    show: false,
  });

  const ROOMS = ['room', 'room-emissive', 'room-arealight', 'none'];

  let total = $derived(options.positions * options.lighting);
  let estimate = $derived(total * Math.max(6, Math.round(options.samples * 0.42)));

  onMount(() => {
    lab.generate.check().then((problem) => { unavailable = problem; });
    return lab.generate.onProgress((progress) => {
      if (progress.type === 'ready') {
        ready = progress;
      } else if (progress.type === 'shot') {
        shots = [...shots, progress];
      }
    });
  });

  async function start() {
    running = true;
    done = null;
    shots = [];
    ready = null;
    setStatus(`Generating ${total} image(s)…`);

    // `none` is this app's word for pt-lab's default HDR-environment scene,
    // which is not one of its room kinds.
    const result = await lab.generate.run({
      ...options,
      room: options.room === 'none' ? null : options.room,
    });

    running = false;
    done = result;
    setStatus(
      result.ok
        ? `Generated ${result.files.length} image(s) in ${options.out}`
        : `Generation failed: ${result.error}`,
      result.ok ? 'ok' : 'error'
    );
  }
</script>

<div class="generate-pane">
  {#if unavailable}
    <div class="unavailable">
      <p><b>The generator is not built.</b></p>
      <pre>{unavailable}</pre>
    </div>
  {:else}
    <div class="controls">
      <label>out <input bind:value={options.out} disabled={running} /></label>
      <label>size <input type="number" min="64" max="2048" step="64"
                         bind:value={options.size} disabled={running} /></label>
      <label>samples <input type="number" min="4" max="1000" step="4"
                            bind:value={options.samples} disabled={running} /></label>
      <label>positions <input type="number" min="1" max="24"
                              bind:value={options.positions} disabled={running} /></label>
      <label>lighting <input type="number" min="1" max="8"
                             bind:value={options.lighting} disabled={running} /></label>
      <label>scene
        <select bind:value={options.room} disabled={running}>
          {#each ROOMS as kind}<option value={kind}>{kind}</option>{/each}
        </select>
      </label>
      <label class="check" title="pt-lab's own window, path tracing in front of you">
        <input type="checkbox" bind:checked={options.show} disabled={running} />
        show the render window
      </label>
      <span class="grow"></span>
      <button onclick={start} disabled={running}>
        {running ? 'Generating…' : `Generate ${total}`}
      </button>
    </div>

    <p class="hint">
      {#if running && ready}
        {shots.length} of {ready.total} done
      {:else if running}
        Loading the model and building its BVH…
      {:else}
        Roughly {estimate}s for {total} image{total === 1 ? '' : 's'}.
        A room isolates the subject; <code>none</code> uses pt-lab's HDR
        environment, whose blurred background dominates the edge count.
      {/if}
    </p>

    <div class="log">
      {#each shots as shot (shot.name)}
        <div class="line">
          <span class="n">{shot.index + 1}/{shot.total}</span>
          <span class="name">{shot.name}</span>
          yaw={shot.yaw.toFixed(2)} intensity={shot.intensity}
          <span class="ms">{(shot.elapsedMs / 1000).toFixed(1)}s</span>
        </div>
      {/each}
      {#if done && !done.ok}
        <div class="line err">{done.error}</div>
      {:else if done}
        <div class="line ok">
          {done.files.length} image(s) written. Run them with:
          <code>npm run lab -- --script pipeline.lab --out results/ {options.out}/*.png</code>
        </div>
      {/if}
    </div>
  {/if}
</div>

<style>
  .generate-pane {
    width: 100%; height: 100%;
    display: flex; flex-direction: column; gap: 6px;
    padding: 8px; box-sizing: border-box; overflow: auto;
    background: var(--cv-tile-bg, #101014);
    color: var(--cv-text, #d8d8e0);
    font: 12px ui-monospace, Menlo, Consolas, monospace;
  }
  .controls { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
  .controls label { display: flex; align-items: center; gap: 4px; color: var(--cv-dim, #7c7c8a); }
  .controls .grow { flex: 1; }
  input, select, button {
    background: var(--cv-input, #0e0e12);
    border: 1px solid var(--cv-border, #2a2a33);
    border-radius: 3px; color: var(--cv-text, #d8d8e0);
    font: inherit; padding: 3px 6px;
  }
  input[type='number'] { width: 5.5em; }
  input[type='checkbox'] { accent-color: var(--cv-accent, #6ea8fe); padding: 0; }
  button { cursor: pointer; padding: 4px 10px; }
  button:hover:not(:disabled) { border-color: var(--cv-accent, #6ea8fe); }
  button:disabled, input:disabled, select:disabled { opacity: 0.5; }
  .hint { margin: 0; color: var(--cv-dim, #7c7c8a); }
  .hint code, .line code { color: var(--cv-accent, #6ea8fe); }
  .log { flex: 1; min-height: 0; overflow: auto; }
  .line { padding: 1px 0; }
  .n { color: var(--cv-dim, #7c7c8a); }
  .name { color: var(--cv-accent, #6ea8fe); }
  .ms { color: var(--cv-dim, #7c7c8a); }
  .ok { color: #7ee787; }
  .err { color: #ff7b81; }
  .unavailable { color: var(--cv-dim, #7c7c8a); }
  .unavailable pre { white-space: pre-wrap; color: #ff7b81; }
</style>
