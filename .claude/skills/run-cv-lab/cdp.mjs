#!/usr/bin/env node
/**
 * Drive a running CV-Lab over the Chrome DevTools Protocol, with REAL input.
 *
 * The app must have been started with both debug ports open:
 *
 *   npx electron . --remote-debugging-port=9333 --inspect=9334
 *
 * 9333 is the renderer (the app window); 9334 is the main process's Node
 * inspector, which is how a menu item is "clicked" -- see `menu`.
 *
 * Clicks and keys are Input.dispatch* events: they go through hit-testing and
 * the focus model exactly as a person's would, which is the point. A
 * Runtime.evaluate that sets a control's value would test nothing.
 *
 * Commands (one per invocation; each prints JSON or a short line):
 *
 *   wait                      until both ports answer and the window is up
 *   menu <id>                 what the menu item <id> sends (src/menu.js)
 *   eval <js>                 evaluate in the renderer, print the value
 *   main <js>                 evaluate in the main process (require via
 *                             process.mainModule.require)
 *   find <text>               visible elements whose text is exactly <text>,
 *                             with their CSS-pixel centres
 *   click <x> <y>             a real click at CSS pixels
 *   click-text <text> [n]     click the n-th (default 0) element with <text>
 *   set <label> <value>       paneless editbox to the right of <label>:
 *                             click into it, clear it, type, Tab
 *   choose <label> <item>     paneless dropdown beside <label>: open, pick <item>
 *   check <text>              click the checkbox whose own text is <text>
 *   press <text>              click the button showing <text> (prefix match:
 *                             "Generate" matches "Generate 1")
 *   command <text>            type a command into the command bar, Enter
 *   key <Key>                 Enter | Tab | Backspace | Escape
 *   type <text>               insert text at the focus
 *   shot <file.png>           screenshot the window (device pixels: 2x CSS on
 *                             a Retina display)
 *
 * Coordinates are CSS pixels throughout. A screenshot is in DEVICE pixels, so
 * on a Retina Mac divide what you read off it by devicePixelRatio (2).
 */
import fs from 'node:fs';

const RENDERER = Number(process.env.CVLAB_RENDERER_PORT ?? 9333);
const MAIN = Number(process.env.CVLAB_MAIN_PORT ?? 9334);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function targets(port, path) {
  const res = await fetch(`http://127.0.0.1:${port}${path}`);
  return res.json();
}

async function connect(kind) {
  const url = kind === 'main'
    ? (await targets(MAIN, '/json/list'))[0]?.webSocketDebuggerUrl
    // The app window loads dist-renderer/; the generator and the Scene Editor
    // are other pages on the same port, which this must not pick by accident.
    : (await targets(RENDERER, '/json')).find((t) => t.type === 'page' && t.url.includes('dist-renderer'))
      ?.webSocketDebuggerUrl;
  if (!url) throw new Error(`no ${kind} target -- is the app running with both debug ports?`);
  const ws = new WebSocket(url);
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
  let next = 0;
  const pending = new Map();
  ws.onmessage = (m) => {
    const msg = JSON.parse(m.data);
    if (pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
  };
  const send = (method, params = {}) => new Promise((resolve) => {
    const id = ++next;
    pending.set(id, resolve);
    ws.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.error) throw new Error(JSON.stringify(r.error));
    if (r.result?.exceptionDetails) {
      throw new Error(r.result.result?.description ?? r.result.exceptionDetails.text);
    }
    return r.result?.result?.value;
  };
  return { send, evaluate, close: () => ws.close() };
}

/* --- input ----------------------------------------------------------- */

/*
 * Move, pause, press, pause, release. Sent back to back with no pause, a
 * paneless dropdown item click was missed; paced like a hand, it lands.
 */
async function click(r, x, y) {
  await r.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none' });
  await wait(150);
  await r.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 });
  await wait(80);
  await r.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 });
  await wait(150);
}

const KEYS = { Enter: 13, Tab: 9, Backspace: 8, Escape: 27 };
async function key(r, name) {
  const code = KEYS[name];
  if (!code) throw new Error(`unknown key ${name} (have: ${Object.keys(KEYS).join(', ')})`);
  await r.send('Input.dispatchKeyEvent', {
    type: 'keyDown', key: name, code: name, windowsVirtualKeyCode: code, nativeVirtualKeyCode: code,
    ...(name === 'Enter' ? { text: '\r' } : {}),
  });
  await r.send('Input.dispatchKeyEvent', { type: 'keyUp', key: name, code: name, windowsVirtualKeyCode: code, nativeVirtualKeyCode: code });
}

/* --- finding controls by what they show ------------------------------ */

/*
 * paneless draws its controls in SVG: a label is a <text>, a dropdown shows
 * its value in a <text>, each control is a <g data-control-id ...
 * data-control-type ...>. These run in the page. `mode` 'exact' or 'prefix'.
 */
const FIND = `(text, mode) => {
  const out = [];
  for (const e of document.querySelectorAll('text, button, span, div, label')) {
    if (e.children.length && e.tagName !== 'text') continue;
    const t = (e.textContent || '').trim();
    if (!(mode === 'prefix' ? t.startsWith(text) : t === text)) continue;
    const b = e.getBoundingClientRect();
    if (b.width === 0 || b.height === 0) continue;
    const g = e.closest('[data-control-type]');
    const gb = g?.getBoundingClientRect();
    out.push({ text: t, x: b.x + b.width / 2, y: b.y + b.height / 2, left: b.left, right: b.right,
      top: b.top, bottom: b.bottom, type: g?.getAttribute('data-control-type') ?? null,
      control: gb ? { left: gb.left, right: gb.right, y: gb.top + gb.height / 2 } : null });
  }
  return out;
}`;

/** The control whose box is to the right of a label, on the same row. */
const BESIDE = `(label) => {
  const find = ${FIND};
  const l = find(label, 'exact').find((f) => f.type === 'label' || f.type === null);
  if (!l) return null;
  for (let dx = 20; dx < 400; dx += 10) {
    for (const e of document.elementsFromPoint(l.right + dx, l.y)) {
      const g = e.closest('[data-control-type]');
      const type = g?.getAttribute('data-control-type');
      if (!type || type === 'label' || type === 'panel') continue;
      const b = g.getBoundingClientRect();
      return { type, left: b.left, right: b.right, top: b.top, bottom: b.bottom, y: b.top + b.height / 2 };
    }
  }
  return null;
}`;

async function findText(r, text, mode = 'exact') {
  return r.evaluate(`(${FIND})(${JSON.stringify(text)}, ${JSON.stringify(mode)})`);
}

async function beside(r, label) {
  const c = await r.evaluate(`(${BESIDE})(${JSON.stringify(label)})`);
  if (!c) throw new Error(`no control beside a label reading "${label}"`);
  return c;
}

/* --- commands -------------------------------------------------------- */

const [cmd, ...args] = process.argv.slice(2);

async function main() {
  if (cmd === 'wait') {
    for (let i = 0; i < 120; i++) {
      try {
        const r = await connect('renderer');
        const ok = await r.evaluate("document.readyState === 'complete' && !!window.lab");
        r.close();
        const m = await connect('main');
        m.close();
        if (ok) return console.log('ready');
      } catch { /* not up yet */ }
      await wait(500);
    }
    throw new Error('the app did not come up within 60 s');
  }

  if (cmd === 'menu') {
    const m = await connect('main');
    // Exactly what the menu item's click does: src/menu.js command(id) ->
    // main.js send(id) -> webContents.send('menu:command', id). A native
    // macOS menu cannot be clicked over CDP; this is the same message.
    const sent = await m.evaluate(`(() => {
      const { BrowserWindow } = process.mainModule.require('electron');
      const win = BrowserWindow.getAllWindows().find((w) => w.getTitle() === 'CV-Lab');
      if (!win) return 'no CV-Lab window';
      win.webContents.send('menu:command', ${JSON.stringify(args[0])});
      return 'sent ' + ${JSON.stringify(args[0])};
    })()`);
    m.close();
    return console.log(sent);
  }

  if (cmd === 'main') {
    const m = await connect('main');
    console.log(JSON.stringify(await m.evaluate(args.join(' ')), null, 1));
    return m.close();
  }

  const r = await connect('renderer');
  try {
    if (cmd === 'eval') {
      console.log(JSON.stringify(await r.evaluate(args.join(' ')), null, 1));
    } else if (cmd === 'find') {
      console.log(JSON.stringify(await findText(r, args.join(' ')), null, 1));
    } else if (cmd === 'click') {
      await click(r, Number(args[0]), Number(args[1]));
      console.log(`clicked ${args[0]},${args[1]}`);
    } else if (cmd === 'click-text') {
      const hits = await findText(r, args[0]);
      const h = hits[Number(args[1] ?? 0)];
      if (!h) throw new Error(`no visible "${args[0]}" (found ${hits.length})`);
      await click(r, h.x, h.y);
      console.log(`clicked "${args[0]}" at ${h.x.toFixed(0)},${h.y.toFixed(0)}`);
    } else if (cmd === 'set') {
      const [label, ...rest] = args;
      const value = rest.join(' ');
      const c = await beside(r, label);
      // Near the right end, so the caret lands after the existing text.
      await click(r, c.right - 8, c.y);
      for (let i = 0; i < 64; i++) await key(r, 'Backspace');
      await r.send('Input.insertText', { text: value });
      await key(r, 'Tab');
      console.log(`set ${label} = ${value} (${c.type})`);
    } else if (cmd === 'choose') {
      const [label, item] = args;
      const c = await beside(r, label);
      await click(r, c.right - 10, c.y); // the arrow
      await wait(200);
      // The open list's entry, not the closed button that may show the same text.
      const hit = (await findText(r, item)).find((f) => f.y > c.bottom);
      if (!hit) throw new Error(`"${item}" not offered by the ${label} dropdown`);
      await click(r, hit.x, hit.y);
      console.log(`chose ${label} = ${item}`);
    } else if (cmd === 'check') {
      const hit = (await findText(r, args.join(' '))).find((f) => f.type === 'checkbox');
      if (!hit) throw new Error(`no checkbox reading "${args.join(' ')}"`);
      // The box, not the words: a click on a paneless checkbox's text does
      // not toggle it. The box is the control's left end.
      await click(r, hit.control.left + 8, hit.control.y);
      console.log(`clicked checkbox "${args.join(' ')}"`);
    } else if (cmd === 'press') {
      const hit = (await findText(r, args.join(' '), 'prefix')).find((f) => f.type === 'button' || f.type === null);
      if (!hit) throw new Error(`no button reading "${args.join(' ')}"`);
      await click(r, hit.x, hit.y);
      console.log(`pressed "${hit.text}"`);
    } else if (cmd === 'command') {
      // The command bar is the one <input> in the window; its "A = pattern(...)"
      // is a placeholder, so it starts empty.
      const at = await r.evaluate(`(() => { const i = document.querySelector('input');
        if (!i) return null; const b = i.getBoundingClientRect();
        return { x: b.x + b.width / 2, y: b.y + b.height / 2 }; })()`);
      if (!at) throw new Error('no command bar');
      await click(r, at.x, at.y);
      await r.send('Input.insertText', { text: args.join(' ') });
      await key(r, 'Enter');
      console.log(`ran: ${args.join(' ')}`);
    } else if (cmd === 'key') {
      await key(r, args[0]);
      console.log(`key ${args[0]}`);
    } else if (cmd === 'type') {
      await r.send('Input.insertText', { text: args.join(' ') });
      console.log('typed');
    } else if (cmd === 'shot') {
      const res = await r.send('Page.captureScreenshot', { format: 'png' });
      fs.writeFileSync(args[0], Buffer.from(res.result.data, 'base64'));
      console.log(`saved ${args[0]}`);
    } else {
      throw new Error(`unknown command ${cmd}; see the header of this file`);
    }
  } finally {
    r.close();
  }
}

main().catch((err) => { console.error(err.message); process.exit(1); });
