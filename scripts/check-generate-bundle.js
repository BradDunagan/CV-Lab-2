#!/usr/bin/env node
'use strict';

/**
 * Assert the generator bundle actually contains the pt-lab it is calling.
 *
 * WHY, and this one shipped.
 *
 * pt-lab is a Vite ALIAS resolved against a sibling checkout, and
 * `src/generate/main.js` is plain JavaScript. So calling a pt-lab method that
 * does not exist is not a build error, not a type error and not a lint error —
 * it is a runtime error, in a window nothing opens until somebody asks for an
 * image. Build against a checkout that is a commit behind and everything is
 * green: the bundle builds, the app packages, the layout verifies, the smoke
 * test passes, and `--truth` throws `lab.groundTruthGeometry is not a function`
 * in a user's hands.
 *
 * That is exactly what happened. Two of three CI jobs went green over
 * installers whose headline feature could not run, because the sibling
 * checkout had a commit that had not been pushed.
 *
 * THE SUBTLETY THAT MAKES THIS MORE THAN A GREP.
 *
 * Both halves of the problem are in the same file. `dist-generate/generate.js`
 * contains main.js's CALL, `lab.groundTruthGeometry(...)`, and pt-lab's
 * DEFINITION, `groundTruthGeometry(size, opts) {`. Searching for the name
 * finds the call whether or not the definition is there, so a naive check
 * passes precisely when it matters. What distinguishes them is the dot: a call
 * is a property access and a definition is not.
 *
 * It runs from `postbuild:generate`, so a developer hears about it the moment
 * they build rather than at release — and `npm run package` runs the build, so
 * packaging is covered by the same check. It does NOT fire under
 * `npm run dev:generate`, because npm's post hooks do not run for a watch.
 *
 *   node scripts/check-generate-bundle.js
 */

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const PAGE = path.join(ROOT, 'src', 'generate', 'main.js');
const BUNDLE = path.join(ROOT, 'dist-generate', 'generate.js');
const PT_SRC = path.join(ROOT, '..', 'pt-lab-workspace', 'packages', 'pt-lab', 'src');

/**
 * Every method the page calls on the PathTracerLab instance.
 *
 * A regex over the source rather than a parse. The receiver is a single
 * well-known local (`lab`), the file is a hundred lines of our own code, and a
 * parser would be a large dependency for a list of identifiers. If the page
 * ever renames that variable this stops finding anything, which is why the
 * caller treats an empty result as a failure rather than a pass.
 */
function methodsCalledOnLab(source) {
  return [...new Set(
    [...source.matchAll(/\blab\s*\.\s*([A-Za-z_$][\w$]*)\s*\(/g)].map((m) => m[1])
  )].sort();
}

/**
 * Is `name` DEFINED in the bundle, rather than merely called?
 *
 * A definition is an identifier that is not a property access: `foo(` in a
 * class body, possibly after `async`. A call is `.foo(`. So the test is an
 * occurrence followed by an argument list and not preceded by a dot — or by a
 * word character, which would make it the tail of a longer name.
 *
 * Minification does not interfere: esbuild renames bindings, not property or
 * method names, so these survive verbatim. That is checked by the caller
 * finding the ones that ARE present rather than assumed here.
 */
function definedIn(bundle, name) {
  return new RegExp(`(?<![.\\w$])${name}\\s*\\(`).test(bundle);
}

/** Which of `names` the bundle calls but never defines. */
function missingFrom(bundle, names) {
  return names.filter((name) => !definedIn(bundle, name));
}

/* ------------------------------------------------------------------ */

function main() {
  if (!fs.existsSync(BUNDLE)) {
    console.error(
      `FAIL: no generator bundle at ${path.relative(ROOT, BUNDLE)}\n` +
      `Run: npm run build:generate`
    );
    return 1;
  }

  const page = fs.readFileSync(PAGE, 'utf8');
  const bundle = fs.readFileSync(BUNDLE, 'utf8');
  const called = methodsCalledOnLab(page);

  if (called.length === 0) {
    console.error(
      `FAIL: found no pt-lab calls in ${path.relative(ROOT, PAGE)}\n` +
      `  This check looks for \`lab.<method>(\`. If that variable was renamed, ` +
      `the check needs updating — it is not evidence that everything is fine.`
    );
    return 1;
  }

  const missing = missingFrom(bundle, called);
  if (missing.length > 0) {
    /*
     * Name the cause, because the fix is somewhere else entirely. Nothing in
     * this repository is wrong when this fires: the sibling checkout is behind
     * whatever main.js was written against, and it is usually an unpushed
     * commit rather than anything subtler.
     */
    console.error(
      `FAIL: the bundled pt-lab does not define ${missing.length} method(s) ` +
      `that src/generate/main.js calls:\n` +
      missing.map((m) => `  - lab.${m}()`).join('\n') + '\n\n' +
      `The generator was built against a pt-lab that is behind the code calling\n` +
      `it, so image generation would build, package and launch cleanly and then\n` +
      `throw the moment those are used.\n\n` +
      `  ${path.relative(ROOT, PT_SRC)}\n\n` +
      `Check that the sibling checkout has the commit you expect — an unpushed\n` +
      `one is the usual cause — then: npm run build:generate`
    );
    return 1;
  }

  console.log(
    `  ok   the bundle defines all ${called.length} pt-lab methods the page calls`
  );
  return 0;
}

if (require.main === module) process.exit(main());

module.exports = { methodsCalledOnLab, definedIn, missingFrom };
