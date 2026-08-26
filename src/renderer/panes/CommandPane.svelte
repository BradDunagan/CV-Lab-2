<script>
  /**
   * The command bar — design-lab-model.md §4.
   *
   * The operation menu does NOT call operations. It composes a command string
   * and puts it in the bar, which is then executed the same way a typed one is.
   * One execution path, so the GUI and a script cannot diverge, everything done
   * through the interface is recorded and replayable, and the user learns the
   * language by using the interface. It is the most-loved thing about ImageJ's
   * macro recorder and it costs nothing to keep.
   */
  import { lab, runCommand, history, nextSlotName, setStatus } from '../lab.svelte.js';

  let input = $state('');
  let running = $state(false);
  /** @type {HTMLInputElement|undefined} */
  let field = $state();

  const ops = lab.ops();

  async function submit() {
    if (!input.trim() || running) return;
    running = true;
    const result = await runCommand(input);
    running = false;
    if (result.ok) input = '';
    field?.focus();
  }

  function insertTemplate(name) {
    const op = ops.find((o) => o.name === name);
    if (!op) return;
    // Fully-resolved defaults, exactly as the log will record them — so what
    // the user sees inserted is what provenance will say happened.
    const args = [
      ...op.inputs.map((_, i) => String.fromCharCode(65 + i)),
      ...op.params.map((p) => `${p.name}=${p.default}`),
    ];
    const assigns = op.output?.kind !== 'scalars' && op.name !== 'stats';
    input = `${assigns ? `${nextSlotName()} = ` : ''}${op.name}(${args.join(', ')})`;
    field?.focus();
  }

  function onKeydown(event) {
    if (event.key === 'Enter') { event.preventDefault(); submit(); return; }
    if (event.key === 'ArrowUp' && history.index > 0) {
      history.index -= 1;
      input = history.items[history.index];
      event.preventDefault();
    }
    if (event.key === 'ArrowDown') {
      history.index = Math.min(history.items.length, history.index + 1);
      input = history.items[history.index] ?? '';
      event.preventDefault();
    }
  }

  async function openImage() {
    const filePath = await lab.openImage();
    if (!filePath) return;
    // The Open button writes a command rather than loading directly, so a file
    // opened through the UI is in the log and replays like anything else.
    // quote() handles backslashes as well as quotes: a raw Windows path loses
    // every separator, since `\` is an escape character in the language.
    input = `${nextSlotName()} = load(${lab.quote(filePath)})`;
    await submit();
  }
</script>

<div class="command-pane">
  <div class="row">
    <button onclick={openImage} title="Insert a load() command for a file">Open Image…</button>
    <select
      value=""
      title="Insert a command template"
      onchange={(e) => { insertTemplate(e.currentTarget.value); e.currentTarget.value = ''; }}
    >
      <option value="">op…</option>
      {#each ops as op (op.name)}
        <option value={op.name} disabled={!op.implemented} title={op.help}>
          {op.implemented ? op.name : `${op.name} (no kernel)`}
        </option>
      {/each}
    </select>
    <input
      bind:this={field}
      bind:value={input}
      onkeydown={onKeydown}
      type="text"
      id="command"
      spellcheck="false"
      autocomplete="off"
      placeholder="A = pattern(kind=checker, width=512, height=512)"
    />
    <button id="run" onclick={submit} disabled={running}>Run</button>
  </div>
  <p class="hint">
    Up and Down walk the history. Every command — typed, or inserted from the
    menu — appends one entry to the log.
  </p>
</div>

<style>
  .command-pane {
    width: 100%;
    height: 100%;
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: 8px;
    box-sizing: border-box;
    overflow: auto;
    background: var(--cv-tile-bg, #101014);
    color: var(--cv-text, #d8d8e0);
    font: 12px ui-monospace, Menlo, Consolas, monospace;
  }

  .row { display: flex; gap: 6px; align-items: center; }

  input[type='text'] {
    flex: 1;
    min-width: 0;
    background: var(--cv-input, #0e0e12);
    border: 1px solid var(--cv-border, #2a2a33);
    border-radius: 3px;
    color: inherit;
    font: inherit;
    padding: 5px 7px;
  }
  input[type='text']:focus { outline: none; border-color: var(--cv-accent, #6ea8fe); }

  button, select {
    background: var(--cv-input, #0e0e12);
    border: 1px solid var(--cv-border, #2a2a33);
    border-radius: 3px;
    color: inherit;
    font: inherit;
    padding: 4px 8px;
    cursor: pointer;
  }
  button:hover:not(:disabled), select:hover { border-color: var(--cv-accent, #6ea8fe); }
  button:disabled { opacity: 0.5; cursor: default; }

  .hint { margin: 0; color: var(--cv-dim, #7c7c8a); }
</style>
