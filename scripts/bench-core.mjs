/**
 * One frame's pipeline, timed: the part of `npm run bench` that runs
 * wherever the package does -- under Node against the addon or the module,
 * and bundled into a browser's Web Worker. Host-free, like the package.
 *
 * Each statement runs on its own so its time is its own; a frame's total is
 * their sum, `frame()` included, since handing the frame over is per-frame
 * work too. Every repetition runs in a fresh session and checks it ends with
 * the same output hashes as the first, so a fast wrong answer cannot pass.
 */

import { Session } from '../packages/vision/src/session.js';

const now = () => globalThis.performance.now();

/**
 * @param {object} o
 * @param {object} o.registry   built with a readFrame that knows `frames`' sources
 * @param {{source: string, commands: string[]}[]} o.frames
 * @param {string[]} o.script   statements, run after `A = frame(source)`
 * @param {number} o.reps       timed repetitions per frame, after one warm-up
 * @returns {Promise<{source: string, totals: number[], ops: Record<string, number[]>, hashes: string[]}[]>}
 */
export async function benchFrames({ registry, frames, script, reps }) {
  const out = [];
  for (const { source, commands } of frames) {
    const statements = [`A = frame(${JSON.stringify(source)})`, ...script, ...commands];
    const totals = [];
    const ops = {};
    let hashes = null;
    for (let rep = 0; rep <= reps; rep++) {
      const session = new Session({ registry });
      let total = 0;
      const times = {};
      for (const statement of statements) {
        const t0 = now();
        await session.execute(statement);
        const dt = now() - t0;
        total += dt;
        const op = statement.replace(/^\s*\w+\s*=\s*/, '').replace(/\(.*$/, '');
        times[op] = (times[op] ?? 0) + dt;
      }
      const these = session.toJSON().entries.map((e) => e.output.hash);
      if (!hashes) hashes = these;
      else if (these.join() !== hashes.join()) throw new Error(`${source}: repetition ${rep} gave different hashes`);
      session.reset();
      if (rep === 0) continue;   // warm-up: compilation, first allocation
      totals.push(total);
      for (const [op, dt] of Object.entries(times)) (ops[op] ??= []).push(dt);
    }
    out.push({ source, totals, ops, hashes });
  }
  return out;
}
