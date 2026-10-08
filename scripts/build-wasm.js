#!/usr/bin/env node
'use strict';

/**
 * The C kernels compiled to WebAssembly: native/wasm/cvlab.wasm, and beside
 * it cvlab.wasm.json saying what it was built from.
 *
 *   npm run build:wasm             build, and write the manifest
 *   npm run build:wasm -- --check  build into a temporary file and require it
 *                                  to be byte-identical to the committed one
 *   npm run build:wasm -- --fetch  download the pinned wasi-sdk into .tools/
 *
 * The module is committed. A browser host -- rr -- consumes the file, not a
 * toolchain, and every CI runner tests the same bytes. What keeps a committed
 * binary honest is the manifest (test/wasm.js refuses a module whose sources
 * have changed since it was built) and `--check` (CI rebuilds it on Linux and
 * must get the same bytes the developer's Mac did). Either failing means
 * rebuild and commit, not "update the expectation".
 *
 * The toolchain is wasi-sdk, pinned by version and SHA-256: clang, wasm-ld
 * and wasi-libc in one tarball. The libc's libm is compiled INTO the module,
 * so `exp` and `pow` are the same bits in every engine. The module imports
 * nothing -- no WASI calls survive, because nothing here does I/O.
 *
 * Flags, and why:
 *   -ffp-contract=off   determinism rule 3 (design-lab-model.md §5). wasm has
 *                       no fused multiply-add without relaxed-simd, so this is
 *                       belt and braces -- but the rule is the rule.
 *   -O2                 as node-gyp's Release build.
 *   no -msimd128        item 5 measures speed first; SIMD changes no result
 *                       (nothing reassociates without -ffast-math), only time.
 *   -mexec-model=reactor  a library, not a program: no main, _initialize.
 *   --strip-debug, -ffile-prefix-map   no paths of this machine in the bytes,
 *                       so two machines build the same file.
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'native', 'wasm', 'cvlab.wasm');
const MANIFEST = `${OUT}.json`;
const SOURCES = ['native/buffer.c', 'native/fits.c', 'native/kernels.c', 'native/render.c', 'native/wasm_api.c'];
const HEADERS = ['native/buffer.h', 'native/fits.h', 'native/kernels.h', 'native/portable.h', 'native/render.h'];
const FLAGS = ['--target=wasm32-wasip1', '-mexec-model=reactor', '-std=c11', '-O2', '-ffp-contract=off',
  '-Wall', '-Wextra', '-pedantic', '-Werror', '-I', 'native', '-ffile-prefix-map=' + ROOT + '=.',
  '-Wl,--strip-debug', '-Wl,--max-memory=4294967296'];

const SDK = {
  version: '34',
  release: 'wasi-sdk-34',
  hosts: {
    'darwin-arm64': { asset: 'wasi-sdk-34.0-arm64-macos', sha256: '9c59398106b417f8f14913380fdf0097a8cc0ff4af9eb3ce0065a859e88d49e9' },
    'darwin-x64': { asset: 'wasi-sdk-34.0-x86_64-macos', sha256: '87d27fa8adc68dee59bfbf2e22a6d34ef717c34d6bf1d8af2a56fc929d9ce0eb' },
    'linux-x64': { asset: 'wasi-sdk-34.0-x86_64-linux', sha256: 'b761e3a0721dbae9c09a0059e5fdb2bf917d1b4a8a7b430fb3b5aafb0984b2c4' },
    'linux-arm64': { asset: 'wasi-sdk-34.0-arm64-linux', sha256: 'f7e243dff54d60bcc576e94d6166b69f410f2500ae4a9ceef34315be10e77971' },
  },
};

const sha256 = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

function host() {
  const h = SDK.hosts[`${process.platform}-${process.arch}`];
  if (!h) throw new Error(`build:wasm: no pinned wasi-sdk for ${process.platform}-${process.arch}`);
  return h;
}

function sdkDir() {
  if (process.env.WASI_SDK_PATH) return process.env.WASI_SDK_PATH;
  return path.join(ROOT, '.tools', host().asset);
}

function fetchSdk() {
  const { asset, sha256: expected } = host();
  const dir = path.join(ROOT, '.tools');
  const tarball = path.join(dir, `${asset}.tar.gz`);
  fs.mkdirSync(dir, { recursive: true });
  if (fs.existsSync(path.join(dir, asset, 'bin'))) { console.log(`build:wasm: ${asset} already in .tools/`); return; }
  const url = `https://github.com/WebAssembly/wasi-sdk/releases/download/${SDK.release}/${asset}.tar.gz`;
  console.log(`build:wasm: fetching ${url}`);
  const curl = spawnSync('curl', ['-fsSL', '-o', tarball, url], { stdio: 'inherit' });
  if (curl.status !== 0) throw new Error('build:wasm: download failed');
  const got = sha256(tarball);
  if (got !== expected) {
    fs.rmSync(tarball);
    throw new Error(`build:wasm: ${asset}.tar.gz has SHA-256 ${got}, expected ${expected}`);
  }
  const tar = spawnSync('tar', ['xzf', tarball, '-C', dir], { stdio: 'inherit' });
  if (tar.status !== 0) throw new Error('build:wasm: could not unpack the toolchain');
  fs.rmSync(tarball);
  console.log(`build:wasm: ${asset} in .tools/, SHA-256 checked`);
}

function build(out) {
  const sdk = sdkDir();
  const clang = path.join(sdk, 'bin', process.platform === 'win32' ? 'clang.exe' : 'clang');
  if (!fs.existsSync(clang)) {
    throw new Error(`build:wasm: no wasi-sdk at ${sdk}. Run: npm run build:wasm -- --fetch (or set WASI_SDK_PATH)`);
  }
  const args = [...FLAGS, `--sysroot=${path.join(sdk, 'share', 'wasi-sysroot')}`, ...SOURCES, '-o', out];
  const r = spawnSync(clang, args, { cwd: ROOT, encoding: 'utf8' });
  const output = `${r.stdout}${r.stderr}`.trim();
  if (r.status !== 0 || output) {
    console.error(output);
    throw new Error(`build:wasm: clang ${r.status !== 0 ? `exited ${r.status}` : 'printed the above'}`);
  }
  const version = spawnSync(clang, ['--version'], { encoding: 'utf8' }).stdout.split('\n')[0];
  const module = new WebAssembly.Module(fs.readFileSync(out));
  const imports = WebAssembly.Module.imports(module);
  if (imports.length) {
    throw new Error(`build:wasm: the module imports ${imports.map((i) => `${i.module}.${i.name}`).join(', ')}; it must import nothing`);
  }
  return version;
}

/*
 * Of the text, with CRLF read as LF: a Windows checkout converts line endings,
 * and the first CI run on Windows called every source stale for that alone.
 * The manifest describes what the compiler reads, which line endings do not
 * change.
 */
function sourceHashes() {
  const text = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8').replace(/\r\n/g, '\n');
  return Object.fromEntries([...SOURCES, ...HEADERS].map((f) =>
    [f, crypto.createHash('sha256').update(text(f)).digest('hex')]));
}

function main() {
  const args = process.argv.slice(2);
  if (args.includes('--fetch')) { fetchSdk(); return; }
  if (args.includes('--check')) {
    const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cvlab-wasm-')), 'cvlab.wasm');
    build(tmp);
    const built = sha256(tmp), committed = fs.existsSync(OUT) ? sha256(OUT) : null;
    if (built !== committed) {
      console.error(`build:wasm --check: this machine builds ${built}, the committed module is ${committed}.`);
      console.error('Either the sources changed and the module was not rebuilt, or the build is not reproducible.');
      process.exit(1);
    }
    console.log(`build:wasm --check: rebuilt byte-identical (${built.slice(0, 16)}...)`);
    return;
  }
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  const compiler = build(OUT);
  const manifest = {
    toolchain: { sdk: SDK.release, compiler },
    flags: FLAGS.filter((f) => !f.startsWith('-ffile-prefix-map')),
    sources: sourceHashes(),
    sha256: sha256(OUT),
    bytes: fs.statSync(OUT).size,
  };
  fs.writeFileSync(MANIFEST, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`build:wasm: ${path.relative(ROOT, OUT)}, ${manifest.bytes} bytes, ${manifest.sha256.slice(0, 16)}...`);
}

if (require.main === module) {
  try {
    main();
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}

module.exports = { SOURCES, HEADERS, MANIFEST, OUT, sourceHashes };
