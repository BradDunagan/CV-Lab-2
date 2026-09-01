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
/*
 * Overridable so the platform branches can be exercised against a fixture.
 * This file has now picked the wrong binary once and failed to find it once,
 * both on Linux, both discovered by a CI round trip -- which is a slow way to
 * test a directory listing.
 */
const DIST = process.env.CV_SMOKE_DIST ?? path.join(ROOT, 'dist');
const PORT = Number(process.env.CV_SMOKE_PORT ?? 9345);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Binaries that ship BESIDE the application and are not it.
 *
 * `chrome_crashpad_handler` is the one that bit: the first version of this
 * launched it, watched it exit immediately, and reported "the app never opened
 * a window" — blaming the application for a defect in this file.
 */
const ELECTRON_HELPERS = new Set(['chrome-sandbox', 'chrome_crashpad_handler']);

/** A file name reduced to letters and digits, for comparing across platforms. */
const key = (name) => name.toLowerCase().replace(/\.exe$/, '').replace(/[^a-z0-9]/g, '');

/**
 * The names electron-builder might have given the executable.
 *
 * BOTH, because it depends on the platform and the difference is not
 * cosmetic. `platformPackager.js` uses `appInfo.productFilename` — productName,
 * so `CV-Lab` — on macOS and Windows, and `linuxPackager.js` uses
 * `appInfo.sanitizedName.toLowerCase()` — the package.json name, so
 * `cv-lab-2` — on Linux. Matching only the first found the app on two
 * platforms and not the third.
 */
function expectedNames() {
  const yml = fs.readFileSync(path.join(ROOT, 'electron-builder.yml'), 'utf8');
  const product = /^productName:\s*(.+)$/m.exec(yml)?.[1]?.trim();
  const pkg = require(path.join(ROOT, 'package.json')).name;
  return new Set([product, pkg].filter(Boolean).map(key));
}

/**
 * The executable inside the packaged output, per platform.
 *
 * Deliberately the unpacked directory rather than an installer: a .dmg or an
 * .exe would have to be mounted or run, which needs privileges CI does not
 * have and would be testing the installer rather than the app.
 *
 * Anchored on the app's OWN LAYOUT rather than on a name: the directory that
 * holds `resources/app.asar` is the one electron-builder produced, and within
 * it the application is whatever executable is not a known Electron helper. A
 * name match is used to choose when there are several, and the names are
 * derived rather than guessed — but the check does not depend on getting them
 * right, which it twice did not.
 *
 * Returns {exe} or {candidates} so a failure can say what it saw.
 */
function findExecutable() {
  if (!fs.existsSync(DIST)) return { candidates: [], searched: DIST };
  const names = expectedNames();
  const searched = [];

  const roots = fs.readdirSync(DIST, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => path.join(DIST, d.name));

  for (const root of roots) {
    // macOS buries the app one level further down, inside the bundle.
    const bundle = process.platform === 'darwin'
      ? fs.readdirSync(root).find((n) => n.endsWith('.app'))
      : null;
    const appDir = bundle ? path.join(root, bundle, 'Contents') : root;
    const binDir = bundle ? path.join(appDir, 'MacOS') : root;
    const asar = bundle
      ? path.join(appDir, 'Resources', 'app.asar')
      : path.join(root, 'resources', 'app.asar');
    if (!fs.existsSync(asar) || !fs.existsSync(binDir)) continue;
    searched.push(path.relative(ROOT, binDir));

    const candidates = fs.readdirSync(binDir, { withFileTypes: true })
      .filter((d) => d.isFile() && !ELECTRON_HELPERS.has(d.name))
      .map((d) => d.name)
      .filter((n) => (process.platform === 'win32'
        ? n.endsWith('.exe')
        : !path.extname(n) && (fs.statSync(path.join(binDir, n)).mode & 0o111) !== 0));

    const named = candidates.find((n) => names.has(key(n)));
    if (named) return { exe: path.join(binDir, named) };
    if (candidates.length === 1) return { exe: path.join(binDir, candidates[0]) };
    if (candidates.length > 1) return { candidates, searched, dir: binDir };
  }
  return { candidates: [], searched };
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

async function main() {
  const found = findExecutable();
  if (!found.exe) {
    console.error(
      `FAIL: could not identify the packaged application.\n` +
      `  looked in: ${[found.searched].flat().join(', ') || 'dist/'}\n` +
      `  expected a name among: ${[...expectedNames()].join(', ')}\n` +
      (found.candidates?.length
        ? `  found instead: ${found.candidates.join(', ')}\n`
        : `  found no application there — run \`npm run package\` first\n`)
    );
    process.exit(1);
  }
  const exe = found.exe;
  console.log(`  launching ${path.relative(ROOT, exe)}`);

  /*
   * --no-sandbox on Linux, and only on Linux.
   *
   * Chromium's setuid sandbox helper needs root to install its permission
   * bits, which a CI runner unpacking a build artifact never does -- so the
   * app refuses to start with a message about chrome-sandbox and this would
   * report a defect in Chromium's packaging as a defect in the app. What is
   * under test here is whether OUR code survived packaging.
   */
  const args = [`--remote-debugging-port=${PORT}`];
  if (process.platform === 'linux') args.push('--no-sandbox');

  /*
   * Keep what the process says, rather than discarding it.
   *
   * "The app never opened a window" is a true statement and a useless one --
   * it was this file's whole account of launching the wrong binary. When a
   * launch fails, whatever the process printed is the only evidence there is,
   * so it goes in the failure message.
   */
  const child = spawn(exe, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  const keep = (chunk) => { output = (output + chunk).slice(-2000); };
  child.stdout.on('data', keep);
  child.stderr.on('data', keep);
  let exited = null;
  child.on('exit', (code, signal) => { exited = signal ?? `exit code ${code}`; });
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
    if (!page) {
      const said = output.trim();
      throw new Error(
        `the app never opened a window — it failed to start` +
        (exited ? ` (${exited})` : '') +
        (said ? `\n    it said: ${said.split('\n').slice(-6).join('\n    ')}` : '')
      );
    }
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
}

if (require.main === module) {
  main().catch((err) => {
    console.error(`FAIL: ${err.message}`);
    process.exit(1);
  });
}

module.exports = { findExecutable, expectedNames, ELECTRON_HELPERS };
