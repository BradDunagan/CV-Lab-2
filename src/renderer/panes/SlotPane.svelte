<script>
  /**
   * One slot, drawn into one canvas.
   *
   * This is the pane where the port had to be careful, because it is the seam
   * between two ownership rules that both have to keep holding:
   *
   *   - Svelte owns the DOM. It creates and destroys this canvas.
   *   - The PRELOAD owns the pixels, and draws into that canvas itself.
   *
   * They meet through an id. `window.lab.draw(canvasId, ...)` calls
   * `document.getElementById` in the preload's context and reaches the same
   * canvas element, because contextIsolation separates the two JavaScript
   * worlds but NOT the DOM — one C++ object, two wrappers. That is also why
   * the handshake is an id and not the element: a DOM node cannot cross the
   * contextBridge, which deep-copies, and pixels never cross it at all.
   *
   * The id is keyed by PANE, not by slot, so two panes may show the same slot
   * under different display transforms — which §6 asks for explicitly and the
   * old fixed grid could not do.
   */
  import { onMount, tick } from 'svelte';
  import { paneStore } from 'paneless';
  import {
    lab, viewport, display, slots, viewOf, slotNamed, bufferSlots,
    zoomAt, panBy, showProbe, hideProbe, fmt,
  } from '../lab.svelte.js';

  let { paneId } = $props();

  /** @type {HTMLCanvasElement|undefined} */
  let canvas = $state();
  /** @type {HTMLElement|undefined} */
  let box = $state();
  let boxSize = $state({ width: 0, height: 0 });
  let readout = $state('');
  let zoomText = $state('');
  let error = $state('');

  /*
   * Which slot this pane shows is stored in paneless's own `name` field rather
   * than in component state, for the same reason rr keeps a PE's identity
   * there: it survives a layout save/restore and a drag into another frame,
   * and component state does not.
   */
  let paneData = $state(null);
  $effect(() => paneStore.subscribe((data) => { paneData = data.byId[paneId] ?? null; }));

  let boundName = $derived(paneData?.name ?? null);
  let slot = $derived(boundName ? slotNamed(boundName) : null);
  let view = $derived(boundName ? viewOf(boundName) : null);

  export function bindSlot(name) {
    paneStore.setName(paneId, name);
    paneStore.updatePane(paneId, { title: name ? `Slot ${name}` : 'Slot', titleVisible: true });
  }

  /* --- sizing -------------------------------------------------------- */

  /**
   * Claim the 2D context the moment the element exists, before anything else
   * asks for one.
   *
   * These canvases are only ever written with putImageData — by the PRELOAD —
   * and read back by the overlay and by tests, so CPU backing is the right
   * choice. getContext returns the SAME context on every later call and
   * ignores the attributes then, so whoever asks first decides: an action runs
   * at element creation, ahead of any effect, which is what makes this stick
   * for the preload's own getContext too.
   *
   * onMount is not good enough here. A pane starts unbound, so the canvas does
   * not exist yet when the component mounts — it appears later, when a slot is
   * bound, and Chromium starts warning about readback the first time the
   * overlay reads it.
   */
  function cpuBacked(node) {
    node.getContext('2d', { willReadFrequently: true });
  }

  onMount(() => {
    if (!box) return;
    const observer = new ResizeObserver(([entry]) => {
      const r = entry.contentRect;
      boxSize = { width: Math.floor(r.width), height: Math.floor(r.height) };
    });
    observer.observe(box);
    return () => observer.disconnect();
  });

  /**
   * The canvas takes its ASPECT from the slot and its SIZE from the pane.
   *
   * A canvas simply stretched to the pane would squash the image: renderTile
   * maps the source rect onto whatever destination it is handed, so a 256x256
   * slot in a 480x360 pane came out 0.75x vertically. Fitting the aspect inside
   * the pane is what the old fixed 480x420 tile box did — the pane is just a
   * box that can now change size.
   */
  let canvasSize = $derived.by(() => {
    if (!slot || boxSize.width < 8 || boxSize.height < 8) return { width: 0, height: 0 };
    let scale = Math.min(boxSize.width / slot.width, boxSize.height / slot.height);
    if (display.scaling === 'actual') scale = Math.min(scale, 1);
    return {
      width: Math.max(1, Math.round(slot.width * scale)),
      height: Math.max(1, Math.round(slot.height * scale)),
    };
  });

  /* --- drawing ------------------------------------------------------- */

  /*
   * One effect, reading everything a redraw depends on: the bound slot and its
   * version, the display transform, the shared viewport, the scaling mode, the
   * overlay toggle and the canvas size. Any of them changing re-runs this.
   *
   * That reactivity replaces the old `redrawAll()` fan-out, and it is the
   * reason a pan in one pane moves every other pane: they all read `viewport`.
   */
  $effect(() => {
    const c = canvas;
    const size = canvasSize;
    const v = view;
    const s = slot;
    // Read these so the effect depends on them even when unused below.
    void viewport.x; void viewport.y; void viewport.w; void viewport.h;
    void display.scaling; void display.overlay;
    void s?.version;

    if (!c || !s || !v || size.width === 0) return;
    if (c.width !== size.width) c.width = size.width;
    if (c.height !== size.height) c.height = size.height;

    error = '';
    try {
      if (v.type === 'histogram') {
        drawHistogram(c, s.name, v);
        readout = 'histogram';
        zoomText = '';
      } else {
        const { lo, hi, info } = lab.draw(c.id, s.name, {
          ...v,
          viewport: { x: viewport.x, y: viewport.y, w: viewport.w, h: viewport.h },
          interpolate: display.scaling !== 'pixels',
        });
        readout = `${fmt(lo)} … ${fmt(hi)}  ${v.colormap}`;
        // Screen pixels per image pixel — the number actually worth showing.
        const perPixel = c.width / (viewport.w * info.width);
        zoomText = `${perPixel >= 10 ? perPixel.toFixed(0) : perPixel.toFixed(2)}×`;
        drawOverlays(c, s);
      }
    } catch (err) {
      error = err.message;
      readout = '';
    }
  });

  /**
   * Fitted segments and corner hypotheses, drawn over the image they were
   * measured in.
   *
   * Feature lists carry the dimensions of that image and have none of their
   * own, which is what lets them be drawn on ANY tile of matching size — so a
   * fit can be checked against the photograph rather than against its own
   * label map.
   */
  function drawOverlays(c, s) {
    if (!display.overlay) return;
    const lists = lab.features().filter((f) => f.width === s.width && f.height === s.height);
    if (lists.length === 0) return;

    const ctx = c.getContext('2d');
    const sx = c.width / (viewport.w * s.width);
    const sy = c.height / (viewport.h * s.height);
    const toX = (x) => (x - viewport.x * s.width) * sx;
    const toY = (y) => (y - viewport.y * s.height) * sy;

    ctx.save();
    for (const list of lists) {
      for (const f of list.features) {
        // By type. Assuming every feature was a line segment is what made
        // corners — which have x,y rather than x0,y0,x1,y1 — produce NaN
        // coordinates that canvas silently discarded: computed, logged,
        // and invisible.
        if (f.type === 'edge-corner') drawCorner(ctx, f, toX, toY, sx);
        else drawSegment(ctx, f, toX, toY);
      }
    }
    ctx.restore();
  }

  function drawSegment(ctx, f, toX, toY) {
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = '#ff5c8a';
    ctx.fillStyle = '#ffd166';
    ctx.beginPath();
    ctx.moveTo(toX(f.x0), toY(f.y0));
    ctx.lineTo(toX(f.x1), toY(f.y1));
    ctx.stroke();
    for (const [px, py] of [[f.x0, f.y0], [f.x1, f.y1]]) {
      ctx.beginPath();
      ctx.arc(toX(px), toY(py), 2.5, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  function drawCorner(ctx, f, toX, toY, scale) {
    const x = toX(f.x), y = toY(f.y);
    // The uncertainty circle is drawn in IMAGE units, so it grows with zoom the
    // way the image does — a corner known to a tenth of a pixel should look
    // tight when you zoom in on it, not stay a fixed blob.
    const radius = Math.max(2, (f.sigma ?? 0) * scale);
    ctx.strokeStyle = 'rgba(126, 231, 135, 0.55)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(x, y, radius, 0, Math.PI * 2);
    ctx.stroke();

    // Corroborated corners are drawn solidly; a lone pair faintly, because
    // support is the number that separates real from invented.
    const strong = (f.support ?? 1) >= 2;
    ctx.strokeStyle = strong ? '#7ee787' : 'rgba(126, 231, 135, 0.45)';
    ctx.lineWidth = strong ? 2 : 1;
    const arm = 5;
    ctx.beginPath();
    ctx.moveTo(x - arm, y); ctx.lineTo(x + arm, y);
    ctx.moveTo(x, y - arm); ctx.lineTo(x, y + arm);
    ctx.stroke();
  }

  function drawHistogram(c, slotName, v) {
    const { counts, lo, hi } = lab.histogram(slotName, {
      bins: 128, curve: v.curve, range: v.range, channel: v.channel,
    });
    const ctx = c.getContext('2d');
    // Painted, not left transparent: the canvas is its own surface, and the
    // pane behind it is not guaranteed to be the colour the bars were picked
    // to read against.
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, c.width, c.height);

    const peak = Math.max(...counts, 1);
    const barWidth = c.width / counts.length;
    ctx.fillStyle = '#2a7edf';
    counts.forEach((count, i) => {
      const height = (count / peak) * (c.height - 18);
      ctx.fillRect(i * barWidth, c.height - height - 14, Math.max(1, barWidth - 1), height);
    });

    ctx.fillStyle = '#666666';
    ctx.font = '11px ui-monospace, Menlo, monospace';
    ctx.fillText(fmt(lo), 4, c.height - 3);
    const right = fmt(hi);
    ctx.fillText(right, c.width - ctx.measureText(right).width - 4, c.height - 3);
  }

  /* --- pointer: shared pan, zoom and probe --------------------------- */

  let dragging = null;
  let probePending = null;

  function normalisedFrom(event) {
    const rect = canvas.getBoundingClientRect();
    const fx = (event.clientX - rect.left) / rect.width;
    const fy = (event.clientY - rect.top) / rect.height;
    return { nx: viewport.x + fx * viewport.w, ny: viewport.y + fy * viewport.h };
  }

  function onWheel(event) {
    if (!canvas || !slot) return;
    event.preventDefault();
    const { nx, ny } = normalisedFrom(event);
    zoomAt(nx, ny, event.deltaY > 0 ? 1.15 : 1 / 1.15);
  }

  function onPointerDown(event) {
    if (!canvas || !slot) return;
    dragging = { x: event.clientX, y: event.clientY };
    canvas.setPointerCapture(event.pointerId);
  }

  function onPointerUp(event) {
    dragging = null;
    if (canvas?.hasPointerCapture?.(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
  }

  function onPointerMove(event) {
    if (!canvas || !slot) return;
    if (dragging) {
      const rect = canvas.getBoundingClientRect();
      panBy((event.clientX - dragging.x) / rect.width, (event.clientY - dragging.y) / rect.height);
      dragging.x = event.clientX;
      dragging.y = event.clientY;
      return;
    }
    // One rAF-throttled call returns a readout for every slot at once.
    probePending = event;
    if (probeScheduled) return;
    probeScheduled = true;
    requestAnimationFrame(() => {
      probeScheduled = false;
      const e = probePending;
      if (!e || !canvas) return;
      const { nx, ny } = normalisedFrom(e);
      showProbe(e.clientX, e.clientY, nx, ny);
    });
  }
  let probeScheduled = false;

  /* --- the slot picker ----------------------------------------------- */

  /*
   * Only the UNBOUND states offer these buttons now. Choosing a different slot
   * for a bound pane is the `slot` dropdown in the controls pane next door --
   * but a pane showing nothing has no controls worth reading yet, and a first
   * slot has to be reachable without one.
   */
  let available = $derived(bufferSlots());
</script>

<div class="slot-pane" bind:this={box} data-pane={paneId} data-slot={boundName ?? ''}>
  {#if !boundName}
    <div class="unbound">
      <p>This pane shows no slot yet.</p>
      {#if available.length === 0}
        <p class="hint">Run a command that produces one — try
          <code>A = pattern(kind=checker, width=512, height=512)</code>.</p>
      {:else}
        <div class="picker">
          {#each available as s (s.name)}
            <button onclick={() => bindSlot(s.name)}>{s.name}#{s.version}</button>
          {/each}
        </div>
      {/if}
    </div>
  {:else if !slot}
    <div class="unbound">
      <p>Slot <b>{boundName}</b> no longer exists.</p>
      <div class="picker">
        {#each available as s (s.name)}
          <button onclick={() => bindSlot(s.name)}>{s.name}#{s.version}</button>
        {/each}
        <button onclick={() => bindSlot(undefined)}>clear</button>
      </div>
    </div>
  {:else}
    <div class="stage">
      <canvas
        bind:this={canvas}
        id={`tile-canvas-${paneId}`}
        width={canvasSize.width}
        height={canvasSize.height}
        use:cpuBacked
        onwheel={onWheel}
        onpointerdown={onPointerDown}
        onpointerup={onPointerUp}
        onpointermove={onPointerMove}
        onpointerleave={hideProbe}
      ></canvas>
    </div>

    <div class="footer">
      <span class="readout">{error || readout}</span>
      <span class="zoom" title="screen pixels per image pixel">{zoomText}</span>
    </div>
  {/if}
</div>

<style>
  .slot-pane {
    width: 100%;
    height: 100%;
    display: flex;
    flex-direction: column;
    overflow: hidden;
    background: var(--cv-tile-bg, #ffffff);
    color: var(--cv-text, #333333);
    font: 12px ui-monospace, Menlo, Consolas, monospace;
  }

  .stage {
    flex: 1;
    min-height: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    overflow: hidden;
  }

  canvas {
    display: block;
    cursor: crosshair;
    touch-action: none;
    image-rendering: pixelated;
  }

  .footer {
    display: flex;
    justify-content: space-between;
    padding: 2px 6px;
    color: var(--cv-dim, #666666);
    border-top: 1px solid var(--cv-border, #cccccc);
    flex: 0 0 auto;
  }

  .unbound {
    flex: 1;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 8px;
    padding: 12px;
    text-align: center;
    color: var(--cv-dim, #666666);
  }

  .hint code {
    color: var(--cv-accent, #2a7edf);
  }

  .picker {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
    justify-content: center;
  }
  .picker button {
    background: var(--cv-input, #ffffff);
    border: 1px solid var(--cv-border, #cccccc);
    color: inherit;
    font: inherit;
    padding: 2px 8px;
    border-radius: 3px;
    cursor: pointer;
  }
  .picker button:hover { border-color: var(--cv-accent, #2a7edf); }
</style>
