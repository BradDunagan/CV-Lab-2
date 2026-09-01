#!/usr/bin/env node
'use strict';

/**
 * Launch the packaged app and check that it actually comes up.
 *
 * WHY THIS EXISTS, and it is not hypothetical.
 *
 * `verify-package.js` checks the LAYOUT of the artifact: the addon is
 * unpacked, the renderer is inside the archive, the installers were produced.
 * Every one of those passed while the packaged app was **completely dead on
 * launch** — the preload required `../scripts/png`, that file was never in the
 * `files:` list, so the require threw, `contextBridge.exposeInMainWorld` never
 * ran, and the window came up to "window.lab is missing". Three green
 * checkmarks per release, for as long as the bug existed.
 *
 * The lesson is the one in CLAUDE.md: a check that runs in one place can pass
 * for the wrong reason. Layout is not behaviour. So this starts the real
 * artifact, attaches to its renderer, and asks the questions a layout check
 * cannot:
 *
 *   - did the preload survive packaging, so `window.lab` exists at all?
 *   - are the operations registered, so the lab is usable?
 *   - is image generation present and does it report itself ready?
 *
 * It stops short of rendering an image: that needs a real GPU and twenty
 * seconds, and CI runners have neither. What it proves is that everything up
 * to the first frame survived the trip.
 *
 *   npm run smoke:package
 */

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const DIST = path.join(ROOT, 'dist');
const PORT = Number(process.env.CV_SMOKE_PORT ?? 9345);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * The executable inside the packaged output, per platform.
 *
 * Deliberately the unpacked directory rather than an installer: a .dmg or an
 * .exe would have to be mounted or run, which needs privileges CI does not
 * have and would be testing the installer rather than the app.
 */
function findExecutable() {
  if (!fs.existsSync(DIST)) return null;
  const dirs = fs.readdirSync(DIST, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => path.join(DIST, d.name));

  for (const dir of dirs) {
    if (process.platform === 'darwin') {
      const app = fs.readdirSync(dir).find((n) => n.endsWith('.app'));
      if (app) {
        const macos = path.join(dir, app, 'Contents', 'MacOS');
        const bin = fs.existsSync(macos) && fs.readdirSync(macos)[0];
        if (bin) return path.join(macos, bin);
      }
    } else if (process.platform === 'win32') {
      const exe = fs.readdirSync(dir).find((n) => n.endsWith('.exe'));
      if (exe) return path.join(dir, exe);
    } else {
      // linux-unpacked/, where the binary is named for the product and has no
      // extension. Skip chrome-sandbox and the .so files that sit beside it.
      const bin = fs.readdirSync(dir, { withFileTypes: true }).find((d) =>
        d.isFile() && !path.extname(d.name) && d.name !== 'chrome-sandbox' &&
        (fs.statSync(path.join(dir, d.name)).mode & 0o111) !== 0);
      if (bin) return path.join(dir, bin.name);
    }
  }
  return null;
}

const getJSON = (url) => new Promise((resolve, reject) => {
  const req = http.get(url, (res) => {
    let body = '';
    res.on('data', (d) => { body += d; });
    res.on('end', () => {
      try { resolve(JSON.parse(body)); } catch (err) { reject(err); }
    });
  });
  req.on('error', reject);
  req.setTimeout(5000, () => req.destroy(new Error('timed out')));
});

/**
 * A DevTools connection to the app's renderer.
 *
 * Raw WebSocket framing rather than a library: `ws` is not a dependency of
 * this project and adding one for a smoke test would be a poor trade. The
 * client half of RFC 6455 is a handshake and a masked frame, and the messages
 * here are small.
 */
function connect(url) {
  const crypto = require('node:crypto');
  const net = require('node:net');
  const { hostname, port, pathname } = new URL(url);
  const key = crypto.randomBytes(16).toString('base64');

  return new Promise((resolve, reject) => {
    const socket = net.connect(Number(port), hostname, () => {
      socket.write(
        `GET ${pathname} HTTP/1.1\r\nHost: ${hostname}:${port}\r\n` +
        `Upgrade: websocket\r\nConnection: Upgrade\r\n` +
        `Sec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`
      );
    });
    socket.on('error', reject);

    let buffer = Buffer.alloc(0);
    let handshaken = false;
    const handlers = new Map();
    let nextId = 0;

    const send = (obj) => {
      const payload = Buffer.from(JSON.stringify(obj));
      // Client frames must be masked. Payloads here are far below 64 KB, so
      // only the two shorter length forms can occur.
      const mask = crypto.randomBytes(4);
      const header = payload.length < 126
        ? Buffer.from([0x81, 0x80 | payload.length])
        : Buffer.concat([Buffer.from([0x81, 0xfe]),
                         Buffer.from([payload.length >> 8, payload.length & 0xff])]);
      const masked = Buffer.alloc(payload.length);
      for (let i = 0; i < payload.length; i++) masked[i] = payload[i] ^ mask[i % 4];
      socket.write(Buffer.concat([header, mask, masked]));
    };

    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (!handshaken) {
        const end = buffer.indexOf('\r\n\r\n');
        if (end === -1) return;
        if (!buffer.subarray(0, end).toString().includes('101')) {
          reject(new Error('the debugger refused the WebSocket upgrade'));
          return;
        }
        buffer = buffer.subarray(end + 4);
        handshaken = true;
        resolve({
          evaluate(expression, timeout = 30000) {
            return new Promise((res, rej) => {
              const id = ++nextId;
              const timer = setTimeout(() => {
                handlers.delete(id);
                rej(new Error(`timed out evaluating: ${expression}`));
              }, timeout);
              handlers.set(id, (msg) => {
                clearTimeout(timer);
                if (msg.error) return rej(new Error(JSON.stringify(msg.error)));
                if (msg.result?.exceptionDetails) {
                  return rej(new Error(msg.result.result?.description
                    ?? msg.result.exceptionDetails.text));
                }
                res(msg.result?.result?.value);
              });
              send({ id, method: 'Runtime.evaluate',
                     params: { expression, awaitPromise: true, returnByValue: true } });
            });
          },
          close: () => socket.destroy(),
        });
        return;
      }

      // Server frames are unmasked. Only text frames arrive here.
      for (;;) {
        if (buffer.length < 2) return;
        const length0 = buffer[1] & 0x7f;
        let offset = 2;
        let length = length0;
        if (length0 === 126) {
          if (buffer.length < 4) return;
          length = buffer.readUInt16BE(2);
          offset = 4;
        } else if (length0 === 127) {
          if (buffer.length < 10) return;
          length = Number(buffer.readBigUInt64BE(2));
          offset = 10;
        }
        if (buffer.length < offset + length) return;
        const payload = buffer.subarray(offset, offset + length).toString();
        buffer = buffer.subarray(offset + length);
        try {
          const msg = JSON.parse(payload);
          if (msg.id && handlers.has(msg.id)) {
            handlers.get(msg.id)(msg);
            handlers.delete(msg.id);
          }
        } catch { /* a control frame, or a partial we will see again */ }
      }
    });
  });
}

/* ------------------------------------------------------------------ */

(async () => {
  const exe = findExecutable();
  if (!exe) {
    console.error('FAIL: no packaged application in dist/ — run `npm run package` first');
    process.exit(1);
  }
  console.log(`  launching ${path.relative(ROOT, exe)}`);

  const child = spawn(exe, [`--remote-debugging-port=${PORT}`], { stdio: 'ignore' });
  const problems = [];
  let client = null;

  try {
    let page = null;
    for (let i = 0; i < 60 && !page; i++) {
      await sleep(500);
      try {
        const list = await getJSON(`http://127.0.0.1:${PORT}/json/list`);
        page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
      } catch { /* the debugger is not listening yet */ }
    }
    if (!page) throw new Error('the app never opened a window — it failed to start');
    client = await connect(page.webSocketDebuggerUrl);

    /*
     * The preload is what the whole app hangs off: it owns the session and
     * every buffer handle, and exposes `window.lab` over the contextBridge. If
     * it throws, the window still opens and looks approximately normal, which
     * is exactly why this needs asserting rather than eyeballing.
     */
    let bridge = 'undefined';
    for (let i = 0; i < 40; i++) {
      bridge = await client.evaluate('typeof window.lab');
      if (bridge === 'object') break;
      await sleep(500);
    }
    if (bridge !== 'object') {
      problems.push('window.lab is missing — the preload did not survive packaging');
    } else {
      console.log('  ok   the preload exposed window.lab');

      const ops = await client.evaluate('window.lab.ops().length');
      if (!ops || ops < 10) {
        problems.push(`only ${ops} operations registered — the registry did not survive packaging`);
      } else {
        console.log(`  ok   ${ops} operations registered`);
      }

      /*
       * Image generation ships as a feature, so a build where it is missing is
       * a defective build rather than a degraded one. check() returns null
       * when it is ready and a sentence when it is not.
       */
      const generator = await client.evaluate('window.lab.generate.check()');
      if (generator !== null) {
        problems.push(`image generation is not ready: ${String(generator).split('\n')[0]}`);
      } else {
        console.log('  ok   image generation reports itself ready');
      }

      const out = await client.evaluate('window.lab.generate.defaults().then((d) => d.out)');
      if (!out || !path.isAbsolute(out)) {
        problems.push(
          `the default output directory is ${JSON.stringify(out)}, which is not absolute — ` +
          'a packaged app inherits a working directory it never chose'
        );
      } else {
        console.log(`  ok   images default to ${out}`);
      }
    }
  } catch (err) {
    problems.push(err.message);
  } finally {
    client?.close();
    child.kill('SIGKILL');
  }

  if (problems.length > 0) {
    console.error(`\nFAIL (${problems.length}):`);
    for (const p of problems) console.error(`  - ${p}`);
    process.exit(1);
  }
  console.log(`\nThe packaged app starts and works on ${process.platform}/${process.arch}.`);
})();
