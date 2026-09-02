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
  } from 'paneless';
  import { controlStore, controlEvents } from 'paneless';
  import { attachSlotControls, CONTROLS_WIDTH } from './panes/slot-controls.svelte.js';
  import 'paneless/styles/theme.css';

  import SlotPane from './panes/SlotPane.svelte';
  import LogPane from './panes/LogPane.svelte';
  import GeneratePane from './panes/GeneratePane.svelte';
  import CommandBar from './CommandBar.svelte';
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
  const byTitle = { Log: LogPane, Generate: GeneratePane };
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

  /**
   * A tiling rather than a cascade. Slot panes exist to be compared against
   * each other — §7's whole argument for uniform slots — so overlapping them
   * defeats the point. Four is the auto-open limit, which is exactly a 2x2.
   *
   * The log takes a column down the left; slots take the rest. Nothing is
   * reserved at the top any more: the command bar lives in the app header now,
   * not in a frame, which is what that space used to be held back for.
   */
  /*
   * Trimmed from 0.36 when slot frames grew a controls column and a wider
   * image. It is a FRACTION of a window that grew at the same time, so the log
   * keeps about the pixel width it always had -- roughly 400 -- while the
   * slots take the new room. Widening the window without this would have
   * spent a third of every added pixel on a column that did not need it.
   */
  const LOG_FRACTION = 0.28;

  function logFrameRect() {
    const { width, height } = contentBox();
    return {
      x: GAP,
      y: GAP,
      w: Math.round(width * LOG_FRACTION) - GAP,
      h: height - GAP * 2,
    };
  }

  /** paneless's SPLITTER_WIDTH, which sits between the two panes of a frame. */
  const SPLITTER_W = 6;

  /**
   * How many slot panes open by themselves. Declared here because the tiling
   * reads it: the grid has to hold exactly this many without overlapping.
   */
  const AUTO_PANE_LIMIT = 4;

  /**
   * The image half of a slot frame, at its default size.
   *
   * A slot frame is a controls column plus an image, and only the image half
   * is what a slot pane is FOR -- so the frame is sized from the image and the
   * column is a fixed cost added beside it, rather than the image taking
   * whatever a share of the frame happens to leave.
   *
   * This number only governed the COLUMN COUNT at first: the frame was then
   * stretched to fill its cell, so a single-column layout gave an image of
   * ~690px however small this said. It is a width now, and a frame that does
   * not need the whole cell does not take it.
   */
  const SLOT_IMAGE_W = 345;

  /** Below this a slot frame is a letterbox, not a view of an image. */
  const SLOT_MIN_H = 320;

  /**
   * The grid of slot frames, from what actually fits.
   *
   * Not a fixed 2x2 any more. The frames are wider than they were, and on a
   * display that cannot hold two of them side by side a fixed grid would put
   * the right-hand column off the edge — which is the bug the tiling was
   * introduced to fix in the first place.
   *
   * Both axes are sized from what a frame NEEDS rather than from how many
   * there are. Deriving rows from AUTO_PANE_LIMIT instead gave four 189px
   * rows on a 1470px display: all four visible, none of them usable. Fewer
   * cells and a real image is the better trade, and the ones past the last
   * cell wrap onto it — they are still there, still draggable, and the limit
   * still stops them accumulating.
   */
  function slotGrid(areaW, areaH) {
    const wantW = CONTROLS_WIDTH + SPLITTER_W + SLOT_IMAGE_W;
    const cols = Math.max(1, Math.min(2, Math.floor((areaW + GAP) / (wantW + GAP))));
    const rows = Math.max(1, Math.min(
      Math.ceil(AUTO_PANE_LIMIT / cols),
      Math.floor((areaH + GAP) / (SLOT_MIN_H + GAP))
    ));
    return { cols, rows };
  }

  function slotFrameRect(index) {
    const { width, height } = contentBox();
    const left = Math.round(width * LOG_FRACTION) + GAP;
    const areaW = width - left - GAP;
    const areaH = height - GAP * 2;
    const { cols, rows } = slotGrid(areaW, areaH);
    const cellW = Math.floor((areaW - GAP * (cols - 1)) / cols);
    const cellH = Math.floor((areaH - GAP * (rows - 1)) / rows);
    const col = index % cols, row = Math.floor(index / cols) % rows;
    return {
      x: left + col * (cellW + GAP),
      y: GAP + row * (cellH + GAP),
      // Cells are where frames GO, not how big they are. A frame takes the
      // width it asked for and leaves the rest of its cell empty, because the
      // alternative is an image stretched to whatever the window happened to
      // leave over -- which is how a 345px image became a 690px one.
      w: Math.min(cellW, CONTROLS_WIDTH + SPLITTER_W + SLOT_IMAGE_W),
      h: cellH,
    };
  }

  /**
   * Give a frame's root pane a component and a title.
   *
   * Frames and their panes are created without chrome. The lab already labels
   * everything that matters inside the content — a slot pane shows its own
   * name, dimensions, dtype and colour space along the top — so a frame header
   * saying "Slot A" above a pane header saying "Slot A" above a control row
   * saying "A#1 256x256x1 f32 linear" was three bars of furniture for one
   * fact.
   *
   * `headerVisible: false` rather than `headerEnabled: false`, deliberately:
   * hidden until hovered, rather than gone. The header carries the drag handle
   * and the close button for a frame, and split/tab for a pane, so removing it
   * outright would take real function with it. Hover brings it back.
   */
  function makeFrame(title, component, x, y, w, h) {
    const frame = frames.addFrame(x, y, w, h, {
      title,
      headerVisible: false,
      footerVisible: false,
      rootPane: { headerVisible: false },
    });
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

  /**
   * How much of a slot frame the controls column starts with.
   *
   * A fraction, because that is what paneless stores -- but derived from the
   * column's own intrinsic width, because a fraction is the wrong unit for it:
   * the controls do not get more useful when the frame is wide, they just need
   * to fit. A guessed 0.42 clipped "linear" in a default-sized frame.
   *
   * Clamped so a very small frame still shows some image and a very large one
   * does not leave the column swimming. Never exactly 0.5: paneless reads a
   * stored ratio back only when it differs from 0.5, so a deliberate half
   * would silently become its default half -- which happens to be the same
   * number, and would stop being so the moment either side changed.
   */
  function controlsRatio(frameWidth) {
    const wanted = CONTROLS_WIDTH / Math.max(1, frameWidth);
    const ratio = Math.min(0.6, Math.max(0.22, wanted));
    return ratio === 0.5 ? 0.499 : ratio;
  }

  /**
   * Split a pane into left and right children, synchronously.
   *
   * paneless does this in Pane.svelte's own handler, and offers `pendingSplit`
   * for triggering it from outside -- but that runs in an effect, one render
   * later, and newSlotPane has to return the pane it made. So this does what
   * handleSplitH does: a new container takes the original pane's place in the
   * tree, the original becomes the left child, and a right child is added
   * beside it. The tab branches of the original are not reproduced because a
   * frame's root pane is never tabbed at the moment it is created.
   *
   * The original pane becoming the LEFT child is why the controls end up there
   * and the image is the new pane, rather than the other way round.
   */
  function splitHorizontally(paneId, leftRatio) {
    const pane = paneStore.getPane(paneId);
    if (!pane) return null;
    const containerId = paneStore.addChildPane(pane.frameId, pane.parentId, pane.position ?? 'left');
    const rightId = paneStore.addChildPane(pane.frameId, containerId, 'right');
    paneStore.updatePane(paneId, { parentId: containerId, position: 'left' });
    paneStore.updatePane(containerId, {
      isSplit: true,
      leftChildId: paneId,
      rightChildId: rightId,
      leftRatio,
      rightRatio: 1 - leftRatio,
      headerVisible: false,
    });
    // Re-point the grandparent, for the case where the pane being split is
    // already a child. A frame root has no parent and needs none of this.
    if (pane.parentId && pane.position) {
      paneStore.updatePane(pane.parentId, { [`${pane.position}ChildId`]: containerId });
    }
    return { containerId, leftId: paneId, rightId };
  }

  /** controls paneId -> dispose, so a closed frame does not leak its column. */
  const slotControls = new Map();

  let paneData = $state({ byId: {} });
  $effect(() => paneStore.subscribe((data) => { paneData = data; }));

  /*
   * Drop a controls column when its pane goes.
   *
   * Keyed off the pane table rather than a 'paneRemoved' event, because a pane
   * can leave in more than one way -- closing the frame, dragging the pane
   * elsewhere, unsplitting -- and only one of those has to be true for the
   * column's store entry and its subscriptions to be garbage. Absence covers
   * all of them.
   */
  $effect(() => {
    for (const [id, dispose] of slotControls) {
      if (!paneData.byId[id]) {
        dispose();
        slotControls.delete(id);
      }
    }
  });

  const slotPaneIds = () =>
    Object.keys(paneData.byId).filter((id) => contentRegistry.get(id) === SlotPane);

  /**
   * A slot frame is two panes: its controls, and the image they describe.
   *
   * The controls are paneless's own -- SVG controls in a pane whose
   * contentType is 'controls', built by slot-controls.svelte.js -- so the
   * splitter between them is a real splitter and the column can be widened
   * when a colormap name does not fit.
   *
   * The IMAGE pane keeps the slot's identity: paneless's `name`, the title,
   * and the entry in contentRegistry that makes it a slot pane. Everything
   * that already asked "which panes show slots?" therefore still gets the
   * answer it expects, and the column reads the name off its sibling.
   */
  function newSlotPane(slotName) {
    const rect = slotFrameRect(slotPaneIds().length);
    const rootId = makeFrame('Slot', SlotPane, rect.x, rect.y, rect.w, rect.h);
    if (!rootId) return null;

    const split = splitHorizontally(rootId, controlsRatio(rect.w));
    if (!split) return rootId;

    contentRegistry.delete(split.leftId);
    paneStore.updatePane(split.leftId, {
      contentType: 'controls',
      title: 'Controls',
      titleVisible: false,
      headerVisible: false,
    });

    contentRegistry.set(split.rightId, SlotPane);
    paneStore.updatePane(split.rightId, {
      title: 'Slot',
      titleVisible: true,
      headerVisible: false,
    });

    slotControls.set(split.leftId, attachSlotControls(split.leftId, split.rightId));
    if (slotName) bindSlotPane(split.rightId, slotName);
    return split.rightId;
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
   * otherwise open a pane — up to AUTO_PANE_LIMIT, past which new slots wait
   * to be picked rather than burying the layout under frames nobody asked for.
   */
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
      // The controls in a slot pane are paneless controls, so they are store
      // entries rather than DOM elements. A test needs the store to find one
      // by name, and the event bus to change one: driving the rendered SVG
      // would be testing paneless's hit-testing, not this app's wiring.
      controlStore,
      controlEvents,
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
      menuCommand: (id) => onMenuCommand(id),
      paneMenu: (paneId) => paneMenuProvider(paneId, []),
    };
  }

  /** @type {any} */
  let commandBar = $state();

  onMount(() => {
    exposeForTests();
    actions.saveSession = saveSession;
    actions.resetSession = resetSession;
    actions.newSlotPane = () => newSlotPane(null);
    setDefaultPaneContentProvider(paneContentProvider);
    setDefaultPaneMenuProvider(paneMenuProvider);

    // The application menu is native now, so paneless's own app menu and its
    // title-click trigger are both gone -- see showTitle on PanelessContainer.
    const offMenu = lab.onMenuCommand(onMenuCommand);
    publishMenuState();

    const log = logFrameRect();
    makeFrame('Log', LogPane, log.x, log.y, log.w, log.h);
    newSlotPane(null);

    refreshSlots();
    setStatus(
      'Ready. Enter a command, or pick an operation to insert a template. ' +
        'Scroll a tile to zoom, drag to pan.'
    );
    commandBar?.focus();
    return offMenu;
  });

  /* ------------------------------------------------------------------ */
  /* the application menu                                                */
  /* ------------------------------------------------------------------ */

  /**
   * Mirror the settings the menu displays back to the main process.
   *
   * An Electron menu template is a SNAPSHOT: the radio tick beside the current
   * scaling mode and the checkbox beside the overlay do not follow this state
   * on their own, and neither does whether Reset View is enabled. Main rebuilds
   * the whole menu whenever this arrives, which is cheap and much simpler than
   * reaching in to mutate individual items.
   */
  function publishMenuState() {
    lab.setMenuState({
      scaling: display.scaling,
      overlay: display.overlay,
      viewIsReset: isViewReset(),
    });
  }

  $effect(() => {
    void display.scaling; void display.overlay;
    void viewport.x; void viewport.y; void viewport.w; void viewport.h;
    publishMenuState();
  });

  function onMenuCommand(id) {
    if (id.startsWith('scaling:')) {
      display.scaling = id.slice('scaling:'.length);
      setStatus(`Scaling: ${display.scaling}`);
      return;
    }
    switch (id) {
      case 'open-image': commandBar?.openImage(); break;
      case 'save-session': saveSession(); break;
      case 'reset-session': resetSession(); break;
      case 'toggle-overlay':
        display.overlay = !display.overlay;
        setStatus(`Fits ${display.overlay ? 'drawn over' : 'hidden on'} matching tiles`);
        break;
      case 'reset-view':
        resetViewport();
        setStatus('View reset to the whole image.');
        break;
      case 'new-slot-pane': newSlotPane(null); break;
      case 'generate': {
        // One at a time: a second frame would race the first over the same
        // output directory and the same GPU.
        const open = Object.entries(paneData.byId)
          .find(([id]) => contentRegistry.get(id) === GeneratePane);
        if (open) { setStatus('The Generate frame is already open.'); break; }
        const box = contentBox();
        makeFrame('Generate', GeneratePane,
          Math.round(box.width * 0.18), Math.round(box.height * 0.14),
          Math.round(box.width * 0.64), Math.round(box.height * 0.6));
        break;
      }
      case 'new-log-pane': {
        const log = logFrameRect();
        makeFrame('Log', LogPane, log.x, log.y, log.w, log.h);
        break;
      }
      default: break;
    }
  }

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
    <!--
      showTitle={false}: on macOS and Windows the window chrome already names
      the app twice — title bar and menu bar — so paneless's own title is a
      third copy. Its click was also the app menu's only trigger, which is why
      this is only safe now that the menu is native.
    -->
    <PanelessContainer showTitle={false}>
      {#snippet headerContent()}
        <CommandBar bind:this={commandBar} />
      {/snippet}
    </PanelessContainer>
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
  <!--
    No pointer handler here, deliberately. The probe sets pointer-events:none
    so it never sits between the cursor and the canvas underneath it, which
    means it cannot receive a pointerleave either -- the handler that used to
    be here was unreachable, and Svelte was right to ask what role an element
    with a pointer handler was playing. SlotPane's canvas hides it.
  -->
  <div class="probe" bind:this={probeEl} style={probeStyle}>
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
    background: var(--cv-chrome, #f0f0f0);
    border-top: 1px solid var(--cv-border, #cccccc);
    color: var(--cv-text, #333333);
    font: 11px ui-monospace, Menlo, Consolas, monospace;
  }
  .statusbar .grow { flex: 1; }
  .statusbar .versions { color: var(--cv-dim, #666666); }
  .statusbar .ok { color: #1a7f37; }
  .statusbar .error { color: #c0362c; }

  .probe {
    position: fixed;
    z-index: 9999;
    pointer-events: none;
    background: rgba(255, 255, 255, 0.94);
    border: 1px solid var(--cv-border, #cccccc);
    /* It floats over the image, and a pale box on a pale photograph needs an
       edge of its own to stay legible. */
    box-shadow: 0 1px 4px rgba(0, 0, 0, 0.2);
    border-radius: 4px;
    padding: 6px 8px;
    color: var(--cv-text, #333333);
    font: 11px/1.5 ui-monospace, Menlo, Consolas, monospace;
    white-space: pre;
  }
  .probe .pk { color: var(--cv-accent, #2a7edf); }
</style>
