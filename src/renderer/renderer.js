'use strict';

/**
 * Page script. Note what is absent: no require(), no fs, no ipcRenderer.
 * Everything privileged goes through window.cvlab, defined in src/preload.js.
 */

const canvas = document.getElementById('canvas');
const ctx = canvas.getContext('2d', { willReadFrequently: true });

const els = {
  open: document.getElementById('open'),
  invertAsync: document.getElementById('invert-async'),
  invertSync: document.getElementById('invert-sync'),
  reset: document.getElementById('reset'),
  empty: document.getElementById('empty'),
  status: document.getElementById('status'),
  versions: document.getElementById('versions'),
};

/** @type {ImageBitmap|null} the untouched decode, kept for Reset */
let original = null;

const v = window.cvlab.versions;
els.versions.textContent =
  `Electron ${v.electron} · Chromium ${v.chrome} · Node ${v.node} · ${v.platform}/${v.arch}`;

function setBusy(busy) {
  for (const b of [els.open, els.invertAsync, els.invertSync, els.reset]) {
    b.disabled = busy || (b !== els.open && original === null);
  }
}

function draw(bitmap) {
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  ctx.drawImage(bitmap, 0, 0);
  canvas.classList.add('loaded');
  els.empty.style.display = 'none';
}

async function openImage() {
  const filePath = await window.cvlab.openImage();
  if (!filePath) return;

  setBusy(true);
  els.status.textContent = `Loading ${window.cvlab.basename(filePath)}…`;
  try {
    const bytes = await window.cvlab.readFile(filePath);
    // Decode with the browser engine -- this is one place where being built on
    // Chromium is a real advantage; no native image codec needed.
    const bitmap = await createImageBitmap(new Blob([bytes]));
    original = bitmap;
    draw(bitmap);
    const mp = ((bitmap.width * bitmap.height) / 1e6).toFixed(1);
    els.status.textContent =
      `${window.cvlab.basename(filePath)} — ${bitmap.width}×${bitmap.height} (${mp} MP)`;
  } catch (err) {
    els.status.textContent = `Could not open image: ${err.message}`;
  } finally {
    setBusy(false);
  }
}

async function runInvert({ sync }) {
  if (!original) return;
  setBusy(true);

  const label = sync ? 'sync (UI thread)' : 'async (background thread)';
  els.status.textContent = `Inverting — ${label}…`;

  // Let the status text paint before we potentially block the thread.
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));

  // Note what is NOT here: no getImageData, no pixel array. The canvas id goes
  // across the bridge and a timing object comes back. All pixel handling stays
  // in the preload context, where the addon lives.
  let result;
  try {
    result = await window.cvlab.invertCanvas('canvas', { sync });
  } catch (err) {
    els.status.textContent = `Native call failed: ${err.message}`;
    setBusy(false);
    return;
  }

  const mp = (result.width * result.height) / 1e6;
  els.status.textContent =
    `Inverted ${mp.toFixed(1)} MP in ${result.ms.toFixed(1)} ms — ${label}` +
    (sync ? ' (notice the spinner stalled)' : ' (spinner kept moving)');
  setBusy(false);
}

function reset() {
  if (!original) return;
  draw(original);
  els.status.textContent = 'Reset to original.';
}

els.open.addEventListener('click', openImage);
els.invertAsync.addEventListener('click', () => runInvert({ sync: false }));
els.invertSync.addEventListener('click', () => runInvert({ sync: true }));
els.reset.addEventListener('click', reset);

setBusy(false);
