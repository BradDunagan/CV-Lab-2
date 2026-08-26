<script>
  /**
   * The lab, as paneless frames and panes.
   *
   * What did NOT change with this port, and must not: the preload still owns
   * the session, every buffer handle and every pixel, and nothing but a canvas
   * id and small result objects crosses the contextBridge. Svelte owns the DOM
   * and only the DOM.
   *
   * The layout follows rr's pattern rather than building splits by hand: a
   * frame per thing, with content registered against the frame's root pane.
   * Splitting, tabbing and dragging panes between frames are paneless's job
   * and are available from its own pane menus — this file does not reimplement
   * any of it, which is most of the point of using it.
   */
  import { onMount } from 'svelte';
  import {
    PanelessContainer,
    frames,
    paneStore,
    setDefaultPaneContentProvider,
    setDefaultPaneMenuProvider,
    setDefaultAppMenuProvider,
    appTitle,
  } from 'paneless';
  import 'paneless/styles/theme.css';

  import SlotPane from './panes/SlotPane.svelte';
  import CommandPane from './panes/CommandPane.svelte';
  import LogPane from './panes/LogPane.svelte';
  import {
    lab, viewport, display, slots, probe, status, setStatus, actions,
    refreshSlots, resetViewport, isViewReset, clearSession, hideProbe, bufferSlots,
  } from './lab.svelte.js';

  /* ------------------------------------------------------------------ */
  /* which component each pane shows                                     */
  /* ------------------------------------------------------------------ */

  /** @type {Map<string, any>} paneId -> component */
  const contentRegistry = new Map();

  /**
   * Titles double as a content key.
   *
   * Panes can outlive this registry — a saved layout restores panes before
   * anything re-registers them, and paneless can move a pane into a frame this
   * file never created. rr solves it the same way: fall back to the title, and
   * re-register what the fallback resolved so the lookup is cheap next time.
   */
  const byTitle = { Command: CommandPane, Log: LogPane };
  const isSlotTitle = (t) => typeof t === 'string' && (t === 'Slot' || t.startsWith('Slot '));

  function paneContentProvider(paneId, meta) {
    const registered = contentRegistry.get(paneId);
    if (registered) return registered;
    const title = meta?.title;
    const component = isSlotTitle(title) ? SlotPane : byTitle[title];
    if (component) {
      contentRegistry.set(paneId, component);
      return component;
    }
    return null;
  }

  /* ------------------------------------------------------------------ */
  /* where frames go                                                     */
  /* ------------------------------------------------------------------ */

  /**
   * The area frames actually live in.
   *
   * Not the window: paneless puts a collapsible sidebar down the left and its
   * own header and footer above and below, and laying out against
   * `window.innerWidth` is what produced four slot frames stacked on each
   * other with their right edges off-screen. Measured, with a floor so a very
   * small window still gets a usable arrangement rather than degenerate rects.
   */
  function contentBox() {
    const rect = document.querySelector('.app-content')?.getBoundingClientRect();
    return {
      width: Math.max(720, Math.floor(rect?.width ?? window.innerWidth)),
      height: Math.max(520, Math.floor(rect?.height ?? window.innerHeight)),
    };
  }

  const GAP = 8;
  /*
   * Tall enough for the pane's content plus a frame's chrome. A frame spends
   * roughly 80px on its own header, the pane header and the title bar before
   * the component gets a pixel, which is what clipped the command bar's hint
   * line when this was set from the content height alone. Two rows now: the
   * command line and the toolbar under it.
   */
  const COMMAND_H = 212;

  /**
   * A tiling rather than a cascade. Slot panes exist to be compared against
   * each other — §7's whole argument for uniform slots — so overlapping them
   * defeats the point. Four is the auto-open limit, which is exactly a 2x2.
   */
  function slotFrameRect(index) {
    const { width, height } = contentBox();
    const logW = Math.round(width * 0.36);
    const left = logW + GAP * 2;
    const areaW = width - left - GAP;
    const areaH = height - COMMAND_H - GAP * 3;
    const cols = 2, rows = 2;
    const cellW = Math.floor((areaW - GAP) / cols);
    const cellH = Math.floor((areaH - GAP) / rows);
    const col = index % cols, row = Math.floor(index / cols) % rows;
    return {
      x: left + col * (cellW + GAP),
      y: COMMAND_H + GAP * 2 + row * (cellH + GAP),
      w: cellW,
      h: cellH,
    };
  }

  /** Give a frame's root pane a component and a title. */
  function makeFrame(title, component, x, y, w, h) {
    const frame = frames.addFrame(x, y, w, h, { title });
    const panes = paneStore.getPanesByFrameId(String(frame.id));
    if (panes.length === 0) return null;
    const rootId = panes[0].id;
    contentRegistry.set(rootId, component);
    paneStore.updatePane(rootId, { title, titleVisible: true });
    return rootId;
  }

  /* ------------------------------------------------------------------ */
  /* slot panes                                                          */
  /* ------------------------------------------------------------------ */

  let paneData = $state({ byId: {} });
  $effect(() => paneStore.subscribe((data) => { paneData = data; }));

  const slotPaneIds = () =>
    Object.keys(paneData.byId).filter((id) => contentRegistry.get(id) === SlotPane);

  function newSlotPane(slotName) {
    const rect = slotFrameRect(slotPaneIds().length);
    const rootId = makeFrame('Slot', SlotPane, rect.x, rect.y, rect.w, rect.h);
    if (rootId && slotName) bindSlotPane(rootId, slotName);
    return rootId;
  }

  function bindSlotPane(paneId, slotName) {
    paneStore.setName(paneId, slotName);
    paneStore.updatePane(paneId, { title: `Slot ${slotName}`, titleVisible: true });
  }

  /**
   * Show a newly-produced slot without being asked.
   *
   * The old UI rebuilt a grid of every slot after every command, which is what
   * made "type a command, see the result" true. Panes are user-arranged, so
   * that reflex has to be deliberate: fill an empty slot pane if there is one,
   * otherwise open a pane — up to a limit, past which new slots wait to be
   * picked rather than burying the layout under frames nobody asked for.
   */
  const AUTO_PANE_LIMIT = 4;
  let seen = new Set();

  function showNewSlots() {
    const buffers = bufferSlots();
    const fresh = buffers.filter((s) => !seen.has(s.name));
    for (const s of buffers) seen.add(s.name);
    for (const name of [...seen]) {
      if (!buffers.some((s) => s.name === name)) seen.delete(name);
    }
    if (fresh.length === 0) return;

    const ids = slotPaneIds();
    const bound = new Set(ids.map((id) => paneData.byId[id]?.name).filter(Boolean));
    let empty = ids.filter((id) => !paneData.byId[id]?.name);

    for (const slot of fresh) {
      if (bound.has(slot.name)) continue;
      if (empty.length > 0) {
        bindSlotPane(empty.shift(), slot.name);
      } else if (ids.length + 1 <= AUTO_PANE_LIMIT) {
        newSlotPane(slot.name);
        ids.push('new');
      } else {
        setStatus(
          `${slot.name} is ready. Open a slot pane from the app menu to see it ` +
            `— ${AUTO_PANE_LIMIT} panes are open already.`
        );
      }
    }
  }

  /* ------------------------------------------------------------------ */
  /* menus                                                               */
  /* ------------------------------------------------------------------ */

  async function saveSession() {
    try {
      const path = await lab.saveSession();
      setStatus(path ? `Saved ${path}` : 'Save cancelled', path ? 'ok' : '');
    } catch (err) {
      setStatus(err.message, 'error');
    }
  }

  async function resetSession() {
    const entries = lab.log().length;
    // Only confirm when there is something to lose. Discarding an empty
    // session is not a decision worth interrupting for.
    if (entries > 0) {
      const answer = await lab.confirmReset(entries);
      if (answer === 'cancel') return;
      if (answer === 'save') {
        const saved = await lab.saveSession();
        if (!saved) { setStatus('Save cancelled — nothing was discarded.'); return; }
      }
    }
    const discarded = clearSession();
    seen = new Set();
    for (const id of slotPaneIds()) {
      paneStore.setName(id, undefined);
      paneStore.updatePane(id, { title: 'Slot' });
    }
    setStatus(
      discarded.entries === 0
        ? 'Nothing to discard.'
        : `Discarded ${discarded.slots} slot(s) and ${discarded.entries} log entries.`,
      'ok'
    );
  }

  function appMenuProvider(_contextId, suggested) {
    const scalingItems = ['smooth', 'pixels', 'actual'].map((mode) => ({
      id: `scaling-${mode}`,
      type: 'button',
      label: `${display.scaling === mode ? '● ' : '   '}${mode}`,
      onClick: () => { display.scaling = mode; },
    }));

    return [
      { id: 'new-slot-pane', type: 'button', label: 'New slot pane', onClick: () => newSlotPane(null) },
      { id: 'new-log-pane', type: 'button', label: 'New log pane',
        onClick: () => { const b = contentBox();
          makeFrame('Log', LogPane, GAP, COMMAND_H + GAP * 2,
            Math.round(b.width * 0.36), b.height - COMMAND_H - GAP * 3); } },
      { id: 'new-command-pane', type: 'button', label: 'New command pane',
        onClick: () => { const b = contentBox();
          makeFrame('Command', CommandPane, GAP, GAP, b.width - GAP * 2, COMMAND_H); } },
      { id: 'sep-view', type: 'separator' },
      { id: 'overlay', type: 'button',
        label: `${display.overlay ? '● ' : '   '}Draw fits over tiles`,
        onClick: () => { display.overlay = !display.overlay; } },
      { id: 'scaling', type: 'submenu', label: 'Scaling', items: scalingItems },
      { id: 'reset-view', type: 'button', label: 'Reset view', enabled: !isViewReset(),
        onClick: () => { resetViewport(); setStatus('View reset to the whole image.'); } },
      { id: 'sep-session', type: 'separator' },
      { id: 'save-session', type: 'button', label: 'Save session…', onClick: saveSession },
      { id: 'reset-session', type: 'button', label: 'Discard session…', onClick: resetSession },
      ...(suggested.length ? [{ id: 'sep-paneless', type: 'separator' }, ...suggested] : []),
    ];
  }

  /**
   * Slot panes get one extra item: which slot they show. Everything else in a
   * pane's menu — split, tab, collapse — is paneless's and is left alone.
   */
  function paneMenuProvider(paneId, suggested) {
    if (contentRegistry.get(paneId) !== SlotPane) return suggested;
    const buffers = bufferSlots();
    const current = paneData.byId[paneId]?.name;
    const items = buffers.map((s) => ({
      id: `slot-${s.name}`,
      type: 'button',
      label: `${s.name === current ? '● ' : '   '}${s.name}#${s.version}`,
      onClick: () => bindSlotPane(paneId, s.name),
    }));
    if (items.length === 0) {
      items.push({ id: 'no-slots', type: 'button', label: 'no slots yet', enabled: false });
    }
    return [
      { id: 'slot', type: 'submenu', label: 'Show slot', items },
      { id: 'sep-slot', type: 'separator' },
      ...suggested,
    ];
  }

  /* ------------------------------------------------------------------ */

  const versions = lab.versions;

  /*
   * A named surface for tests and devtools -- NOT an API, and deliberately not
   * on `window.lab`, which is the contextBridge and stays exactly as narrow as
   * it was. This is page script reaching page script: it can already do
   * everything here by clicking, and test/renderer.js needs to arrange a
   * layout without simulating a menu walk. rr exposes its stores the same way
   * for the same reason.
   */
  function exposeForTests() {
    globalThis.__cvlab = {
      paneStore,
      frames,
      newSlotPane,
      bindSlotPane,
      slotPaneIds,
      componentFor: (paneId) => contentRegistry.get(paneId)?.name ?? null,
      display,
      viewport,
      // The menu PROVIDERS rather than the rendered menus. Walking paneless's
      // DOM to click an item would test paneless; calling the provider and
      // invoking an item's onClick tests the wiring this file owns, which is
      // the part that can be wrong.
      appMenu: () => appMenuProvider('app', []),
      paneMenu: (paneId) => paneMenuProvider(paneId, []),
    };
  }

  onMount(() => {
    exposeForTests();
    actions.saveSession = saveSession;
    actions.resetSession = resetSession;
    actions.newSlotPane = () => newSlotPane(null);
    setDefaultPaneContentProvider(paneContentProvider);
    setDefaultPaneMenuProvider(paneMenuProvider);
    setDefaultAppMenuProvider(appMenuProvider);
    appTitle.set('cv-lab-2', { fontWeight: '600' });

    const box = contentBox();
    makeFrame('Command', CommandPane, GAP, GAP, box.width - GAP * 2, COMMAND_H);
    makeFrame('Log', LogPane, GAP, COMMAND_H + GAP * 2,
      Math.round(box.width * 0.36), box.height - COMMAND_H - GAP * 3);
    newSlotPane(null);

    refreshSlots();
    setStatus(
      'Ready. Enter a command, or pick an operation to insert a template. ' +
        'Scroll a tile to zoom, drag to pan.'
    );

  });

  // Slots change only as a result of a command, and `slots.list` is replaced
  // wholesale when one runs — so this is the one place new slots are noticed.
  $effect(() => {
    void slots.list;
    showNewSlots();
  });

  /* --- the probe overlay, positioned in viewport coordinates --------- */

  let probeEl = $state();
  let probeStyle = $state('');
  $effect(() => {
    if (!probe.visible || !probeEl) return;
    const pad = 14;
    const box = probeEl.getBoundingClientRect();
    const left = probe.x + pad + box.width > window.innerWidth
      ? probe.x - pad - box.width : probe.x + pad;
    const top = probe.y + pad + box.height > window.innerHeight
      ? probe.y - pad - box.height : probe.y + pad;
    probeStyle = `left:${Math.max(0, left)}px; top:${Math.max(0, top)}px`;
  });

  let probeLines = $derived.by(() => {
    if (!probe.readings) return [];
    const names = Object.keys(probe.readings);
    if (names.length === 0) return [];
    const width = Math.max(...names.map((n) => n.length));
    const first = probe.readings[names[0]];
    const lines = [{ key: `(${first.x}, ${first.y})`, value: '' }];
    for (const name of names) {
      const { values } = probe.readings[name];
      lines.push({
        key: name.padEnd(width),
        value: values === null
          ? '—'
          : values.map((x) => (Number.isInteger(x) ? x : x.toFixed(4))).join('  '),
      });
    }
    return lines;
  });
</script>

<div class="shell">
  <div class="stage">
    <PanelessContainer />
  </div>

  <div class="statusbar">
    <span class={status.kind} id="status">{status.text}</span>
    <span class="grow"></span>
    <span class="versions">
      Electron {versions.electron} · Chromium {versions.chrome} · Node {versions.node}
      · {versions.platform}/{versions.arch}
    </span>
  </div>
</div>

<!--
  One readout for EVERY slot at once (§7). Rendered at the app level rather
  than per pane, because it deliberately reports across all of them — that is
  the whole affordance, and it exists only because slots are uniform.
-->
{#if probe.visible && probeLines.length > 0}
  <div class="probe" bind:this={probeEl} style={probeStyle} onpointerleave={hideProbe}>
    {#each probeLines as line}
      <div><span class="pk">{line.key}</span>{line.value ? `  ${line.value}` : ''}</div>
    {/each}
  </div>
{/if}

<style>
  .shell {
    height: 100vh;
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }

  .stage {
    flex: 1;
    min-height: 0;
    position: relative;
  }

  .statusbar {
    flex: 0 0 auto;
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 3px 8px;
    background: var(--cv-chrome, #17171d);
    border-top: 1px solid var(--cv-border, #2a2a33);
    color: var(--cv-text, #d8d8e0);
    font: 11px ui-monospace, Menlo, Consolas, monospace;
  }
  .statusbar .grow { flex: 1; }
  .statusbar .versions { color: var(--cv-dim, #7c7c8a); }
  .statusbar .ok { color: #7ee787; }
  .statusbar .error { color: #ff7b81; }

  .probe {
    position: fixed;
    z-index: 9999;
    pointer-events: none;
    background: rgba(10, 10, 14, 0.94);
    border: 1px solid var(--cv-border, #2a2a33);
    border-radius: 4px;
    padding: 6px 8px;
    color: var(--cv-text, #d8d8e0);
    font: 11px/1.5 ui-monospace, Menlo, Consolas, monospace;
    white-space: pre;
  }
  .probe .pk { color: var(--cv-accent, #6ea8fe); }
</style>
