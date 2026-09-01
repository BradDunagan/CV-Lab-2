'use strict';

/**
 * The repository itself: things that should not be in it.
 *
 * WHY THIS EXISTS.
 *
 * A renderer build once wrote itself into the project ROOT rather than into
 * `dist-renderer/` — `renderer.js` plus one chunk per Monaco language, 92
 * files and 13 MB. `dist-renderer/` is gitignored and the root was not, so a
 * `git add -A` committed 83 of them, in a commit whose stat line read
 * "105 files changed, 70315 insertions(+)" and which nobody read.
 *
 * The `.gitignore` rule added alongside this stops that being committed again.
 * It does NOT stop it happening: an ignored file is invisible to
 * `git status`, so the next stray build would accumulate silently rather than
 * loudly, which is worse. This is the loud half.
 *
 * The rule it enforces — every `.js` in the root is build output — holds by
 * construction: the build configs are `.mjs`, and all source lives under
 * `src/`, `scripts/`, `test/` and `native/`. If that ever stops being true,
 * this test and the `.gitignore` rule have to change together, deliberately.
 *
 *   node test/repo.js
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');

let failures = 0;
function test(name, fn) {
  try { fn(); console.log(`  ok   ${name}`); }
  catch (err) { failures++; console.error(`  FAIL ${name}\n       ${err.message}`); }
}

console.log('cv-lab-2 repository tests');

test('the project root holds no build output', () => {
  const strays = fs.readdirSync(ROOT, { withFileTypes: true })
    .filter((d) => d.isFile() && d.name.endsWith('.js'))
    .map((d) => d.name);

  if (strays.length > 0) {
    /*
     * Name the cause, because "delete these" is not the useful part. A build
     * wrote them there, and it will do it again unless someone works out
     * which one — the timestamps and whether dist-renderer/ holds copies are
     * where that starts.
     */
    const shown = strays.slice(0, 6).join(', ');
    const more = strays.length > 6 ? `, and ${strays.length - 6} more` : '';
    assert.fail(
      `${strays.length} .js file(s) in the project root: ${shown}${more}\n` +
      `       Every .js here is build output — the configs are .mjs and the\n` +
      `       source is under src/, scripts/, test/ and native/. A renderer\n` +
      `       build has written itself to the root instead of dist-renderer/.\n` +
      `       They are gitignored, so 'git status' will not show them: delete\n` +
      `       them, and find which build put them there.`
    );
  }
});

test('the directories a build writes to are ignored, not tracked', () => {
  /*
   * The root case above happened because output landed somewhere the ignore
   * rules did not cover. These are the places output is SUPPOSED to go, so a
   * tracked file in any of them means the same class of mistake with a
   * different destination.
   */
  const { execFileSync } = require('node:child_process');
  const tracked = execFileSync('git',
    ['ls-files', '--', 'dist-renderer', 'dist-generate', 'dist', 'build'],
    { cwd: ROOT, encoding: 'utf8' }).trim();
  assert.equal(tracked, '',
    `build output is tracked in git:\n       ${tracked.split('\n').slice(0, 5).join('\n       ')}`);
});

test('every runtime require of the main and preload processes is packaged', () => {
  /*
   * The other way a file goes missing, and it shipped: `src/preload.js`
   * requires `../scripts/png` for readPngColour, `scripts/` was never in
   * electron-builder's `files:`, and every packaged build since came up to a
   * renderer with no `window.lab` at all.
   *
   * Only first-party relative requires are checked. A bare specifier is
   * either Node's own or `electron`, and neither is packaged from here.
   */
  const yml = fs.readFileSync(path.join(ROOT, 'electron-builder.yml'), 'utf8');
  const files = [...yml.matchAll(/^\s+-\s+"?([^"\n]+)"?\s*$/gm)]
    .map((m) => m[1].trim())
    .filter((f) => !f.startsWith('!'));

  const covered = (rel) => files.some((pattern) => {
    if (pattern === rel) return true;
    // The only glob shapes this config uses: `dir/**/*` and `dir/**/*.ext`.
    const m = /^(.+?)\/\*\*\/\*(\.[a-z]+)?$/.exec(pattern);
    if (!m) return false;
    const [, dir, ext] = m;
    return rel.startsWith(`${dir}/`) && (!ext || rel.endsWith(ext));
  });

  const missing = [];
  for (const entry of ['src/preload.js', 'src/main.js', 'src/menu.js']) {
    const source = fs.readFileSync(path.join(ROOT, entry), 'utf8');
    for (const [, spec] of source.matchAll(/require\('(\.[^']+)'\)/g)) {
      let target = path.normalize(path.join(path.dirname(entry), spec)).replace(/\\/g, '/');
      // A require without an extension resolves to .js or to a directory.
      if (!path.extname(target)) {
        if (fs.existsSync(path.join(ROOT, `${target}.js`))) target = `${target}.js`;
        else if (fs.existsSync(path.join(ROOT, target, 'index.js'))) target = `${target}/index.js`;
      }
      if (!fs.existsSync(path.join(ROOT, target))) continue; // not a file we can check
      if (!covered(target)) missing.push(`${entry} requires ${spec} -> ${target}`);
    }
  }

  assert.deepEqual(missing, [],
    `these are required at run time but not in electron-builder.yml's files:\n` +
    `       ${missing.join('\n       ')}\n` +
    `       A packaged build would throw on launch and the window would come\n` +
    `       up with no window.lab at all.`);
});

console.log(failures === 0 ? '\nAll repository tests passed.' : `\n${failures} failing.`);
process.exit(failures === 0 ? 0 : 1);
