'use strict';

/**
 * Page script. Note what is absent: no require(), no fs, no ipcRenderer, and
 * no pixel data. Everything privileged goes through window.lab, and the
 * preload draws into these canvases directly.
 */

const els = {
  tiles: document.getElementById('tiles'),
  empty: document.getElementById('empty'),
  command: document.getElementById('command'),
  run: document.getElementById('run'),
  open: document.getElementById('open'),
  opMenu: document.getElementById('op-menu'),
  cols: document.getElementById('cols'),
  fit: document.getElementById('fit'),
  save: document.getElementById('save'),
  log: document.getElementById('log'),
  probe: document.getElementById('probe'),
  status: document.getElementById('status'),
  versions: document.getElementById('versions'),
};

/** Shared across every tile, so pan and zoom stay in step (§7). Normalised
 *  0..1 so slots of different sizes still line up. */
const viewport = { x: 0, y: 0, w: 1, h: 1 };

/** Per-slot display transform. Non-destructive: none of this touches a buffer. */
const views = new Map();

const TILE_W = 480;
const TILE_H = 360;

const v = window.lab.versions;
els.versions.textContent =
  `Electron ${v.electron} · Chromium ${v.chrome} · Node ${v.node} · ${v.platform}/${v.arch}`;

/* ------------------------------------------------------------------ */
/* status and log                                                      */
/* ------------------------------------------------------------------ */

function setStatus(text, kind = '') {
  els.status.textContent = text;
  els.status.className = kind;
}

function appendLog(html) {
  const line = document.createElement('div');
  line.innerHTML = html;
  els.log.append(line);
  els.log.scrollTop = els.log.scrollHeight;
}

const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

function logEntry(entry) {
  const out = entry.output;
  const shape = out.kind === 'buffer'
    ? `${out.width}×${out.height}×${out.channels} ${out.dtype} ${out.space}`
    : `{ ${Object.entries(out.values).map(([k, x]) =>
        `${k}: ${typeof x === 'number' ? x.toPrecision(6) : x}`).join(', ')} }`;
  const target = entry.produced
    ? `<span class="slot">${esc(entry.produced.slot)}#${entry.produced.version}</span> ← ` : '';
  appendLog(
    `<span class="n">#${entry.n}</span>  ${target}${esc(entry.text)}\n` +
    `     <span class="hash">sha256:${out.hash.slice(0, 12)}…  ${esc(shape)}</span>`
  );
}

/* ------------------------------------------------------------------ */
/* the operation menu writes commands rather than calling directly     */
/* ------------------------------------------------------------------ */

function buildOpMenu() {
  const ops = window.lab.ops();
  els.opMenu.innerHTML = '<option value="">op…</option>';
  for (const op of ops) {
    const option = document.createElement('option');
    option.value = op.name;
    option.textContent = op.implemented ? op.name : `${op.name} (no kernel)`;
    option.disabled = !op.implemented;
    option.title = op.help;
    els.opMenu.append(option);
  }

  els.opMenu.addEventListener('change', () => {
    const op = ops.find((o) => o.name === els.opMenu.value);
    els.opMenu.value = '';
    if (!op) return;
    // §4: the menu composes command text and puts it in the bar. One execution
    // path, and the user learns the language by using the interface.
    const args = [
      ...op.inputs.map((_, i) => String.fromCharCode(65 + i)),
      ...op.params.map((p) => `${p.name}=${p.default}`),
    ];
    const target = op.inputs.length === 0 || op.name !== 'stats' ? nextSlotName() + ' = ' : '';
    els.command.value = `${target}${op.name}(${args.join(', ')})`;
    els.command.focus();
  });
}

function nextSlotName() {
  const used = new Set(window.lab.slots().map((s) => s.name));
  for (let i = 0; i < 26; i++) {
    const name = String.fromCharCode(65 + i);
    if (!used.has(name)) return name;
  }
  return 'X';
}

/* ------------------------------------------------------------------ */
/* tiles                                                               */
/* ------------------------------------------------------------------ */

function defaultView(info) {
  // §6's defaults by data kind: signed data gets a diverging map centred on
  // zero, label maps get categorical with no interpolation, everything else
  // is linear grey.
  if (info.dtype === 'i32') {
    return { type: 'image', colormap: 'categorical', range: 'auto', curve: 'linear', channel: -1 };
  }
  if (info.space === 'none') {
    return { type: 'image', colormap: 'diverging', range: 'symmetric', curve: 'linear', channel: -1 };
  }
  return { type: 'image', colormap: 'gray', range: 'auto', curve: 'linear', channel: -1 };
}

function select(name, options, value, onChange) {
  const el = document.createElement('select');
  el.title = name;
  for (const option of options) {
    const o = document.createElement('option');
    o.value = String(option.value ?? option);
    o.textContent = String(option.label ?? option);
    el.append(o);
  }
  el.value = String(value);
  el.addEventListener('change', () => onChange(el.value));
  return el;
}

function buildTile(slot) {
  const view = views.get(slot.name);

  const tile = document.createElement('section');
  tile.className = 'tile';
  tile.dataset.slot = slot.name;

  const header = document.createElement('header');
  const name = document.createElement('span');
  name.className = 'name';
  name.textContent = `${slot.name}#${slot.version}`;
  const meta = document.createElement('span');
  meta.className = 'meta';
  meta.textContent = `${slot.width}×${slot.height}×${slot.channels} ${slot.dtype} ${slot.space}`;
  header.append(name, meta);

  const redraw = (key) => (value) => {
    view[key] = key === 'channel' ? Number(value) : value;
    drawTile(slot.name);
  };

  header.append(
    select('view', ['image', 'histogram'], view.type, redraw('type')),
    select('colormap', ['gray', 'viridis', 'turbo', 'diverging', 'categorical'],
      view.colormap, redraw('colormap')),
    select('range', ['auto', 'percentile', 'symmetric'], view.range, redraw('range')),
    select('curve', ['linear', 'log', 'abs', 'sqrt'], view.curve, redraw('curve')),
    select('channel',
      [{ value: -1, label: 'all' },
       ...Array.from({ length: slot.channels }, (_, i) => ({ value: i, label: `ch${i}` }))],
      view.channel, redraw('channel'))
  );

  const canvas = document.createElement('canvas');
  canvas.id = `tile-canvas-${slot.name}`;
  canvas.width = TILE_W;
  canvas.height = TILE_H;

  const footer = document.createElement('footer');
  footer.innerHTML = '<span class="scale"></span><span class="zoom"></span>';

  tile.append(header, canvas, footer);
  return tile;
}

function drawTile(slotName) {
  const tile = els.tiles.querySelector(`.tile[data-slot="${slotName}"]`);
  if (!tile) return;
  const view = views.get(slotName);
  const canvas = tile.querySelector('canvas');
  const scale = tile.querySelector('.scale');

  try {
    if (view.type === 'histogram') {
      drawHistogram(canvas, slotName, view);
      scale.textContent = 'histogram';
    } else {
      const { lo, hi } = window.lab.draw(canvas.id, slotName, { ...view, viewport });
      scale.textContent = `${fmt(lo)} … ${fmt(hi)}  ${view.colormap}`;
    }
    tile.querySelector('.zoom').textContent = `${(1 / viewport.w).toFixed(1)}×`;
  } catch (err) {
    scale.textContent = err.message;
  }
}

function drawHistogram(canvas, slotName, view) {
  const { counts, lo, hi } = window.lab.histogram(slotName,
    { bins: 128, curve: view.curve, range: view.range, channel: view.channel });
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#0d0d10';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  const peak = Math.max(...counts, 1);
  const barWidth = canvas.width / counts.length;
  ctx.fillStyle = '#6ea8fe';
  counts.forEach((count, i) => {
    const height = (count / peak) * (canvas.height - 18);
    ctx.fillRect(i * barWidth, canvas.height - height - 14, Math.max(1, barWidth - 1), height);
  });

  ctx.fillStyle = '#8b8b97';
  ctx.font = '11px ui-monospace, Menlo, monospace';
  ctx.fillText(fmt(lo), 4, canvas.height - 3);
  const right = fmt(hi);
  ctx.fillText(right, canvas.width - ctx.measureText(right).width - 4, canvas.height - 3);
}

const fmt = (x) =>
  Math.abs(x) >= 1000 || (x !== 0 && Math.abs(x) < 0.01) ? x.toExponential(2) : x.toFixed(3);

function refreshTiles() {
  const slots = window.lab.slots();
  els.empty.hidden = slots.length > 0;

  for (const slot of slots) {
    if (!views.has(slot.name)) views.set(slot.name, defaultView(slot));
  }
  for (const name of [...views.keys()]) {
    if (!slots.some((s) => s.name === name)) views.delete(name);
  }

  els.tiles.textContent = '';
  for (const slot of slots) els.tiles.append(buildTile(slot));
  for (const slot of slots) drawTile(slot.name);
}

/* ------------------------------------------------------------------ */
/* shared pan and zoom (§7)                                            */
/* ------------------------------------------------------------------ */

function redrawAll() {
  for (const name of views.keys()) drawTile(name);
}

function zoomAt(nx, ny, factor) {
  const w = Math.min(1, Math.max(1 / 512, viewport.w * factor));
  const h = Math.min(1, Math.max(1 / 512, viewport.h * factor));
  // Keep the point under the cursor fixed.
  viewport.x = clamp01(viewport.x + (nx - viewport.x) * (1 - w / viewport.w), w);
  viewport.y = clamp01(viewport.y + (ny - viewport.y) * (1 - h / viewport.h), h);
  viewport.w = w;
  viewport.h = h;
  redrawAll();
}

const clamp01 = (value, size) => Math.min(Math.max(value, 0), Math.max(0, 1 - size));

function normalisedFrom(event, canvas) {
  const rect = canvas.getBoundingClientRect();
  const fx = (event.clientX - rect.left) / rect.width;
  const fy = (event.clientY - rect.top) / rect.height;
  return { nx: viewport.x + fx * viewport.w, ny: viewport.y + fy * viewport.h };
}

let dragging = null;

els.tiles.addEventListener('wheel', (event) => {
  const canvas = event.target.closest('canvas');
  if (!canvas) return;
  event.preventDefault();
  const { nx, ny } = normalisedFrom(event, canvas);
  zoomAt(nx, ny, event.deltaY > 0 ? 1.15 : 1 / 1.15);
}, { passive: false });

els.tiles.addEventListener('pointerdown', (event) => {
  const canvas = event.target.closest('canvas');
  if (!canvas) return;
  dragging = { canvas, x: event.clientX, y: event.clientY };
  canvas.setPointerCapture(event.pointerId);
});

els.tiles.addEventListener('pointerup', () => { dragging = null; });

/* ------------------------------------------------------------------ */
/* the multi-slot probe (§7)                                           */
/* ------------------------------------------------------------------ */

let pending = null;

els.tiles.addEventListener('pointermove', (event) => {
  const canvas = event.target.closest('canvas');
  if (!canvas) { els.probe.hidden = true; return; }

  if (dragging) {
    const rect = dragging.canvas.getBoundingClientRect();
    viewport.x = clamp01(viewport.x - ((event.clientX - dragging.x) / rect.width) * viewport.w, viewport.w);
    viewport.y = clamp01(viewport.y - ((event.clientY - dragging.y) / rect.height) * viewport.h, viewport.h);
    dragging.x = event.clientX;
    dragging.y = event.clientY;
    redrawAll();
    return;
  }

  // One rAF-throttled call returns a readout for every slot at once.
  pending = { event, canvas };
  if (pending.scheduled) return;
  pending.scheduled = true;
  requestAnimationFrame(() => {
    const { event: e, canvas: c } = pending;
    pending.scheduled = false;
    const { nx, ny } = normalisedFrom(e, c);
    showProbe(e, window.lab.probeAll(nx, ny));
  });
});

els.tiles.addEventListener('pointerleave', () => { els.probe.hidden = true; });

function showProbe(event, readings) {
  const names = Object.keys(readings);
  if (names.length === 0) { els.probe.hidden = true; return; }

  const first = readings[names[0]];
  const width = Math.max(...names.map((n) => n.length));
  const lines = [`<span class="pk">(${first.x}, ${first.y})</span>`];
  for (const name of names) {
    const { values } = readings[name];
    const text = values === null
      ? '—'
      : values.map((x) => (Number.isInteger(x) ? x : x.toFixed(4))).join('  ');
    lines.push(`<span class="pk">${esc(name.padEnd(width))}</span>  ${esc(text)}`);
  }
  els.probe.innerHTML = lines.join('\n');
  els.probe.hidden = false;

  const pad = 14;
  const box = els.probe.getBoundingClientRect();
  const left = event.clientX + pad + box.width > window.innerWidth
    ? event.clientX - pad - box.width : event.clientX + pad;
  const top = event.clientY + pad + box.height > window.innerHeight
    ? event.clientY - pad - box.height : event.clientY + pad;
  els.probe.style.left = `${Math.max(0, left)}px`;
  els.probe.style.top = `${Math.max(0, top)}px`;
}

/* ------------------------------------------------------------------ */
/* commands                                                            */
/* ------------------------------------------------------------------ */

const history = [];
let historyIndex = 0;

async function runCommand() {
  const source = els.command.value.trim();
  if (!source) return;

  els.run.disabled = true;
  setStatus('Running…');
  const started = performance.now();
  try {
    const entry = await window.lab.run(source);
    const ms = performance.now() - started;
    if (entry) {
      logEntry(entry);
      setStatus(`#${entry.n} in ${ms.toFixed(0)} ms`, 'ok');
    } else {
      setStatus('Nothing to do.');
    }
    history.push(source);
    historyIndex = history.length;
    els.command.value = '';
    refreshTiles();
  } catch (err) {
    appendLog(`<span class="err">${esc(source)}\n     ${esc(err.message)}</span>`);
    setStatus(err.message, 'error');
  } finally {
    els.run.disabled = false;
    els.command.focus();
  }
}

// The Open button writes a command rather than loading directly, so a file
// opened through the UI is in the log and replays like anything else (§4).
els.open.addEventListener('click', async () => {
  const filePath = await window.lab.openImage();
  if (!filePath) return;
  // quote() handles backslashes as well as quotes: a raw Windows path loses
  // every separator, since `\` is an escape character in the command language.
  els.command.value = `${nextSlotName()} = load(${window.lab.quote(filePath)})`;
  els.command.focus();
  await runCommand();
});

els.run.addEventListener('click', runCommand);
els.command.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') { runCommand(); return; }
  if (event.key === 'ArrowUp' && historyIndex > 0) {
    historyIndex--;
    els.command.value = history[historyIndex];
    event.preventDefault();
  }
  if (event.key === 'ArrowDown') {
    historyIndex = Math.min(history.length, historyIndex + 1);
    els.command.value = history[historyIndex] ?? '';
    event.preventDefault();
  }
});

els.cols.addEventListener('input', () => {
  els.tiles.style.setProperty('--cols', els.cols.value);
});

els.fit.addEventListener('click', () => {
  viewport.x = 0; viewport.y = 0; viewport.w = 1; viewport.h = 1;
  redrawAll();
});

els.save.addEventListener('click', async () => {
  try {
    const path = await window.lab.saveSession();
    setStatus(path ? `Saved ${path}` : 'Save cancelled', path ? 'ok' : '');
  } catch (err) {
    setStatus(err.message, 'error');
  }
});

/* ------------------------------------------------------------------ */

buildOpMenu();
els.tiles.style.setProperty('--cols', els.cols.value);
refreshTiles();
els.command.focus();
setStatus('Ready. Enter a command, or pick an operation to insert a template.');
