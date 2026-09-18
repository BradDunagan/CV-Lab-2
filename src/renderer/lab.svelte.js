/**
 * The renderer's shared state.
 *
 * Everything privileged still goes through `window.lab` — the preload owns the
 * session, every buffer handle and every pixel, exactly as before. What changed
 * with the paneless port is only who owns the DOM: panes are Svelte components
 * now, so the state they share has to live somewhere both of them can see.
 *
 * Runes rather than a store: a `$state` object is deeply reactive, so a pane's
 * `$effect` that reads `viewport.x` re-runs when any other pane pans. That is
 * the whole of the synchronised pan and zoom in design-lab-model.md §7, and it
 * used to be a manual `redrawAll()` loop.
 */

/** @type {any} */
const lab = globalThis.window?.lab;
if (!lab) {
  throw new Error(
    'window.lab is missing. This page only runs inside the cv-lab-2 Electron ' +
      'window, where src/preload.js exposes it.'
  );
}

export { lab };

/* ------------------------------------------------------------------ */
/* the shared viewport — §7                                            */
/* ------------------------------------------------------------------ */

/**
 * Normalised 0..1 so slots of different sizes stay in step. A 4096-wide slot
 * and a 256-wide one showing "the middle third" both mean x=0.33, w=0.33.
 */
export const viewport = $state({ x: 0, y: 0, w: 1, h: 1 });

export const isViewReset = () =>
  viewport.x === 0 && viewport.y === 0 && viewport.w === 1 && viewport.h === 1;

export function resetViewport() {
  viewport.x = 0;
  viewport.y = 0;
  viewport.w = 1;
  viewport.h = 1;
}

const clamp01 = (value, size) => Math.min(Math.max(value, 0), Math.max(0, 1 - size));

/** Zoom about a normalised point, keeping what is under the cursor fixed. */
export function zoomAt(nx, ny, factor) {
  const w = Math.min(1, Math.max(1 / 512, viewport.w * factor));
  const h = Math.min(1, Math.max(1 / 512, viewport.h * factor));
  viewport.x = clamp01(viewport.x + (nx - viewport.x) * (1 - w / viewport.w), w);
  viewport.y = clamp01(viewport.y + (ny - viewport.y) * (1 - h / viewport.h), h);
  viewport.w = w;
  viewport.h = h;
}

export function panBy(dxFraction, dyFraction) {
  viewport.x = clamp01(viewport.x - dxFraction * viewport.w, viewport.w);
  viewport.y = clamp01(viewport.y - dyFraction * viewport.h, viewport.h);
}

/* ------------------------------------------------------------------ */
/* display settings shared by every tile                               */
/* ------------------------------------------------------------------ */

/**
 * How slots are scaled into their panes. Shared rather than per-pane, because
 * comparing two slots drawn at different scales is misleading.
 *
 *   smooth  fit the pane; interpolate when magnifying
 *   pixels  fit the pane; nearest when magnifying, so pixel edges stay crisp
 *   actual  never magnify — a 128x128 slot simply appears small
 */
/**
 * What each tile draws, PER SLOT.
 *
 * Per slot rather than one setting for the app, and not as a preference: the
 * tiles show different stages of one pipeline, so an overlay that is the point
 * on the beauty image is noise on the gradient beside it. Corners drawn over
 * `R`'s label map while they are off over `A` is a comparison; one switch for
 * every tile at once cannot express it.
 *
 * Keyed by slot name, the way `views` is, and dropped by refreshSlots when the
 * slot goes -- for the same reason: the name is the identity a pane binds to.
 */
const overlays = $state({ byName: {} });

/**
 * What a slot starts with, and what the menu's two items set.
 *
 * Nothing, and that is the point: a slot shows what the operation produced
 * until someone asks for more. A pipeline binds a dozen slots at once, and
 * every one of them coming up under red lines and green crosses buries the
 * images they are drawn on -- which is what the marks are FOR being compared
 * against. Each overlay is one checkbox away, per slot.
 */
export const display = $state({
  scaling: 'smooth',
  defaults: { 'truth-edge': false, 'truth-vertex': false, segment: false, corner: false },
});

/** The two groups the application menu toggles, together, everywhere. */
export const DETECTION_KINDS = ['segment', 'corner'];
export const TRUTH_KINDS = ['truth-edge', 'truth-vertex'];

/**
 * The overlay flags for one slot, created from the defaults on first ask.
 *
 * Lazily rather than in refreshSlots, so a slot REBOUND while a pipeline runs
 * -- same name, new version -- keeps what was chosen for it. Null for no slot,
 * which is what a pane shows before it is bound.
 */
export function kindsFor(slotName) {
  if (!slotName) return null;
  if (!overlays.byName[slotName]) overlays.byName[slotName] = { ...display.defaults };
  return overlays.byName[slotName];
}

/** Is any kind in `group` drawn anywhere, or set to be? The menu ticks on that. */
export const anyDrawn = (group) =>
  group.some((role) => display.defaults[role]) ||
  Object.values(overlays.byName).some((kinds) => group.some((role) => kinds[role]));

/**
 * Turn a whole group on everywhere, or off everywhere if any of it is on.
 *
 * The menu is the only thing that speaks for every slot at once, so it writes
 * to all of them AND to the defaults -- otherwise a slot bound afterwards
 * would arrive with the setting the menu had just cleared.
 */
export function toggleKinds(group) {
  const on = anyDrawn(group);
  for (const role of group) {
    display.defaults[role] = !on;
    for (const kinds of Object.values(overlays.byName)) kinds[role] = !on;
  }
  return !on;
}

/**
 * The tooltip a control asked for, and where to draw it.
 *
 * paneless renders its controls as SVG from metadata and has no tooltip of its
 * own, so the text lives here, keyed by the control id it put in the DOM, and
 * App.svelte watches the pointer. Registered by whoever built the control and
 * dropped when that column goes away.
 */
export const controlTips = new Map();
export const tooltip = $state({ text: '', x: 0, y: 0, visible: false });

/* ------------------------------------------------------------------ */
/* slots                                                              */
/* ------------------------------------------------------------------ */

/** @type {{ list: any[] }} */
export const slots = $state({ list: [] });

/** Per-slot display transform. Non-destructive: none of this touches a buffer. */
const views = $state({ byName: {} });

/**
 * §6's defaults by data kind. Getting these right is what makes a Sobel
 * response readable instead of a grey smear.
 */
function defaultView(info) {
  if (info.dtype === 'i32') {
    /*
     * A label map is an identity, not a measurement: never interpolate it.
     *
     * `mask` rather than `categorical`, because the question a segment map is
     * usually asked is "where is there a segment" -- and a dozen hues answer
     * "which segment is this one" loudly, over the top of the overlay drawn on
     * the same tile. Identity is one dropdown away when it is what is wanted.
     */
    return { type: 'image', colormap: 'mask', range: 'auto', curve: 'linear', channel: -1 };
  }
  if (info.space === 'none') {
    // Signed data — gradients. Symmetric about zero, diverging colormap.
    return { type: 'image', colormap: 'diverging', range: 'symmetric', curve: 'linear', channel: -1 };
  }
  return { type: 'image', colormap: 'gray', range: 'auto', curve: 'linear', channel: -1 };
}

export function viewOf(slotName) {
  return views.byName[slotName] ?? null;
}

export function slotNamed(name) {
  return slots.list.find((s) => s.name === name) ?? null;
}

/** Slots that hold pixels. Feature lists have no tile of their own (§1). */
export const bufferSlots = () => slots.list.filter((s) => s.kind === 'buffer');

/**
 * Re-read the slot table from the preload.
 *
 * Called after every command. Views are created for new slots and dropped for
 * departed ones, so a slot name reused later starts from the default for its
 * data kind rather than inheriting a stale transform.
 */
export function refreshSlots() {
  slots.list = lab.slots();
  for (const slot of slots.list) {
    if (slot.kind === 'buffer' && !views.byName[slot.name]) {
      views.byName[slot.name] = defaultView(slot);
    }
  }
  for (const name of Object.keys(views.byName)) {
    if (!slots.list.some((s) => s.name === name)) delete views.byName[name];
  }
  for (const name of Object.keys(overlays.byName)) {
    if (!slots.list.some((s) => s.name === name)) delete overlays.byName[name];
  }
}

/* ------------------------------------------------------------------ */
/* the log and the status line                                         */
/* ------------------------------------------------------------------ */

/** @type {{ entries: any[], errors: any[] }} */
export const sessionLog = $state({ entries: [] });

export const status = $state({ text: 'Ready.', kind: '' });

export function setStatus(text, kind = '') {
  status.text = text;
  status.kind = kind;
}

/* ------------------------------------------------------------------ */
/* commands                                                           */
/* ------------------------------------------------------------------ */

export const history = $state({ items: [], index: 0 });

/**
 * Run one command.
 *
 * Everything — the operation menu, the Open button — composes command TEXT and
 * comes through here, so there is one execution path and the GUI cannot
 * diverge from a script (§4).
 *
 * @returns {Promise<{ok: boolean, entry?: object, error?: string}>}
 */
export async function runCommand(source) {
  const text = String(source).trim();
  if (!text) return { ok: false };

  setStatus('Running…');
  const started = performance.now();
  try {
    const entry = await lab.run(text);
    const ms = performance.now() - started;
    if (entry) {
      sessionLog.entries = [...sessionLog.entries, { kind: 'entry', entry }];
      setStatus(`#${entry.n} in ${ms.toFixed(0)} ms`, 'ok');
    } else {
      setStatus('Nothing to do.');
    }
    history.items = [...history.items, text];
    history.index = history.items.length;
    refreshSlots();
    return { ok: true, entry };
  } catch (err) {
    sessionLog.entries = [...sessionLog.entries, { kind: 'error', source: text, message: err.message }];
    setStatus(err.message, 'error');
    return { ok: false, error: err.message };
  }
}

/** The next unused single-letter slot name, for command templates. */
export function nextSlotName() {
  const used = new Set(slots.list.map((s) => s.name));
  for (let i = 0; i < 26; i++) {
    const name = String.fromCharCode(65 + i);
    if (!used.has(name)) return name;
  }
  return 'X';
}

export function clearSession() {
  const discarded = lab.reset();
  sessionLog.entries = [];
  history.items = [];
  history.index = 0;
  resetViewport();
  for (const name of Object.keys(views.byName)) delete views.byName[name];
  refreshSlots();
  return discarded;
}

/* ------------------------------------------------------------------ */
/* app-level actions                                                   */
/* ------------------------------------------------------------------ */

/**
 * Actions that need things only App.svelte has — the pane registry, the frame
 * store, the native dialogs.
 *
 * A pane cannot reach them directly: paneless constructs pane components
 * itself and hands them a `paneId` and nothing else, so there is no prop to
 * pass a callback through. App fills this in on mount and the toolbar calls
 * it. Explicit and inspectable, which a context or a store subscription
 * would not have been for six functions.
 */
export const actions = {
  saveSession: () => {},
  resetSession: () => {},
  newSlotPane: () => {},
  /**
   * Run a pipeline over one image and lay every stage out.
   *
   * Called from the Generate frame's contact sheet, which has the file path
   * and none of what running it needs -- the frame store to clear the last
   * image's panes, and the pane registry to open this one's.
   */
  runPipelineOn: async () => {},
};

/** True while runPipelineOn is working, so the sheet can say so. */
export const pipelineRun = $state({ busy: false, image: null, step: 0, total: 0 });

/* ------------------------------------------------------------------ */
/* the multi-slot probe — §7                                           */
/* ------------------------------------------------------------------ */

/**
 * "The single most useful debugging affordance in a tool of this kind", and it
 * exists only because slots are uniform. One call returns a readout for EVERY
 * slot at a position, so it can run on every mouse move.
 */
export const probe = $state({ visible: false, x: 0, y: 0, readings: null });

export function hideProbe() {
  probe.visible = false;
}

export function showProbe(clientX, clientY, nx, ny) {
  const readings = lab.probeAll(nx, ny);
  if (Object.keys(readings).length === 0) {
    probe.visible = false;
    return;
  }
  probe.readings = readings;
  probe.x = clientX;
  probe.y = clientY;
  probe.visible = true;
}

/* ------------------------------------------------------------------ */

export const fmt = (x) =>
  Math.abs(x) >= 1000 || (x !== 0 && Math.abs(x) < 0.01)
    ? x.toExponential(2)
    : x.toFixed(3);
