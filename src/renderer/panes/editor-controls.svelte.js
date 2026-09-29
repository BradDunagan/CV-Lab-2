/**
 * The Scene Editor's controls, as a paneless column beside the render.
 *
 * The same arrangement as the Generate frame: controls on the left, the view
 * on the right, and this module the wiring between paneless's control store
 * and the thing the controls act on. What differs is where that thing is.
 * Generate's options live here until Generate is pressed; the scene lives in
 * pt-lab, in the editor's own page, in another process. So this column owns
 * nothing:
 *
 *   - every change is a command, sent to the page's `window.__editor` through
 *     the main process (`lab.editor.call`);
 *   - everything drawn comes from the page's snapshot (`update`), including
 *     which object or light is selected.
 *
 * A command's effect therefore appears when the page says so, not when the
 * control changed. That is what keeps the column from drifting from the
 * scene: there is one copy of each value, and it is pt-lab's.
 *
 * Three tabs, because paneless clips a column rather than scrolling it, and
 * the editor has more to show than fits one: the scene itself, its objects,
 * its lights.
 */
import { controlStore, controlEvents } from 'paneless';
import { wrap } from './generate-controls.svelte.js';

/* --- geometry ------------------------------------------------------- */

const PAD = 8;
const GAP = 6;
const ROW_H = 22;
const ROW = ROW_H + GAP;
const CHAR_W = 6.9;
const TEXT_INSET = 6;
const FONT = 'ui-monospace, Menlo, Consolas, monospace';
const FONT_SIZE = 11;
const TAB_H = 20;

/** See slot-controls.svelte.js: paneless reveals hidden headers over this band. */
const TOP_PAD = 26;

const textWidth = (chars) => Math.ceil(chars * CHAR_W);
const LABEL_W = textWidth('position'.length);

/** What the frame gives the column before anyone drags the splitter. */
export const CONTROLS_WIDTH = 290;

/**
 * The width a tab panel has to lay out in. Fields stretch with the column
 * through width expressions; the x/y/z triples are the exception, laid out at
 * this width, because paneless positions by expression too and three
 * expressions per row is more machinery than a slightly narrow row is worth.
 */
const PANEL_W = CONTROLS_WIDTH - PAD * 2 - 2;
const FIELD_X = PAD + LABEL_W + GAP;
const FIELD_W = PANEL_W - FIELD_X - PAD;
const STRETCH = `100% -${FIELD_X + PAD}`;
const FULL = `100% -${PAD * 2}`;
const HALF_W = Math.floor((PANEL_W - PAD * 2 - GAP) / 2);
const XYZ_W = Math.floor((FIELD_W - GAP * 2) / 3);

const LIST_H = 116;
const HEX = /^#[0-9a-f]{6}$/i;

/** How long a control the user just touched is left alone by snapshots. */
const HANDS_OFF_MS = 1000;

/** The events a person causes, as opposed to the ones a write here causes. */
const USER_EVENTS = new Set([
  'controlClicked', 'controlValueChanged', 'controlInputChanged', 'listItemSelected',
]);

/* --- building -------------------------------------------------------- */

function ensureRootPanel(paneId) {
  const existing = controlStore.getPaneData(paneId)?.rootPanelId;
  if (existing) return existing;
  const id = controlStore.createRootPanel(paneId, CONTROLS_WIDTH, 600);
  controlStore.updateControl(paneId, id, { borderStyle: 'none', backgroundColor: '#ffffff' });
  return id;
}

/**
 * Lay out one tab's controls top to bottom.
 *
 * `ids` maps a key -- the name this module uses for a control -- to paneless's
 * id, and `keys` the other way, so an event can be read as "the colour field
 * changed" rather than as an opaque id.
 */
function column(paneId, panelId, ids, keys) {
  let y = PAD;
  const common = { fontFamily: FONT, fontSize: FONT_SIZE };
  const add = (key, type, x, w, h, props, widthEval) => {
    const id = controlStore.addControl(paneId, panelId, type, x, y, w, h, { name: key, ...common, ...props });
    if (widthEval) controlStore.updateControl(paneId, id, { width: widthEval });
    ids[key] = id;
    keys[id] = key;
    return id;
  };
  const label = (key, text, x = PAD) => add(key, 'label', x, LABEL_W, ROW_H, {
    text, textAlign: 'right', borderStyle: 'none', borderVisible: false,
  });

  return {
    /** A labelled field: editbox, dropdown or slider. */
    field(key, text, type, props = {}) {
      label(`${key}:label`, text);
      add(key, type, FIELD_X, FIELD_W, ROW_H, props, STRETCH);
      y += ROW;
    },
    /** A labelled row of three numbers: `${key}.0`, `.1`, `.2`. */
    xyz(key, text) {
      label(`${key}:label`, text);
      for (let i = 0; i < 3; i++) {
        add(`${key}.${i}`, 'editbox', FIELD_X + i * (XYZ_W + GAP), XYZ_W, ROW_H, { value: '' });
      }
      y += ROW;
    },
    checkbox(key, text) {
      add(key, 'checkbox', PAD, FIELD_W, ROW_H, { text, checked: false }, FULL);
      y += ROW;
    },
    button(key, text) {
      add(key, 'button', PAD, FIELD_W, ROW_H, { text }, FULL);
      y += ROW;
    },
    /** Two buttons side by side, half the width each. */
    buttons(left, right) {
      add(left[0], 'button', PAD, HALF_W, ROW_H, { text: left[1] });
      add(right[0], 'button', PAD + HALF_W + GAP, HALF_W, ROW_H, { text: right[1] });
      y += ROW;
    },
    list(key, height) {
      add(key, 'list', PAD, FIELD_W, height, { items: [], selectedIds: [] }, FULL);
      y += height + GAP;
    },
    /** A heading or a note: full width, left-aligned, no border. */
    text(key, height = ROW_H) {
      add(key, 'label', PAD, FIELD_W, height, {
        text: '', textAlign: 'left', borderStyle: 'none', borderVisible: false,
      }, FULL);
      y += height + GAP;
    },
    /** Whatever height is left, for a note that wraps. */
    rest(key) {
      const id = add(key, 'label', PAD, FIELD_W, 120, {
        text: '', textAlign: 'left', borderStyle: 'none', borderVisible: false, enableVertScroll: true,
      }, FULL);
      // Two calls: see generate-controls.svelte.js on paneless keeping only
      // one of a width and a height expression passed together.
      controlStore.updateControl(paneId, id, { height: `100% -${y + PAD}` });
    },
    /** Rows after this point start where this one did -- for alternatives. */
    mark: () => y,
    reset: (to) => { y = to; },
    skip: (dy) => { y += dy; },
  };
}

/** The three tabs and everything in them. */
function build(paneId) {
  const root = ensureRootPanel(paneId);
  const ids = {};
  const keys = {};

  const tabsId = controlStore.addControl(paneId, root, 'tabs', PAD, TOP_PAD, PANEL_W + 2, 600, {
    name: 'tabs', fontFamily: FONT, fontSize: FONT_SIZE, tabHeight: TAB_H,
  });
  controlStore.updateControl(paneId, tabsId, { width: `100% -${PAD * 2}` });
  controlStore.updateControl(paneId, tabsId, { height: `100% -${TOP_PAD + PAD}` });
  ids.tabs = tabsId;

  // Panels are children of the tabs control, which paneless does not record
  // on its own -- hence the explicit childIds below, as paneless's own
  // "add tabs" does.
  const panel = (name) => controlStore.addControl(paneId, tabsId, 'panel', 0, 0, PANEL_W, 560, {
    name, backgroundColor: 'white',
  });
  const scenePanel = panel('tab:scene');
  const objectsPanel = panel('tab:objects');
  const lightsPanel = panel('tab:lights');
  controlStore.updateControl(paneId, tabsId, {
    tabs: [
      { id: 'scene', label: 'Scene', panelId: scenePanel },
      { id: 'objects', label: 'Objects', panelId: objectsPanel },
      { id: 'lights', label: 'Lights', panelId: lightsPanel },
    ],
    childIds: [scenePanel, objectsPanel, lightsPanel],
    activeTabId: 'scene',
  });

  /* Scene: which scene, saving it, how it is viewed. */
  const s = column(paneId, scenePanel, ids, keys);
  s.field('scene', 'scene', 'dropdown', { items: [] });
  s.buttons(['new', 'New'], ['save', 'Save']);
  s.field('saveName', 'name', 'editbox', { value: '', placeholder: 'new name' });
  s.checkbox('local', 'private: .local.json, not committed');
  s.button('saveAs', 'Save As');
  s.skip(GAP);
  s.checkbox('preview', 'path-traced preview');
  s.checkbox('denoise', 'denoise the preview');
  s.field('room', 'room', 'dropdown', {
    items: [
      { id: 'room', label: 'baked HDR env' },
      { id: 'room-emissive', label: 'emissive mesh' },
      { id: 'room-arealight', label: 'rect area light' },
    ],
  });
  s.xyz('camPos', 'camera');
  s.xyz('camTarget', 'target');
  s.skip(GAP);
  s.rest('status');

  /* Objects: the library, and the selected one's look and placement. */
  const o = column(paneId, objectsPanel, ids, keys);
  o.list('objects', LIST_H);
  o.button('import', 'Import .glb…');
  o.field('bundled', 'bundled', 'dropdown', { items: [], text: 'add one…' });
  o.skip(GAP);
  const inspector = o.mark();
  o.text('objNone', 44);
  o.reset(inspector);
  o.text('objTitle');
  o.buttons(['included', 'Include'], ['removeObject', 'Remove']);
  o.field('color', 'colour', 'editbox', { value: '', placeholder: '#rrggbb' });
  o.field('shininess', 'shiny', 'slider', { value: 0, min: 0, max: 1, step: 0.01, showValue: true, valuePrecision: 2 });
  o.field('reflectivity', 'metal', 'slider', { value: 0, min: 0, max: 1, step: 0.01, showValue: true, valuePrecision: 2 });
  o.xyz('position', 'position');
  o.xyz('rotation', 'rotate °');
  o.xyz('scale', 'scale');

  /* Lights: the scene's own, and the selected one. */
  const l = column(paneId, lightsPanel, ids, keys);
  l.list('lights', LIST_H);
  l.buttons(['addLight', 'Add light'], ['removeLight', 'Remove']);
  l.skip(GAP);
  const lightInspector = l.mark();
  l.text('lightNone', 44);
  l.reset(lightInspector);
  l.text('lightTitle');
  l.field('lightName', 'name', 'editbox', { value: '' });
  l.field('lightType', 'type', 'dropdown', { items: [] });
  l.field('lightColor', 'colour', 'editbox', { value: '', placeholder: '#rrggbb' });
  l.field('intensity', 'power', 'slider', { value: 0, min: 0, max: 200, step: 1, showValue: true, valuePrecision: 0 });
  l.xyz('lightPos', 'position');

  return { ids, keys };
}

/* --- the controls that belong together -------------------------------- */

const OBJECT_FIELDS = ['objTitle', 'included', 'removeObject', 'color', 'shininess', 'reflectivity',
  'position', 'rotation', 'scale'];
const LIGHT_FIELDS = ['lightTitle', 'lightName', 'lightType', 'lightColor', 'intensity', 'lightPos'];

/** Every control a key names: the field, its label, and an x/y/z row's three boxes. */
function controlsFor(ids, key) {
  return Object.keys(ids).filter((k) => k === key || k === `${key}:label` || k.startsWith(`${key}.`));
}

/* --- attaching ------------------------------------------------------- */

/**
 * Wire a controls pane to the Scene Editor.
 *
 * `editor` is the bridge's `lab.editor`; `onError` reports a command the page
 * refused. Returns `update(snapshot)`, which the frame calls with every state
 * the page publishes, and `dispose()`.
 */
export function attachEditorControls(paneId, editor, { onError = () => {} } = {}) {
  const { ids, keys } = build(paneId);
  let state = null;

  /* Writes that respect a control the user is in the middle of using. */
  const touched = new Map();
  const set = (key, updates, { force = false } = {}) => {
    const id = ids[key];
    const current = id && controlStore.getControl(paneId, id);
    if (!current) return;
    if (!force && Date.now() - (touched.get(key) ?? 0) < HANDS_OFF_MS) return;
    const changed = Object.entries(updates).filter(([k, v]) =>
      JSON.stringify(current[k]) !== JSON.stringify(v));
    if (changed.length > 0) controlStore.updateControl(paneId, id, Object.fromEntries(changed));
  };
  const show = (key, visible) => {
    for (const k of controlsFor(ids, key)) set(k, { visible }, { force: true });
  };
  const value = (key) => controlStore.getControl(paneId, ids[key]);

  /*
   * One command in flight per key. A slider emits on every pixel of a drag,
   * and each emission would otherwise be a round trip through two processes;
   * the latest value waits for the one in flight and replaces anything older.
   */
  const inFlight = new Map();
  const waiting = new Map();
  const send = (key, method, ...args) => {
    if (inFlight.get(key)) { waiting.set(key, [method, args]); return; }
    inFlight.set(key, true);
    editor.call(method, ...args)
      .catch((err) => onError(err.message))
      .finally(() => {
        inFlight.set(key, false);
        const next = waiting.get(key);
        if (next) { waiting.delete(key); send(key, next[0], ...next[1]); }
      });
  };

  const triple = (key) => [0, 1, 2].map((i) => Number(value(`${key}.${i}`)?.value));
  const selectedId = (kind) => (state?.selected?.kind === kind ? state.selected.id : null);

  /* --- what each control does ------------------------------------------ */

  const onClick = (key) => {
    switch (key) {
      case 'new': send(key, 'newScene'); break;
      case 'save': send(key, 'save'); break;
      case 'saveAs': {
        const name = String(value('saveName')?.value ?? '').trim();
        if (!name) { onError('Give the scene a name to save it under.'); break; }
        send(key, 'save', { name, local: !!value('local')?.checked });
        break;
      }
      case 'import':
        editor.importModel().catch((err) => onError(err.message));
        break;
      case 'included': {
        const id = selectedId('object');
        const obj = state?.objects.find((x) => x.id === id);
        if (obj) send(key, 'setIncluded', id, !obj.included);
        break;
      }
      case 'removeObject': {
        const id = selectedId('object');
        if (id) send(key, 'removeObject', id);
        break;
      }
      case 'addLight': send(key, 'addLight'); break;
      case 'removeLight': {
        const id = selectedId('light');
        if (id) send(key, 'removeLight', id);
        break;
      }
      default: break;
    }
  };

  const onValue = (key, v) => {
    const base = key.split('.')[0];
    const objId = selectedId('object');
    const lightId = selectedId('light');
    switch (base) {
      case 'scene': if (v?.newId) send(key, 'open', v.newId); break;
      case 'room': if (v?.newId) send(key, 'setRoom', v.newId); break;
      case 'preview': send(key, 'setPreview', !!v); break;
      case 'denoise': send(key, 'setDenoise', !!v); break;
      case 'bundled':
        if (v?.newId) send(key, 'importBundled', v.newId);
        // A menu of actions, not a setting: back to its prompt once used.
        set('bundled', { selectedId: undefined }, { force: true });
        break;
      case 'camPos': case 'camTarget': {
        const xyz = triple(base);
        if (xyz.every(Number.isFinite)) {
          send(base, 'setCamera', base === 'camPos' ? { position: xyz } : { target: xyz });
        }
        break;
      }
      case 'color':
        if (!objId) break;
        if (HEX.test(String(v?.newValue))) send(key, 'setMaterial', objId, { color: v.newValue.toLowerCase() });
        else onError(`"${v?.newValue}" is not a colour -- write it as #rrggbb.`);
        break;
      case 'shininess': case 'reflectivity':
        if (objId) send(key, 'setMaterial', objId, { [key]: v.newValue });
        break;
      case 'position': case 'rotation': case 'scale': {
        const xyz = triple(base);
        if (objId && xyz.every(Number.isFinite)) send(base, 'setTransform', objId, { [base]: xyz });
        break;
      }
      case 'lightName':
        if (lightId && String(v?.newValue).trim()) send(key, 'setLight', lightId, { name: v.newValue.trim() });
        break;
      case 'lightType':
        if (lightId && v?.newId) send(key, 'setLight', lightId, { type: v.newId });
        break;
      case 'lightColor':
        if (!lightId) break;
        if (HEX.test(String(v?.newValue))) send(key, 'setLight', lightId, { color: v.newValue.toLowerCase() });
        else onError(`"${v?.newValue}" is not a colour -- write it as #rrggbb.`);
        break;
      case 'intensity':
        if (lightId) send(key, 'setLight', lightId, { intensity: v.newValue });
        break;
      case 'lightPos': {
        const xyz = triple(base);
        if (lightId && xyz.every(Number.isFinite)) send(base, 'setLight', lightId, { position: xyz });
        break;
      }
      default: break;
    }
  };

  const unsubscribe = controlEvents.on('*', (event) => {
    if (event.paneId !== paneId) return;
    const key = keys[event.controlId];
    if (!key) return;
    // Only what a PERSON does counts as touching a control. paneless also
    // emits controlUpdated for this module's own writes, and counting those
    // made showing the light inspector hold off the very values it was about
    // to show -- the first light added came up with a blank name and zero
    // power, and nothing redrew it.
    if (!USER_EVENTS.has(event.type)) return;
    touched.set(key, Date.now());
    if (event.type === 'controlClicked') onClick(key);
    else if (event.type === 'listItemSelected') {
      send(key, 'select', key === 'objects' ? 'object' : 'light', event.value?.itemId);
    } else if (event.type === 'controlValueChanged') {
      // A checkbox reports its new state without storing it; see
      // generate-controls.svelte.js.
      if (controlStore.getControl(paneId, event.controlId)?.type === 'checkbox') {
        controlStore.updateControl(paneId, event.controlId, { checked: !!event.value });
      }
      onValue(key, event.value);
    }
  });

  /* --- drawing a snapshot ----------------------------------------------- */

  const fixed = (n) => (Number.isFinite(n) ? n.toFixed(2) : '');
  const fill = (key, xyz) => { for (let i = 0; i < 3; i++) set(`${key}.${i}`, { value: fixed(xyz?.[i]) }); };
  const columnsFor = (key) => {
    const w = controlStore.getControl(paneId, ids[key])?.width ?? FIELD_W;
    return Math.max(16, Math.floor((w - TEXT_INSET * 2) / CHAR_W));
  };
  let lastScene;

  /*
   * Hold snapshots while someone is mid-edit.
   *
   * paneless redraws a panel when any control in it changes, and a redraw
   * takes an open edit with it -- the text input an editbox opens on click
   * was gone within half a second, because snapshots arrive several times a
   * second (every sample, while the preview path-traces). Generate's column
   * never met this: nothing updates it while someone types. So a snapshot
   * that arrives while an edit is open, or while a mouse button is down on a
   * slider, waits; the latest one is drawn when the interaction ends, and
   * nothing in between is lost because each snapshot is complete.
   */
  let pointerDown = false;
  const onDown = () => { pointerDown = true; };
  const onUp = () => { pointerDown = false; };
  window.addEventListener('pointerdown', onDown, true);
  window.addEventListener('pointerup', onUp, true);
  const busy = () => pointerDown || !!document.querySelector('foreignObject input');
  let held = null;
  let retry = null;

  function update(next) {
    if (busy()) {
      held = next;
      retry ??= setTimeout(() => { retry = null; if (held) update(held); }, 150);
      return;
    }
    held = null;
    // A draw that throws halfway leaves the column showing half a state, with
    // nothing to say so -- which is how the first light's inspector came up
    // empty. Said out loud instead.
    try {
      draw(next);
    } catch (err) {
      console.error('[editor-controls] draw failed:', err);
      onError(`The Scene Editor's controls could not draw: ${err.message}`);
    }
  }

  function draw(next) {
    state = next;
    const ready = !!next?.ready;
    for (const key of Object.keys(ids)) {
      if (key === 'tabs' || key.includes(':') || key === 'status') continue;
      set(key, { enabled: ready && !next.saving }, { force: true });
    }
    if (!next) return;

    /* Scene */
    const items = (next.scenes ?? []).map((name) => ({ id: name, label: name }));
    if (!next.current) items.unshift({ id: '', label: 'new scene (unsaved)' });
    set('scene', { items, selectedId: next.current?.name ?? '' });
    set('save', { enabled: ready && !next.saving && !!next.current && !next.current.shared }, { force: true });
    // The name field follows the scene only when the SCENE changes, so it
    // does not undo someone typing a new name into it.
    const sceneKey = next.current?.name ?? '';
    if (sceneKey !== lastScene) {
      set('saveName', { value: sceneKey }, { force: true });
      lastScene = sceneKey;
    }
    set('preview', { checked: !next.editMode });
    set('denoise', { checked: !!next.denoise });
    set('room', { selectedId: next.room ?? undefined });
    fill('camPos', next.camera?.position);
    fill('camTarget', next.camera?.target);

    const where = next.current
      ? `${next.current.name}  (${next.current.file})`
      : 'new scene, not saved yet';
    // pt-lab's own mode names are internal; say what the view is showing.
    const view = next.mode === 'loading' || next.mode === 'building-bvh' ? next.mode
      : next.editMode ? 'editing (raster preview)' : `path tracing, ${next.samples} samples`;
    const lines = [`${where}${next.dirty ? '\n● unsaved changes' : ''}`, view];
    // The denoiser runs on a schedule of its own, and only over the
    // path-traced view, so say where it is.
    if (next.denoise) {
      lines.push({
        off: 'denoise: off',
        unsupported: 'denoise: needs WebGPU, which this machine lacks',
        loading: 'denoise: loading the model…',
        ready: next.editMode ? 'denoise: waiting for the path-traced preview' : 'denoise: waiting',
        denoising: 'denoise: running…',
        denoised: `denoise: denoised at ${next.denoisedAt} samples`,
        error: 'denoise: failed -- see the Scene view\'s console',
      }[next.denoiseState] ?? `denoise: ${next.denoiseState}`);
    }
    if (next.saving) lines.push('', 'Saving…');
    if (next.error) lines.push('', `Error: ${next.error}`);
    else if (next.message) lines.push('', next.message);
    set('status', { text: wrap(lines.join('\n'), columnsFor('status')) }, { force: true });

    /* Objects */
    set('objects', {
      items: (next.objects ?? []).map((obj) => ({
        id: obj.id, label: obj.name, icon: obj.included ? '●' : '○',
      })),
      selectedIds: next.selected?.kind === 'object' ? [next.selected.id] : [],
    }, { force: true });
    set('bundled', {
      items: (next.bundled ?? []).map((b) => ({ id: b.path, label: b.path })),
      text: 'add one…',
    }, { force: true });

    const obj = next.selected?.kind === 'object' ? next.objects.find((x) => x.id === next.selected.id) : null;
    for (const key of OBJECT_FIELDS) show(key, !!obj);
    show('objNone', !obj);
    set('objNone', {
      text: wrap('Select an object to edit it. ● is in the scene, ○ is only in the library.',
        columnsFor('objNone')),
    }, { force: true });
    if (obj) {
      set('objTitle', { text: obj.name }, { force: true });
      set('included', { text: obj.included ? 'Exclude' : 'Include' }, { force: true });
      set('removeObject', { enabled: ready && obj.removable }, { force: true });
      set('color', { value: next.material?.color ?? '' });
      set('shininess', { value: next.material?.shininess ?? 0 });
      set('reflectivity', { value: next.material?.reflectivity ?? 0 });
      fill('position', next.transform?.position);
      fill('rotation', next.transform?.rotation);
      fill('scale', next.transform?.scale);
    }

    /* Lights */
    set('lights', {
      items: (next.lights ?? []).map((light) => ({ id: light.id, label: `${light.name}  (${light.type})` })),
      selectedIds: next.selected?.kind === 'light' ? [next.selected.id] : [],
    }, { force: true });
    const light = next.selected?.kind === 'light' ? next.lights.find((x) => x.id === next.selected.id) : null;
    for (const key of LIGHT_FIELDS) show(key, !!light);
    show('lightNone', !light);
    set('lightNone', {
      text: wrap('Select a light to edit it. Lights add to the room\'s own lamp; they never replace it.',
        columnsFor('lightNone')),
    }, { force: true });
    set('removeLight', { enabled: ready && !!light }, { force: true });
    if (light) {
      const info = (next.lightTypes ?? []).find((t) => t.type === light.type);
      set('lightTitle', { text: `${light.name}  (${info?.unit ?? ''})` }, { force: true });
      set('lightName', { value: light.name });
      set('lightType', {
        items: (next.lightTypes ?? []).map((t) => ({ id: t.type, label: t.label })),
        selectedId: light.type,
      });
      set('lightColor', { value: light.color });
      set('intensity', { max: info?.maxIntensity ?? 200, value: light.intensity });
      fill('lightPos', light.position);
    }
  }

  return {
    update,
    dispose() {
      window.removeEventListener('pointerdown', onDown, true);
      window.removeEventListener('pointerup', onUp, true);
      clearTimeout(retry);
      unsubscribe();
      controlStore.clear(paneId);
    },
  };
}
