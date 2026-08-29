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
   * Every control here is one field in the options object and one key the
   * driver already understands, which is what makes growing it cheap — nothing
   * about the boundary changes when a control is added. `scene` and `truth`
   * arrived exactly that way.
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
    show: false,
  });

  const SCENES = ['helmet', 'cube'];
  const ROOMS = ['default', 'room', 'room-emissive', 'room-arealight', 'none'];

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

    /*
     * Three states, and they are all different. `default` leaves the key off
     * so the scene's own room applies; `none` is this app's word for pt-lab's
     * default HDR-environment scene, which is not one of its room kinds; a
     * name is a room kind.
     */
    const { room, ...rest } = options;
    const result = await lab.generate.run({
      ...rest,
      ...(room === 'default' ? {} : { room: room === 'none' ? null : room }),
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
    <!--
      The first line of the message is the headline and the rest is detail.
      A fixed heading was fine while the only case was a missing build; it is
      wrong for a STALE one, which is a different problem with a different fix.
    -->
    <div class="unavailable">
      <p><b>{unavailable.split('\n')[0]}</b></p>
      <pre>{unavailable.split('\n').slice(1).join('\n')}</pre>
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
      <label title="cube has twelve edges and eight vertices in known places">
        scene
        <select bind:value={options.scene} disabled={running}>
          {#each SCENES as name}<option value={name}>{name}</option>{/each}
        </select>
      </label>
      <label>room
        <select bind:value={options.room} disabled={running}>
          {#each ROOMS as kind}<option value={kind}>{kind}</option>{/each}
        </select>
      </label>
      <label class="check" title="one <name>.gt.json per image: where the edges really are">
        <input type="checkbox" bind:checked={options.truth} disabled={running} />
        ground truth
      </label>
      <label class="check" title="depth, normal and albedo passes, into <out>/aov/">
        <input type="checkbox" bind:checked={options.aovs} disabled={running} />
        AOV passes
      </label>
      <label class="check" title="off in pt-lab by default: every image so far carried the raw noise floor">
        <input type="checkbox" bind:checked={options.denoise} disabled={running} />
        denoise
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
        {#if options.scene === 'cube'}
          A cube has twelve edges and eight vertices in known places, nine and
          seven of them visible from a general viewpoint — which is what makes
          <em>is this corner real</em> a question with an answer.
        {:else}
          A room isolates the subject; <code>none</code> uses pt-lab's HDR
          environment, whose blurred background dominates the edge count.
        {/if}
      {/if}
    </p>

    <div class="log">
      {#each shots as shot (shot.name)}
        <div class="line">
          <span class="n">{shot.index + 1}/{shot.total}</span>
          <span class="name">{shot.name}</span>
          yaw={shot.yaw.toFixed(2)} intensity={shot.intensity}
          {#if shot.truth}
            <span class="gt">gt {shot.truth.visibleEdges}/{shot.truth.edges} edges,
              {shot.truth.visibleVertices}/{shot.truth.vertices} vertices</span>
          {/if}
          <span class="ms">{(shot.elapsedMs / 1000).toFixed(1)}s</span>
        </div>
      {/each}
      {#if done && !done.ok}
        <div class="line err">{done.error}</div>
      {:else if done}
        <div class="line ok">
          {done.files.length} image(s) written. Run them with:
          <code>npm run lab -- --script pipelines/geometry.lab --as linear{
            options.truth ? ` --truth ${options.out}` : ''} --out results/ {options.out}/*.png</code>
          {#if options.truth}
            then <code>npm run score -- results/</code>
          {/if}
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
  .gt { color: #7ee787; }
  .ok { color: #7ee787; }
  .err { color: #ff7b81; }
  .unavailable { color: var(--cv-dim, #7c7c8a); }
  .unavailable pre { white-space: pre-wrap; color: #ff7b81; }
</style>
