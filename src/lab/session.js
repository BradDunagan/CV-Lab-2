'use strict';

/**
 * Slots, execution, and the session log — design-lab-model.md §5.
 *
 * There is ONE append-only log. A slot's provenance is not stored on the slot;
 * it is the sub-graph of log entries the slot depends on, derived on demand.
 *
 * Slot names are mutable bindings; log entries are immutable. `A = blur(A)`
 * appends an entry producing `A#2` and rebinds the name — `A#1` still means
 * what it meant. Entries are commits, slot names are refs.
 */

const crypto = require('node:crypto');

const { bindArgs, resolveCall, formatCall, CallError } = require('./registry');
const { parseStatement, parseScript } = require('./parser');

class SessionError extends Error {}

const key = (slot, version) => `${slot}#${version}`;

/**
 * Hashing and buffer inspection are injected so the session is testable
 * without the native addon. The default adapter uses it.
 */
function nativeAdapter() {
  const native = require('../../native');
  return {
    describe(handle) {
      const info = native.bufferInfo(handle);
      return {
        width: info.width, height: info.height, channels: info.channels,
        dtype: info.dtype, space: info.space,
      };
    },
    hash(handle) {
      // NOTE: bufferRead copies, because Electron forbids external
      // ArrayBuffers (electron-guide.md §1). For a 48 MB buffer that is ~10 ms
      // per operation. If it shows up in a profile, move the hash into C so
      // the bytes never cross.
      const values = native.bufferRead(handle);
      return crypto.createHash('sha256')
        .update(Buffer.from(values.buffer, values.byteOffset, values.byteLength))
        .digest('hex');
    },
    release(handle) { native.bufferRelease(handle); },
  };
}

function hashScalars(values) {
  return crypto.createHash('sha256')
    .update(JSON.stringify(values, Object.keys(values).sort()))
    .digest('hex');
}

/**
 * Hash a feature list.
 *
 * Every field of every record, with keys SORTED rather than taken in whatever
 * order the producer happened to build the object in — so the hash describes
 * the geometry and not the construction, and cannot depend on insertion order.
 *
 * Sorted rather than a fixed key list, and that is a correction: the first
 * version listed the fields of a line segment, so when corner records arrived
 * with different fields entirely, every one of them hashed on `id` and `angle`
 * alone. Two completely different sets of corners produced the same hash, which
 * is worse than having no hash, because a matching hash is supposed to mean
 * matching results. A hardcoded list silently drops whatever it was not written
 * for; sorting the keys cannot.
 *
 * Numbers go in at full precision: rounding would hide real changes, which is
 * the opposite of the point.
 */
function hashFeatures(features) {
  const canonical = features.map((f) =>
    Object.keys(f).sort().map((k) => [k, f[k]]));
  return crypto.createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

class Session {
  /**
   * @param {object} options
   * @param {import('./registry').Registry} options.registry
   * @param {object} [options.buffers] adapter: { describe, hash, release }
   * @param {object} [options.environment] recorded once per session (§5)
   */
  constructor({ registry, buffers, environment } = {}) {
    if (!registry) throw new SessionError('Session requires a registry');
    this.registry = registry;
    this.buffers = buffers ?? nativeAdapter();
    this.environment = environment ?? {};

    /** @type {Map<string, {version:number, value:object}>} name -> binding */
    this.slots = new Map();
    /** @type {Array<object>} the append-only log */
    this.log = [];
    /** @type {Map<string, number>} "A#1" -> entry number that produced it */
    this._producedBy = new Map();
    /** @type {Map<string, number[]>} "A#1" -> entry numbers that consumed it */
    this._consumedBy = new Map();
  }

  /* ---------------------------------------------------------------- */
  /* execution                                                         */
  /* ---------------------------------------------------------------- */

  /**
   * Parse, validate, execute, and append one log entry.
   *
   * Awaitable because kernels will move onto libuv's thread pool so the UI
   * cannot block (§3). They are synchronous today; making the CONTRACT async
   * now means that change touches only the kernel binding, not every caller.
   *
   * @param {string} source one statement of the command language
   */
  async execute(source) {
    const statement = parseStatement(source);
    if (!statement) return null;
    return this.executeStatement(statement, source);
  }

  async executeStatement(statement, source = '') {
    const op = this.registry.get(statement.op);
    const { inputSlots, params } = bindArgs(op, statement.positional, statement.named);

    // Resolve slot NAMES to (slot, version) refs. This is the moment ambiguity
    // is removed: the entry records the version that was current right now.
    const inputs = inputSlots.map((name) => {
      const binding = this.slots.get(name);
      if (!binding) {
        throw new SessionError(
          `unknown slot "${name}" — defined: ${[...this.slots.keys()].join(', ') || '(none)'}`
        );
      }
      return { slot: name, version: binding.version };
    });

    // Defaults are resolved here, and the record is canonical from now on.
    const record = resolveCall(op, { inputs, params });
    return this._apply(op, record, statement.target, source);
  }

  /**
   * The execution core, shared by live execution and replay.
   *
   * Replay comes through here with a record read from a file rather than one
   * just built from typed text. That is deliberate: the record is what is
   * authoritative, not `entry.text`. The text carries versioned refs like
   * `A#1` for the reader's benefit and is not itself re-parseable.
   */
  async _apply(op, record, target, source = '') {
    /*
     * Three output kinds. `scalars` is a measurement and binds to nothing;
     * `buffer` and `features` both occupy a slot. Written as a kind rather
     * than a boolean because the boolean -- "anything that is not scalars is
     * a buffer" -- is exactly the assumption a third kind invalidates.
     */
    const outputKind = op.output.kind ?? 'buffer';
    const bindsToSlot = outputKind !== 'scalars';
    if (bindsToSlot && !target) {
      throw new SessionError(`${op.name} produces a ${outputKind}, so it needs a target: X = ${op.name}(...)`);
    }
    if (!bindsToSlot && target) {
      throw new SessionError(`${op.name} produces no buffer, so it cannot be assigned to "${target}"`);
    }
    if (!op.implemented) {
      throw new SessionError(`operation "${op.name}" is declared but has no kernel yet`);
    }

    const inputValues = record.inputs.map((ref, index) => {
      const binding = this.slots.get(ref.slot);
      if (!binding) throw new SessionError(`unknown slot "${ref.slot}"`);
      if (binding.version !== ref.version) {
        throw new SessionError(
          `${ref.slot}#${ref.version} is no longer bound (current is #${binding.version})`
        );
      }
      this._checkInputKind(op, index, ref, binding.value);
      this._checkSpace(op, index, ref, binding.value);
      return binding.value;
    });

    const result = await op.kernel({
      inputs: inputValues,
      params: { ...record.params, ...record.incidental },
      cancelled: () => false, // §3: the flag exists from the first kernel
    });

    const n = this.log.length + 1;
    const entry = {
      n,
      source: source.trim(),
      text: formatCall(record),
      record,
      output: this._describeResult(result, outputKind),
      produced: null,
    };

    if (bindsToSlot) {
      const previous = this.slots.get(target);
      const version = (previous?.version ?? 0) + 1;

      /*
       * Free the superseded buffer now rather than leaving it to GC.
       * `A = gaussian(A)` binds A#2 and makes A#1 unreachable — and an old
       * version can never be used again, because _apply refuses a ref whose
       * version is not the current binding. At 48 MB a slot, waiting for the
       * collector is not acceptable (§8).
       */
      if (previous && previous.value.kind === 'buffer') {
        this.buffers.release(previous.value.handle);
      }

      this.slots.set(target, { version, value: result });
      entry.produced = { slot: target, version };
      this._producedBy.set(key(target, version), n);
    }

    for (const ref of record.inputs) {
      const k = key(ref.slot, ref.version);
      if (!this._consumedBy.has(k)) this._consumedBy.set(k, []);
      this._consumedBy.get(k).push(n);
    }

    Object.freeze(entry.record);
    Object.freeze(entry);
    this.log.push(entry);
    return entry;
  }

  /**
   * Enforce the KIND an operation declares it needs.
   *
   * Declaring `kind: 'features'` on an input is not enough on its own -- the
   * same lesson as the colour space check below, which was declared in the
   * registry and enforced nowhere for one commit while `gray` quietly computed
   * luma and called it luminance.
   */
  _checkInputKind(op, index, ref, value) {
    const required = op.inputs[index]?.kind ?? 'buffer';
    if (value.kind === required) return;
    throw new SessionError(
      `${op.name} input ${index + 1} needs ${required}, but ${ref.slot}#${ref.version} ` +
        `holds ${value.kind}`
    );
  }

  /**
   * Enforce the colour space an operation declares it needs (§2).
   *
   * Declaring it in the registry is not enough on its own: without this check
   * `gray` will happily apply luminance coefficients to sRGB-encoded values
   * and produce luma while calling it luminance — silently wrong output rather
   * than an error, which is precisely the failure §2 exists to prevent.
   *
   * `none` satisfies any requirement. A gradient or a mask is not a colour, so
   * the linear-versus-sRGB question does not apply to it.
   */
  _checkSpace(op, index, ref, value) {
    const required = op.inputs[index]?.space ?? 'any';
    if (required === 'any' || value.kind !== 'buffer') return;

    const actual = this.buffers.describe(value.handle).space;
    if (actual === 'none' || actual === required) return;

    const fix = required === 'linear' ? 'toLinear' : 'toSrgb';
    throw new SessionError(
      `${op.name} needs ${required} input, but ${ref.slot}#${ref.version} is ${actual}. ` +
        `Convert it explicitly: X = ${fix}(${ref.slot})`
    );
  }

  _describeResult(result, outputKind) {
    if (!result || result.kind !== outputKind) {
      throw new SessionError(
        `kernel was expected to return { kind: "${outputKind}", ... }, got ` +
          `${result ? `"${result.kind}"` : 'nothing'}`);
    }
    switch (outputKind) {
      case 'buffer':
        return { kind: 'buffer', ...this.buffers.describe(result.handle),
                 hash: this.buffers.hash(result.handle) };
      case 'features':
        return { kind: 'features', count: result.features.length,
                 hash: hashFeatures(result.features) };
      case 'scalars':
        return { kind: 'scalars', values: result.values, hash: hashScalars(result.values) };
      default:
        throw new SessionError(`unknown output kind "${outputKind}"`);
    }
  }

  /** Run a whole script, stopping at the first failure. */
  async run(script) {
    const entries = [];
    for (const { line, source, statement } of parseScript(script)) {
      try {
        entries.push(await this.executeStatement(statement, source));
      } catch (err) {
        err.message = `line ${line}: ${err.message}`;
        throw err;
      }
    }
    return entries;
  }

  /* ---------------------------------------------------------------- */
  /* the provenance graph                                              */
  /* ---------------------------------------------------------------- */

  entry(n) { return this.log[n - 1] ?? null; }

  /** Current version of a slot, or null. */
  versionOf(slot) { return this.slots.get(slot)?.version ?? null; }

  /**
   * Backward: every entry this one transitively depends on, including itself.
   * A DAG walk, not a tree walk — a node can be reached by several routes, so
   * `seen` is what keeps this terminating and linear.
   * @returns {number[]} entry numbers, ascending
   */
  ancestry(n) {
    const seen = new Set();
    const stack = [n];
    while (stack.length > 0) {
      const current = stack.pop();
      if (current === undefined || seen.has(current)) continue;
      seen.add(current);
      const entry = this.entry(current);
      if (!entry) continue;
      for (const ref of entry.record.inputs) {
        const producer = this._producedBy.get(key(ref.slot, ref.version));
        if (producer !== undefined) stack.push(producer);
      }
    }
    return [...seen].sort((a, b) => a - b);
  }

  /** Forward: entries that consumed a particular slot version. */
  consumers(slot, version) {
    return [...(this._consumedBy.get(key(slot, version)) ?? [])];
  }

  /** Human-readable provenance for the current binding of a slot. */
  provenanceOf(slot) {
    const version = this.versionOf(slot);
    if (version === null) throw new SessionError(`unknown slot "${slot}"`);
    const producer = this._producedBy.get(key(slot, version));
    return this.ancestry(producer).map((n) => this.entry(n));
  }

  /* ---------------------------------------------------------------- */
  /* persistence                                                       */
  /* ---------------------------------------------------------------- */

  toJSON() {
    return {
      format: 'cv-lab-2/session',
      formatVersion: 1,
      environment: this.environment,
      entries: this.log.map((e) => ({
        n: e.n,
        text: e.text,
        target: e.produced?.slot ?? null,
        record: e.record,
        output: e.output,
      })),
    };
  }

  /**
   * Re-execute a saved session and compare hashes.
   *
   * This is what makes reproducibility assertable rather than aspirational:
   * a kernel change that altered results announces itself here.
   *
   * @returns {{entries:Array, mismatches:Array}}
   */
  static async replay(saved, options) {
    if (saved?.format !== 'cv-lab-2/session') {
      throw new SessionError('not a cv-lab-2 session file');
    }
    const session = new Session(options);
    const mismatches = [];

    for (const savedEntry of saved.entries) {
      const op = session.registry.get(savedEntry.record.op);

      // Re-validate the stored record against the CURRENT definition, so an
      // op whose params changed shape fails loudly instead of silently.
      // Incidental params are absent from the record by design, so they take
      // today's defaults -- which is correct, since they cannot affect output.
      const record = resolveCall(op, {
        inputs: savedEntry.record.inputs,
        params: savedEntry.record.params,
      });

      const entry = await session._apply(op, record, savedEntry.target, savedEntry.text);

      if (entry.output.hash !== savedEntry.output.hash) {
        mismatches.push({
          n: savedEntry.n,
          text: savedEntry.text,
          expected: savedEntry.output.hash,
          actual: entry.output.hash,
          // A version bump explains a difference; an unchanged version means
          // a kernel was edited without being bumped.
          opVersion: { recorded: savedEntry.record.version, current: op.version },
        });
      }
    }
    return { session, entries: session.log, mismatches };
  }

  /**
   * Discard every slot and the whole log, freeing buffer memory immediately.
   *
   * Deliberately destructive and deliberately not an operation: it cannot go
   * in the log, because it destroys the log. Callers holding anything worth
   * keeping should save first.
   *
   * @returns {{entries:number, slots:number}} what was discarded
   */
  reset() {
    const discarded = { entries: this.log.length, slots: this.slots.size };
    for (const binding of this.slots.values()) {
      if (binding.value.kind === 'buffer') this.buffers.release(binding.value.handle);
    }
    this.slots.clear();
    this.log.length = 0;
    this._producedBy.clear();
    this._consumedBy.clear();
    return discarded;
  }

  /** The log as the user sees it, one line per entry. */
  format() {
    return this.log.map((e) => {
      const out = e.output;
      const shape = out.kind === 'buffer'
        ? `${out.width}×${out.height}×${out.channels} ${out.dtype} ${out.space}`
        : out.kind === 'features'
          ? `${out.count} feature${out.count === 1 ? '' : 's'}`
          : 'scalars';
      const target = e.produced ? `${e.produced.slot}#${e.produced.version} ← ` : '';
      return `#${e.n}  ${target}${e.text}`.padEnd(58) +
             `sha256:${out.hash.slice(0, 8)}…  ${shape}  [v${e.record.version}]`;
    }).join('\n');
  }
}

module.exports = { Session, SessionError, nativeAdapter, hashScalars };
