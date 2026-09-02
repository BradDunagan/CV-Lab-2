/**
 * A slot's controls, as paneless controls.
 *
 * These are not DOM elements. paneless renders its controls as SVG inside a
 * pane whose `contentType` is 'controls', driven entirely by metadata in
 * `controlStore` — so there is no component here and nothing for Svelte to
 * own. This module is the wiring between that store and the lab's own state:
 * it builds the column once, mirrors `viewOf(slot)` into it, and turns a
 * dropdown selection back into a change on that view.
 *
 * Which slot the column is FOR is not stored here. It is read from the sibling
 * image pane's paneless `name`, the same field SlotPane reads, for the reason
 * given there: a pane's identity has to survive a layout restore and a drag
 * into another frame, and module state does not.
 *
 * The layout is a column of rows, each a right-aligned label and a dropdown.
 * The dropdown's width is an eval string rather than a number, so paneless
 * re-evaluates it against the panel whenever the splitter moves — see
 * `reevaluateChildrenPositioning` in its controlStore. Getting that for free is
 * most of why the controls live in a pane of their own rather than in a fixed
 * strip.
 */
import { controlStore, controlEvents, paneStore } from 'paneless';
import { viewOf, slotNamed, bufferSlots } from '../lab.svelte.js';

/* --- geometry ------------------------------------------------------- */

const PAD = 8;
const LABEL_GAP = 6;
const ROW_H = 22;
const ROW_GAP = 6;

/**
 * Dead space at the top of the column, and not decoration.
 *
 * paneless reveals a hidden frame header on hover by laying a transparent
 * overlay across the top of the frame -- 22px in its Frame.svelte, with an
 * 18px one per pane behind it. Anything drawn under that band still LOOKS
 * clickable and is not: the overlay takes the click and shows the header
 * instead. The first row of this column sat there, so choosing a different
 * slot was impossible while the pointer was in the frame, which is the only
 * time anyone would try.
 *
 * The image pane's own header is about this tall, so clearing the band also
 * lines the first control up with the top of the image.
 */
const TOP_PAD = 26;

/** paneless's DROPDOWN_ARROW_WIDTH, and the inset its text is drawn at. */
const ARROW_W = 20;
const TEXT_INSET = 6;

/**
 * Advance width of the control font at FONT_SIZE.
 *
 * The font is monospace, so one number covers every string — which is the only
 * reason these widths can be computed here rather than measured in the DOM.
 * Rounded up: too wide costs a few pixels of image, too narrow clips a colormap
 * name, and only one of those is a bug.
 */
const CHAR_W = 6.9;

const textWidth = (chars) => Math.ceil(chars * CHAR_W);

/* The app is monospace everywhere else, and these sit beside a readout that
 * is. paneless defaults to Verdana. */
const FONT = 'ui-monospace, Menlo, Consolas, monospace';
const FONT_SIZE = 11;

/* --- what the column offers ------------------------------------------ */

/**
 * One row per control, in the order they are stacked.
 *
 * `options` returns the values for the current slot, because `channel` depends
 * on it — a single-channel slot has no ch1 to offer. `parse` exists for the
 * same reason: dropdown item ids are strings and a channel is a number, so the
 * two directions have to agree on purpose rather than by coincidence.
 */
const ROWS = [
  {
    key: 'type',
    label: 'view',
    options: () => ['image', 'histogram'],
  },
  {
    key: 'colormap',
    label: 'colormap',
    options: () => ['gray', 'viridis', 'turbo', 'diverging', 'categorical', 'cyclic'],
  },
  {
    key: 'range',
    label: 'range',
    options: () => ['auto', 'percentile', 'symmetric'],
  },
  {
    key: 'curve',
    label: 'curve',
    options: () => ['linear', 'log', 'abs', 'sqrt'],
  },
  {
    key: 'channel',
    label: 'channel',
    options: (slot) => [-1, ...Array.from({ length: slot?.channels ?? 1 }, (_, i) => i)],
    labelOf: (v) => (v === -1 ? 'all' : `ch${v}`),
    parse: Number,
  },
];

const labelOf = (row, value) => (row.labelOf ? row.labelOf(value) : String(value));
const parse = (row, id) => (row.parse ? row.parse(id) : id);

/**
 * The column is as wide as its widest contents, not a fraction of the frame.
 *
 * Everything here is derived from ROWS rather than measured or guessed, so
 * adding a colormap with a longer name widens the column instead of clipping
 * it. The slot row is allowed for separately: its items are slot names, which
 * are not known until there are slots.
 */
const SLOT_ITEM_CHARS = 8; // e.g. "PGx#12" with room to spare

const LABEL_W = textWidth(Math.max(4, ...ROWS.map((r) => r.label.length))); // 'slot' is 4

const FIELD_W = Math.max(
  ...ROWS.map((r) => textWidth(Math.max(...r.options({ channels: 4 }).map((v) => labelOf(r, v).length)))),
  textWidth(SLOT_ITEM_CHARS)
) + TEXT_INSET * 2 + ARROW_W;

/** What a slot frame should give the column before the user touches it. */
export const CONTROLS_WIDTH = PAD + LABEL_W + LABEL_GAP + FIELD_W + PAD;

/** Dropdowns stretch to the pane; the label column and both margins do not. */
const FIELD_W_EVAL = `100% -${PAD + LABEL_W + LABEL_GAP + PAD}`;
const FIELD_X = PAD + LABEL_W + LABEL_GAP;

/* --- building -------------------------------------------------------- */

function ensureRootPanel(paneId) {
  const existing = controlStore.getPaneData(paneId)?.rootPanelId;
  if (existing) return existing;
  // Size is provisional: Controls.svelte resizes the root panel to the pane on
  // its first ResizeObserver callback, and every eval width re-evaluates then.
  // Creating it here rather than letting Controls create it is what lets the
  // column be built synchronously, before the pane has ever been measured.
  const id = controlStore.createRootPanel(paneId, 240, 320);
  controlStore.updateControl(paneId, id, { borderStyle: 'none', backgroundColor: '#ffffff' });
  return id;
}

function addLabel(paneId, root, text, x, y, width, align) {
  return controlStore.addControl(paneId, root, 'label', x, y, width, ROW_H, {
    text,
    textAlign: align,
    fontFamily: FONT,
    fontSize: FONT_SIZE,
    borderStyle: 'none',
    borderVisible: false,
  });
}

/**
 * Build the column. Returns the control ids, keyed by row.
 *
 * Called once per controls pane. Everything after this is an update: rebuilding
 * on every slot change would destroy the open dropdown the user is looking at.
 */
function build(paneId) {
  const root = ensureRootPanel(paneId);
  const ids = { rows: {} };

  let y = TOP_PAD;

  ids.slotLabel = addLabel(paneId, root, 'slot', PAD, y, LABEL_W, 'right');
  ids.slot = controlStore.addControl(paneId, root, 'dropdown', FIELD_X, y, FIELD_W, ROW_H, {
    name: 'slot',
    items: [],
    fontFamily: FONT,
    fontSize: FONT_SIZE,
  });
  controlStore.updateControl(paneId, ids.slot, { width: FIELD_W_EVAL });
  y += ROW_H + ROW_GAP;

  // The slot's shape, dtype and colour space. A readout rather than a control,
  // but it belongs with the identity above it, not over the image.
  ids.meta = addLabel(paneId, root, '', PAD, y, 200, 'left');
  controlStore.updateControl(paneId, ids.meta, {
    width: `100% -${PAD * 2}`,
    fontSize: 10,
  });
  y += ROW_H + ROW_GAP;

  for (const row of ROWS) {
    ids.rows[row.key] = {
      label: addLabel(paneId, root, row.label, PAD, y, LABEL_W, 'right'),
      field: controlStore.addControl(paneId, root, 'dropdown', FIELD_X, y, FIELD_W, ROW_H, {
        name: row.key,
        items: [],
        fontFamily: FONT,
        fontSize: FONT_SIZE,
      }),
    };
    controlStore.updateControl(paneId, ids.rows[row.key].field, { width: FIELD_W_EVAL });
    y += ROW_H + ROW_GAP;
  }

  return ids;
}

/* --- syncing --------------------------------------------------------- */

/**
 * Push `items` and `selectedId` into a dropdown, but only where they differ.
 *
 * Every write re-renders the control, which closes an open list — so a sync
 * that ran unconditionally would make the dropdowns unusable the moment
 * anything else in the app changed.
 */
function syncDropdown(paneId, controlId, items, selectedId, enabled = true) {
  const current = controlStore.getControl(paneId, controlId);
  if (!current) return;
  const same =
    current.items?.length === items.length &&
    current.items.every((it, i) => it.id === items[i].id && it.label === items[i].label);
  const updates = {};
  if (!same) updates.items = items;
  if (current.selectedId !== selectedId) updates.selectedId = selectedId;
  if (current.enabled !== enabled) updates.enabled = enabled;
  if (Object.keys(updates).length > 0) controlStore.updateControl(paneId, controlId, updates);
}

function syncLabel(paneId, controlId, text) {
  const current = controlStore.getControl(paneId, controlId);
  if (current && current.text !== text) controlStore.updateControl(paneId, controlId, { text });
}

/* --- attaching ------------------------------------------------------- */

/**
 * Wire a controls pane to the slot shown by its sibling image pane.
 *
 * Returns a dispose function; the caller owns it, because a frame can be closed
 * and the store is global.
 */
export function attachSlotControls(controlsPaneId, imagePaneId) {
  const ids = build(controlsPaneId);

  /** The bound slot name, mirrored out of paneless's store into a rune. */
  const bound = $state({ name: null });
  const unsubscribePanes = paneStore.subscribe((data) => {
    bound.name = data.byId[imagePaneId]?.name ?? null;
  });

  const stopEffects = $effect.root(() => {
    $effect(() => {
      const name = bound.name;
      const slot = name ? slotNamed(name) : null;
      const view = name ? viewOf(name) : null;
      const available = bufferSlots();

      syncDropdown(
        controlsPaneId,
        ids.slot,
        available.map((s) => ({ id: s.name, label: `${s.name}#${s.version}` })),
        available.some((s) => s.name === name) ? name : undefined
      );

      syncLabel(
        controlsPaneId,
        ids.meta,
        slot ? `${slot.width}×${slot.height}×${slot.channels} ${slot.dtype} ${slot.space}` : ''
      );

      for (const row of ROWS) {
        const values = row.options(slot);
        // Disabled rather than hidden when nothing is bound: the column keeps
        // its shape, so binding a slot does not make the pane jump.
        syncDropdown(
          controlsPaneId,
          ids.rows[row.key].field,
          values.map((v) => ({ id: String(v), label: labelOf(row, v) })),
          view ? String(view[row.key]) : undefined,
          !!view
        );
      }
    });
  });

  const unsubscribeEvents = controlEvents.on('controlValueChanged', (event) => {
    if (event.paneId !== controlsPaneId) return;
    const name = bound.name;

    if (event.controlId === ids.slot) {
      const picked = event.value?.newId;
      if (picked) {
        paneStore.setName(imagePaneId, picked);
        paneStore.updatePane(imagePaneId, { title: `Slot ${picked}`, titleVisible: true });
      }
      return;
    }

    const row = ROWS.find((r) => ids.rows[r.key].field === event.controlId);
    if (!row || !name) return;
    const view = viewOf(name);
    if (!view) return;
    view[row.key] = parse(row, event.value?.newId);
  });

  return () => {
    unsubscribePanes();
    unsubscribeEvents();
    stopEffects();
    controlStore.clear(controlsPaneId);
  };
}

/** The rows the column offers, for tests and for the pane menu. */
export const slotControlRows = ROWS.map((r) => r.key);
