/* Exercise pwa/launch.js — the PWA File Handling consumer that bridges OS file launches into
 * the WASM app via a synthesized canvas 'drop' — against a mock window/document:
 *   1. no launchQueue (Firefox/Safari, unsupported browsers) → silent no-op, no crash
 *   2. a consumer is registered; empty params.files (a plain icon launch) delivers nothing
 *   3. cold boot: no drop while #gridcraft_loading is up; once it is removed, ONE
 *      DragEvent('drop') fires on the canvas with every file in a single DataTransfer
 *      (bubbles, cancelable), in order, and is consumed (eframe calls preventDefault, so
 *      dispatchEvent returns false — launch.js must treat THAT as success)
 *   4. warm launch (focus-existing into a booted window): window.gridcraft alone unlocks
 *      delivery — no overlay ever seen, no fake-clock tick needed
 *   5. runner startup gap: window.gridcraft exists but the canvas drop listener is not
 *      attached yet (dispatchEvent returns true = unconsumed) → retried until consumed
 *   6. fail-closed: overlay never seen (upstream renamed it) and no window.gridcraft →
 *      never drop onto a deaf canvas; loud deadline error instead
 *   7. stuck boot: no error before BOOT_TIMEOUT_MS (parsed from source, pinned ≥ 120s),
 *      deadline error after; the consumer promise resolves either way
 *   8. a handle whose getFile() rejects is logged by name and skipped; the rest are delivered
 *   9. a non-file handle (params.files is FileSystemHandle-typed) is logged and skipped
 *  10. two concurrent launches (second OS open during the first's boot wait) each deliver
 *      their own drop
 * Deterministic: all timers run on a fake clock. A real-time watchdog fails the run if a
 * consumer promise hangs — a silently-never-resolving consumer must not look like a pass.
 */
const fs = require('fs');
const vm = require('vm');
const assert = require('assert');

const watchdog = setTimeout(() => {
  console.error('FAIL: launch-test.js hung — a consumer promise never resolved (20s real-time watchdog)');
  process.exit(1);
}, 20000);

const launchPath = process.argv[2] || 'pwa/launch.js';
const code = fs.readFileSync(launchPath, 'utf8');

// Pin the boot deadline from the source: the timeout test derives its fake-time advances
// from this constant, and shrinking it would break cold offline boots (slow wasm init).
const BOOT_TIMEOUT_MS = Number(/const BOOT_TIMEOUT_MS = (\d+)/.exec(code)[1]);
assert.ok(BOOT_TIMEOUT_MS >= 120000, `BOOT_TIMEOUT_MS regressed below 120s: ${BOOT_TIMEOUT_MS}`);

class Clock {
  constructor() { this.now = 0; this.tasks = []; this.seq = 0; }
  setTimeout(fn, ms) { this.tasks.push({ at: this.now + (ms || 0), fn }); return ++this.seq; }
  // Run pending timers until limitMs of fake time has elapsed since this call; between
  // each, drain the microtask queue (setImmediate) so the consumer's awaits can advance.
  // Tasks scheduled beyond the limit stay queued for a later run() call.
  async run(limitMs = 1000000) {
    const start = this.now;
    for (;;) {
      this.tasks.sort((a, b) => a.at - b.at);
      const next = this.tasks[0];
      if (!next || next.at - start > limitMs) return;
      this.tasks.shift();
      this.now = next.at;
      next.fn();
      await new Promise((r) => setImmediate(r));
    }
  }
}

class MockFile {
  constructor(name, type) { this.name = name; this.type = type || ''; }
}

class MockDataTransfer {
  constructor() { this.files = []; this.items = { add: (f) => this.files.push(f) }; }
}

class MockDragEvent {
  constructor(type, init = {}) {
    this.type = type;
    this.dataTransfer = init.dataTransfer;
    this.bubbles = !!init.bubbles;
    this.cancelable = !!init.cancelable;
  }
}

function makeEnv({ withLaunchQueue = true, overlay = true, gridcraft = false, consumed = true } = {}) {
  const clock = new Clock();
  const errors = [];
  const infos = [];
  const drops = [];
  const state = { consumed };
  const canvas = {
    id: 'gridcraft_canvas',
    // Faithful browser semantics: dispatchEvent returns FALSE when a listener called
    // preventDefault() — eframe's canvas drop handler does, so "consumed" means the
    // dispatch came back false and launch.js's deliver() flips it into success.
    dispatchEvent: (ev) => { drops.push(ev); return !state.consumed; },
  };
  const els = { gridcraft_canvas: canvas };
  if (overlay) els.gridcraft_loading = { id: 'gridcraft_loading' };
  const window = {};
  if (gridcraft) window.gridcraft = { request: async () => {} };
  if (withLaunchQueue) window.launchQueue = { setConsumer: (fn) => { window.__consumer = fn; } };
  const sandbox = {
    window,
    document: {
      getElementById: (id) => els[id] || null,
      querySelector: (sel) => (sel === 'canvas' ? canvas : null),
    },
    console: { error: (...a) => errors.push(a.join(' ')), info: (...a) => infos.push(a.join(' ')) },
    setTimeout: (fn, ms) => clock.setTimeout(fn, ms),
    Date: { now: () => clock.now },
    DataTransfer: MockDataTransfer,
    DragEvent: MockDragEvent,
    Promise,
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox, { filename: launchPath });
  return {
    clock, drops, errors, infos, state,
    consumer: window.__consumer,
    removeLoading: () => { delete els.gridcraft_loading; },
  };
}

const handleFor = (file, { fail = false } = {}) => ({
  kind: 'file',
  name: file.name,
  getFile: async () => {
    if (fail) throw new Error('NotFoundError: the file moved');
    return file;
  },
});

const drain = async (n = 6) => { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)); };

(async () => {
  // --- 1. no launchQueue → no-op ---------------------------------------------------------
  {
    const env = makeEnv({ withLaunchQueue: false });
    assert.strictEqual(env.consumer, undefined, 'no consumer without launchQueue');
    console.log('no launchQueue: silent no-op OK');
  }

  // --- 2. consumer registered; plain launches deliver nothing -----------------------------
  {
    const env = makeEnv();
    assert.strictEqual(typeof env.consumer, 'function', 'consumer registered via setConsumer');
    await env.consumer({ files: [] });
    await env.consumer({});
    await drain();
    assert.strictEqual(env.drops.length, 0, 'empty launch params: no drop');
    assert.strictEqual(env.errors.length, 0, 'empty launch params: no error');
    console.log('empty launch params: no drop, no error OK');
  }

  // --- 3. cold boot: overlay-gated wait, then ONE multi-file drop ---------------------------
  {
    const env = makeEnv();
    const a = new MockFile('budget.xlsx');
    const b = new MockFile('notes.csv', 'text/csv');
    const p = env.consumer({ files: [handleFor(a), handleFor(b)] });
    await drain();
    await env.clock.run(1000); // ~5 polls while the loading overlay is still up
    assert.strictEqual(env.drops.length, 0, 'no drop while #gridcraft_loading is present');
    env.removeLoading(); // the app finished booting (web.rs removes the overlay after start Ok)
    await env.clock.run(1000);
    await p;
    assert.strictEqual(env.drops.length, 1, 'exactly one drop after boot');
    const ev = env.drops[0];
    assert.strictEqual(ev.type, 'drop');
    assert.strictEqual(ev.bubbles, true, 'drop bubbles');
    assert.strictEqual(ev.cancelable, true, 'drop cancelable');
    assert.deepStrictEqual(
      ev.dataTransfer.files.map((f) => f.name),
      ['budget.xlsx', 'notes.csv'],
      'all files in one DataTransfer, in order',
    );
    assert.ok(env.infos.some((s) => s.includes('budget.xlsx')), 'success logged');
    assert.strictEqual(env.errors.length, 0, 'clean delivery logs no error');
    console.log('cold boot: overlay-gated wait + single multi-file canvas drop OK');
  }

  // --- 4. warm launch: window.gridcraft alone unlocks delivery ------------------------------
  {
    const env = makeEnv({ overlay: false, gridcraft: true }); // focus-existing into a booted window
    const p = env.consumer({ files: [handleFor(new MockFile('warm.csv'))] });
    await drain(); // no fake-clock advance needed: the first loop iteration delivers
    await p;
    assert.strictEqual(env.drops.length, 1, 'warm launch delivers immediately');
    assert.deepStrictEqual(env.drops[0].dataTransfer.files.map((f) => f.name), ['warm.csv']);
    assert.strictEqual(env.errors.length, 0);
    console.log('warm launch via window.gridcraft: immediate delivery, no overlay needed OK');
  }

  // --- 5. runner startup gap: gridcraft up, drop listener not yet → retry until consumed -----
  {
    const env = makeEnv({ overlay: false, gridcraft: true, consumed: false });
    const p = env.consumer({ files: [handleFor(new MockFile('gap.csv'))] });
    await drain();
    await env.clock.run(1000);
    assert.ok(env.drops.length >= 2, `unconsumed drops are retried (got ${env.drops.length})`);
    assert.strictEqual(env.infos.length, 0, 'nothing logged as delivered while unconsumed');
    assert.strictEqual(env.errors.length, 0, 'retrying is not an error');
    env.state.consumed = true; // eframe finished attaching its canvas drop listener
    await env.clock.run(1000);
    await p;
    assert.ok(env.infos.some((s) => s.includes('gap.csv')), 'delivered once consumed');
    assert.strictEqual(env.errors.length, 0, 'no deadline error after a successful retry');
    console.log('runner startup gap: unconsumed drop retried until eframe listens OK');
  }

  // --- 6. fail-closed: overlay never seen, no gridcraft → never drop early --------------------
  {
    const env = makeEnv({ overlay: false }); // e.g. upstream renamed #gridcraft_loading
    const p = env.consumer({ files: [handleFor(new MockFile('renamed.csv'))] });
    await drain();
    await env.clock.run(5000);
    assert.strictEqual(env.drops.length, 0, 'a missing overlay alone must NOT unlock delivery');
    await env.clock.run(BOOT_TIMEOUT_MS + 1000);
    await p;
    assert.strictEqual(env.drops.length, 0, 'fail-closed: no drop onto an unverified boot');
    assert.ok(env.errors.some((s) => s.includes('did not accept')), 'deadline error logged');
    console.log('fail-closed on renamed overlay: no early drop, loud deadline error OK');
  }

  // --- 7. stuck boot pins the deadline ----------------------------------------------------------
  {
    const env = makeEnv(); // overlay stays up forever (boot hung)
    const p = env.consumer({ files: [handleFor(new MockFile('x.csv'))] });
    await drain(); // let the consumer reach its poll loop so timers are queued
    await env.clock.run(BOOT_TIMEOUT_MS - 1000);
    assert.strictEqual(env.errors.length, 0, `no error before BOOT_TIMEOUT_MS (${BOOT_TIMEOUT_MS}ms)`);
    assert.strictEqual(env.drops.length, 0, 'no drop while the overlay is up');
    await env.clock.run(2000);
    await p;
    assert.strictEqual(env.drops.length, 0, 'timed-out boot: no drop');
    assert.ok(
      env.errors.some((s) =>
        s.includes('did not accept') && s.includes(String(BOOT_TIMEOUT_MS)) && s.includes('x.csv')),
      'deadline error names the timeout and the file',
    );
    console.log(`stuck boot: deadline is exactly BOOT_TIMEOUT_MS=${BOOT_TIMEOUT_MS}ms, consumer resolves OK`);
  }

  // --- 8. failing handle skipped, the rest delivered ----------------------------------------------
  {
    const env = makeEnv({ overlay: false, gridcraft: true });
    const good = new MockFile('good.csv');
    const p = env.consumer({
      files: [handleFor(new MockFile('gone.csv'), { fail: true }), handleFor(good)],
    });
    await drain();
    await p;
    assert.strictEqual(env.drops.length, 1);
    assert.deepStrictEqual(env.drops[0].dataTransfer.files.map((f) => f.name), ['good.csv']);
    assert.ok(env.errors.some((s) => s.includes('gone.csv')), 'unreadable handle logged by name');
    console.log('partial getFile failure: skipped + logged, rest delivered OK');
  }

  // --- 9. non-file handle skipped, the rest delivered ----------------------------------------------
  {
    const env = makeEnv({ overlay: false, gridcraft: true });
    const dir = { kind: 'directory', name: 'somedir' }; // params.files is FileSystemHandle-typed
    const p = env.consumer({ files: [dir, handleFor(new MockFile('sheet.ods'))] });
    await drain();
    await p;
    assert.strictEqual(env.drops.length, 1);
    assert.deepStrictEqual(env.drops[0].dataTransfer.files.map((f) => f.name), ['sheet.ods']);
    assert.ok(
      env.errors.some((s) => s.includes('not a file handle') && s.includes('somedir')),
      'non-file handle logged and skipped',
    );
    console.log('non-file handle: skipped + logged, rest delivered OK');
  }

  // --- 10. two concurrent launches each deliver their own drop ---------------------------------------
  {
    const env = makeEnv();
    const p1 = env.consumer({ files: [handleFor(new MockFile('first.csv'))] });
    await drain();
    await env.clock.run(600);
    const p2 = env.consumer({ files: [handleFor(new MockFile('second.xlsx'))] }); // OS relaunch mid-boot
    await drain();
    await env.clock.run(600);
    assert.strictEqual(env.drops.length, 0, 'both invocations wait for the overlay');
    env.removeLoading();
    await env.clock.run(1000);
    await Promise.all([p1, p2]);
    assert.strictEqual(env.drops.length, 2, 'each concurrent launch delivers its own drop');
    assert.deepStrictEqual(
      env.drops.map((d) => d.dataTransfer.files.map((f) => f.name).join(',')),
      ['first.csv', 'second.xlsx'],
      'each drop carries its own files',
    );
    console.log('concurrent launches: independent deliveries OK');
  }

  clearTimeout(watchdog);
  console.log('\nALL LAUNCH.JS TESTS PASSED');
})().catch((err) => { clearTimeout(watchdog); console.error('FAIL:', err); process.exit(1); });
