#!/usr/bin/env node
'use strict';

/**
 * The vision package's TypeScript declarations, generated from its JSDoc
 * into packages/vision/types/ -- committed, because a TypeScript host (rr)
 * reads them from the package as it is, with no build step of its own.
 *
 *   npm run build:types            write them
 *   npm run build:types -- --check generate into a temporary directory and
 *                                  require the committed ones to match; then
 *                                  compile test/fixtures/vision-consumer.ts,
 *                                  a host's use of the package, against them
 *
 * The JSDoc is the source. A type that is wrong is fixed there, never in
 * types/, which the next build overwrites.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const PKG = path.join(ROOT, 'packages', 'vision');
const OUT = path.join(PKG, 'types');
const TSC = path.join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc');

function tsc(args) {
  const r = spawnSync(process.execPath, [TSC, ...args], { cwd: ROOT, encoding: 'utf8' });
  if (r.status !== 0) {
    console.error(`${r.stdout}${r.stderr}`.trim());
    throw new Error(`build:types: tsc exited ${r.status}`);
  }
}

function generate(outDir) {
  const sources = fs.readdirSync(path.join(PKG, 'src')).filter((f) => f.endsWith('.js'))
    .sort().map((f) => path.join('packages', 'vision', 'src', f));
  fs.rmSync(outDir, { recursive: true, force: true });
  tsc(['--allowJs', '--declaration', '--emitDeclarationOnly', '--skipLibCheck', '--target', 'es2022',
    '--module', 'esnext', '--moduleResolution', 'bundler', '--lib', 'es2022,dom', '--newLine', 'lf',
    '--outDir', outDir, ...sources]);
}

const listing = (dir) => Object.fromEntries(fs.readdirSync(dir).sort()
  .map((f) => [f, fs.readFileSync(path.join(dir, f), 'utf8')]));

function check() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cvlab-types-'));
  generate(path.join(tmp, 'types'));
  const fresh = listing(path.join(tmp, 'types'));
  const committed = fs.existsSync(OUT) ? listing(OUT) : {};
  const differ = [...new Set([...Object.keys(fresh), ...Object.keys(committed)])]
    .filter((f) => fresh[f] !== committed[f]?.replace(/\r\n/g, '\n'));
  if (differ.length) throw new Error(`build:types --check: packages/vision/types/ is stale (${differ.join(', ')}); run npm run build:types`);

  // The consumer, resolved as a host resolves the package: by name.
  const config = {
    compilerOptions: {
      strict: true, noEmit: true, skipLibCheck: false, target: 'es2022', module: 'esnext',
      moduleResolution: 'bundler', lib: ['es2022', 'dom'], types: [],
      paths: { '@cv-lab/vision': [path.join(OUT, 'index.d.ts')], '@cv-lab/vision/*': [path.join(OUT, '*.d.ts')] },
    },
    files: [path.join(ROOT, 'test', 'fixtures', 'vision-consumer.ts')],
  };
  const tsconfig = path.join(tmp, 'tsconfig.json');
  fs.writeFileSync(tsconfig, JSON.stringify(config));
  tsc(['-p', tsconfig]);
  console.log(`build:types --check: ${Object.keys(fresh).length} declaration files current; a TypeScript host compiles against them`);
}

try {
  if (process.argv.includes('--check')) check();
  else { generate(OUT); console.log(`build:types: ${fs.readdirSync(OUT).length} files in packages/vision/types/`); }
} catch (err) {
  console.error(err.message);
  process.exit(1);
}
