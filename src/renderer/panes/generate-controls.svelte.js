/**
 * The Generate frame's controls, as paneless controls.
 *
 * Same shape as slot-controls.svelte.js and for the same reasons: the controls
 * live in a pane of their own beside the thing they act on, they are
 * controlStore metadata rather than DOM, and this module is the wiring between
 * that store and the app's state.
 *
 * What differs is that a slot column mirrors state the lab already owns, while
 * this one OWNS the options until Generate is pressed. So the store is the
 * source of truth for a field's text and this reads it back on start, rather
 * than pushing a separate copy in on every keystroke.
 *
 * Every control here is still one field in the options object and one key the
 * driver already understands, which is what made growing the old pane cheap.
 * That has not changed -- only what draws them.
 */
import { controlStore, controlEvents } from 'paneless';

/* --- geometry ------------------------------------------------------- */

const PAD = 8;
const LABEL_GAP = 6;
const ROW_H = 22;
const ROW_GAP = 6;
const ARROW_W = 20;
const TEXT_INSET = 6;
const CHAR_W = 6.9;
const FONT = 'ui-monospace, Menlo, Consolas, monospace';
const FONT_SIZE = 11;

/** See slot-controls.svelte.js: paneless reveals hidden headers over this band. */
const TOP_PAD = 26;

const textWidth = (chars) => Math.ceil(chars * CHAR_W);

/* --- what the column offers ------------------------------------------ */

const SCENES = ['helmet', 'cube'];
const ROOMS = ['default', 'room', 'room-emissive', 'room-arealight', 'none'];

/**
 * One row per option, in the order they are stacked.
 *
 * `kind` picks the control; `parse` turns what the control reports back into
 * the type the driver expects, because an editbox reports a string and
 * `samples` is a number. The bounds are carried here rather than in the
 * control because paneless's editbox does not enforce a range -- so they are
 * applied on the way out, where they actually have to hold.
 */
const ROWS = [
  { key: 'out', label: 'out', kind: 'editbox' },
  { key: 'size', label: 'size', kind: 'editbox', parse: Number, min: 64, max: 2048 },
  { key: 'samples', label: 'samples', kind: 'editbox', parse: Number, min: 4, max: 1000 },
  { key: 'positions', label: 'positions', kind: 'editbox', parse: Number, min: 1, max: 24 },
  { key: 'lighting', label: 'lighting', kind: 'editbox', parse: Number, min: 1, max: 8 },
  { key: 'scene', label: 'scene', kind: 'dropdown', options: SCENES },
  { key: 'room', label: 'room', kind: 'dropdown', options: ROOMS },
  { key: 'truth', label: '', kind: 'checkbox', text: 'ground truth' },
  { key: 'aovs', label: '', kind: 'checkbox', text: 'AOV passes' },
  { key: 'denoise', label: '', kind: 'checkbox', text: 'denoise' },
];

const LABEL_W = textWidth(Math.max(...ROWS.map((r) => r.label.length)));

const FIELD_W = Math.max(
  ...ROWS.filter((r) => r.kind === 'dropdown')
    .map((r) => textWidth(Math.max(...r.options.map((o) => o.length)))),
  textWidth(22) // an output path is the widest thing typed here
) + TEXT_INSET * 2 + ARROW_W;

/** What the Generate frame should give the column before the user drags it. */
export const CONTROLS_WIDTH = PAD + LABEL_W + LABEL_GAP + FIELD_W + PAD;

const FIELD_X = PAD + LABEL_W + LABEL_GAP;
const FIELD_W_EVAL = `100% -${PAD + LABEL_W + LABEL_GAP + PAD}`;
const FULL_W_EVAL = `100% -${PAD * 2}`;

/**
 * How many characters of hint fit across a column of this width.
 *
 * The label's own text inset comes off as well as the margins. Erring narrow
 * on purpose: a short line looks fine and a long one is silently cut off at
 * the pane edge, with no scrollbar and nothing to say it happened.
 */
const hintColumns = (paneWidth) =>
  Math.max(16, Math.floor((paneWidth - PAD * 2 - TEXT_INSET * 2) / CHAR_W));

/**
 * Wrap to a width, on spaces.
 *
 * paneless's label renders one tspan per '\n' and does not wrap, so the wrap
 * has to happen here. Monospace is what makes a character count a width.
 */
export function wrap(text, columns) {
  const out = [];
  for (const paragraph of text.split('\n')) {
    let line = '';
    for (const word of paragraph.split(/\s+/).filter(Boolean)) {
      if (line && line.length + 1 + word.length > columns) {
        out.push(line);
        line = word;
      } else {
        line = line ? `${line} ${word}` : word;
      }
    }
    out.push(line);
  }
  return out.join('\n');
}

/* --- building -------------------------------------------------------- */

function ensureRootPanel(paneId) {
  const existing = controlStore.getPaneData(paneId)?.rootPanelId;
  if (existing) return existing;
  const id = controlStore.createRootPanel(paneId, CONTROLS_WIDTH, 480);
  controlStore.updateControl(paneId, id, { borderStyle: 'none', backgroundColor: '#ffffff' });
  return id;
}

function build(paneId, options) {
  const root = ensureRootPanel(paneId);
  const ids = { rows: {} };
  let y = TOP_PAD;

  for (const row of ROWS) {
    if (row.label) {
      ids.rows[`${row.key}:label`] = controlStore.addControl(
        paneId, root, 'label', PAD, y, LABEL_W, ROW_H,
        { text: row.label, textAlign: 'right', fontFamily: FONT, fontSize: FONT_SIZE,
          borderStyle: 'none', borderVisible: false }
      );
    }

    const common = { name: row.key, fontFamily: FONT, fontSize: FONT_SIZE };
    let id;
    if (row.kind === 'dropdown') {
      id = controlStore.addControl(paneId, root, 'dropdown', FIELD_X, y, FIELD_W, ROW_H, {
        ...common,
        items: row.options.map((o) => ({ id: o, label: o })),
        selectedId: options[row.key],
      });
      controlStore.updateControl(paneId, id, { width: FIELD_W_EVAL });
    } else if (row.kind === 'checkbox') {
      // Full width and no label of its own: a checkbox carries its text.
      id = controlStore.addControl(paneId, root, 'checkbox', PAD, y, FIELD_W, ROW_H, {
        ...common, text: row.text, checked: !!options[row.key],
      });
      controlStore.updateControl(paneId, id, { width: FULL_W_EVAL });
    } else {
      id = controlStore.addControl(paneId, root, 'editbox', FIELD_X, y, FIELD_W, ROW_H, {
        ...common, value: String(options[row.key] ?? ''),
      });
      controlStore.updateControl(paneId, id, { width: FIELD_W_EVAL });
    }
    ids.rows[row.key] = id;
    y += ROW_H + ROW_GAP;
  }

  y += ROW_GAP;
  ids.run = controlStore.addControl(paneId, root, 'button', PAD, y, FIELD_W, ROW_H + 2, {
    name: 'run', text: 'Generate', fontFamily: FONT, fontSize: FONT_SIZE,
  });
  controlStore.updateControl(paneId, ids.run, { width: FULL_W_EVAL });
  y += ROW_H + 2 + ROW_GAP * 2;

  // The hint, below the controls. It is the only thing here that grows and
  // shrinks, so it takes the rest of the column.
  ids.hint = controlStore.addControl(paneId, root, 'label', PAD, y, FIELD_W, 120, {
    name: 'hint', text: '', textAlign: 'left', fontFamily: FONT, fontSize: FONT_SIZE,
    borderStyle: 'none', borderVisible: false, enableVertScroll: true,
  });
  /*
   * Two calls, not one. paneless parses a string width and a string height in
   * separate branches of the same update, and passing both keeps only the
   * height -- the hint kept its numeric fallback width, 184 against a 250-wide
   * column, while the text was wrapped to the width it was supposed to have.
   * The overhang is then simply cut off at the pane edge, with no scrollbar
   * and nothing to say a word went missing.
   */
  controlStore.updateControl(paneId, ids.hint, { width: FULL_W_EVAL });
  controlStore.updateControl(paneId, ids.hint, { height: `100% -${y + PAD}` });

  return ids;
}

/* --- syncing --------------------------------------------------------- */

function set(paneId, controlId, updates) {
  const current = controlStore.getControl(paneId, controlId);
  if (!current) return;
  const changed = Object.entries(updates).filter(([k, v]) => current[k] !== v);
  if (changed.length > 0) controlStore.updateControl(paneId, controlId, Object.fromEntries(changed));
}

/* --- attaching ------------------------------------------------------- */

/**
 * Wire a controls pane to the generator.
 *
 * `handlers.onRun` is called with the finished options object; `hint()` returns
 * the text under the controls. Both are supplied by GeneratePane, which owns
 * the run state -- this module owns only what is drawn.
 */
export function attachGenerateControls(paneId, options, handlers) {
  const ids = build(paneId, options);

  const read = () => {
    const out = { ...options };
    for (const row of ROWS) {
      const control = controlStore.getControl(paneId, ids.rows[row.key]);
      if (!control) continue;
      if (row.kind === 'checkbox') out[row.key] = !!control.checked;
      else if (row.kind === 'dropdown') out[row.key] = control.selectedId;
      else {
        const value = row.parse ? row.parse(control.value) : control.value;
        out[row.key] = Number.isFinite(value)
          ? Math.min(row.max ?? Infinity, Math.max(row.min ?? -Infinity, value))
          : value;
      }
    }
    return out;
  };

  /*
   * Re-wrap when the column is resized.
   *
   * The wrap is computed from a width, so it goes stale the moment the
   * splitter moves -- and the first staleness is at startup, because the
   * column is built before paneless has measured the pane. A hint wrapped to
   * the provisional width overhangs the real one and is simply cut off, with
   * no scrollbar and nothing to say so.
   */
  let rawHint = '';
  let wrappedAt = 0;

  const rootWidth = () => {
    const root = controlStore.getPaneData(paneId)?.rootPanelId;
    return root ? controlStore.getControl(paneId, root)?.width ?? 0 : 0;
  };

  const rewrap = () => {
    const width = rootWidth();
    if (!width) return;
    set(paneId, ids.hint, { text: wrap(rawHint, hintColumns(width)) });
    wrappedAt = width;
  };

  const unsubscribeStore = controlStore.subscribe(() => {
    if (rootWidth() !== wrappedAt) rewrap();
  });

  const unsubscribe = controlEvents.on('*', (event) => {
    if (event.paneId !== paneId) return;

    if (event.type === 'controlClicked' && event.controlId === ids.run) {
      handlers.onRun(read());
      return;
    }
    // A checkbox reports the new state but does not store it, so this is the
    // only place it becomes true. Everything else paneless has already written.
    if (event.type === 'controlValueChanged') {
      const row = ROWS.find((r) => ids.rows[r.key] === event.controlId);
      if (row?.kind === 'checkbox') {
        controlStore.updateControl(paneId, event.controlId, { checked: !!event.value });
      }
      handlers.onChange?.(read());
    }
  });

  return {
    read,
    /**
     * Put a value into one field.
     *
     * Only used for `out`, which the main process nominates and which arrives
     * after the column has already been built from the defaults. Everything
     * else the column owns outright once it exists.
     */
    setField(key, value) {
      const id = ids.rows[key];
      const row = ROWS.find((r) => r.key === key);
      if (!id || !row) return;
      if (row.kind === 'checkbox') set(paneId, id, { checked: !!value });
      else if (row.kind === 'dropdown') set(paneId, id, { selectedId: value });
      else set(paneId, id, { value: String(value ?? '') });
    },
    /** Reflect run state: the fields lock while a sweep is in flight. */
    update({ running, hint, runLabel }) {
      for (const row of ROWS) set(paneId, ids.rows[row.key], { enabled: !running });
      set(paneId, ids.run, { enabled: !running, text: runLabel });
      rawHint = hint;
      rewrap();
    },
    dispose() {
      unsubscribe();
      unsubscribeStore();
      controlStore.clear(paneId);
    },
  };
}
