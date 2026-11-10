/* Exercise the generated service worker (publish/sw.js) against a faithful mock of the
 * ServiceWorker globals: CacheStorage, fetch, clients, registration. Verifies:
 *   1. install: precaches app shell + icons + launch.js + extras (snippets/ico) + SRI-checked
 *      bundle; skipWaiting deliberately NOT called
 *   2. activate: keeps current + previous gridcraft-cache-* (sortable names), deletes older
 *      and legacy-format caches; clients.claim deliberately NOT called
 *   2b. cache-first prefers the CURRENT cache over the retained previous one for stable
 *      names (manifest/launch.js change content between builds); the cross-cache fallback
 *      still resolves old hashed assets that only the previous cache holds
 *   3. fetch navigate: network-first bypassing HTTP cache; caches ONLY ok+basic responses
 *      for the shell URL under './index.html'; non-shell and non-OK navigations never
 *      overwrite it; offline falls back to cached shell
 *   4. fetch assets: cache-first, no network hit for cached entries
 *   5. scope filtering: out-of-scope/cross-origin/non-GET/sw.js pass through untouched
 *   6. uncached asset offline → 503
 * The expected constants (CACHE, JS, WASM, PRECACHE_EXTRA) are parsed out of the generated
 * file so this test works with whatever names the build produced.
 */
const fs = require('fs');
const vm = require('vm');
const assert = require('assert');

const watchdog = setTimeout(() => {
  console.error('FAIL: sw-test.js hung — a service worker promise never resolved (20s real-time watchdog)');
  process.exit(1);
}, 20000);

const swPath = process.argv[2];
const code = fs.readFileSync(swPath, 'utf8');

const SCOPE = 'https://sloth-os.github.io/gridcraft/';

// --- parse expectations from the generated file ----------------------------------
const CACHE = /const CACHE = '([^']+)'/.exec(code)[1];
const JS = /const JS = '\.\/([^']+)'/.exec(code)[1];
const WASM = /const WASM = '\.\/([^']+)'/.exec(code)[1];
const EXTRA = [.../const PRECACHE_EXTRA = \[([^\]]*)\]/.exec(code)[1].matchAll(/'\.\/([^']+)'/g)].map((m) => m[1]);
const SHELL = [.../const APP_SHELL = \[([\s\S]*?)\];/.exec(code)[1].matchAll(/'(\.\/[^']*)'/g)].map((m) => m[1]);
const VERSION = /const VERSION = '([^']+)'/.exec(code)[1];
assert.ok(!/@[A-Z_]+@/.test(code), 'no unsubstituted placeholder in generated sw.js');
assert.match(VERSION, /^gridcraft-\d+\.\d+\.\d+\+\d{4}-\d{2}-\d{2}T[\d:]+Z \([0-9a-f]+\)$/, 'VERSION stamp shape');
assert.match(CACHE, /^gridcraft-cache-\d{4}-\d{2}-\d{2}T[\d:]+Z$/, 'sortable CACHE name');
// The shell must hold everything an offline (or OS file-launch) cold start needs — including
// launch.js, the File Handling consumer the injected <script src> tag loads.
for (const s of [
  './', './index.html', './offline.html', './manifest.webmanifest', './launch.js',
  './icons/icon-192.png', './icons/icon-512.png', './icons/icon-512-maskable.png',
]) {
  assert(SHELL.includes(s), `APP_SHELL must precache ${s}`);
}
console.log(`parsed: CACHE=${CACHE} JS=${JS} WASM=${WASM} SHELL=${SHELL.length} EXTRA=[${EXTRA}]`);

const normalize = (u) => {
  if (typeof u === 'string') return new URL(u, SCOPE).href;
  if (u && u.url) return u.url;
  return String(u);
};

class FakeResponse {
  constructor(body, opts = {}) {
    this.body = body;
    this.status = opts.status || 200;
    this.ok = this.status >= 200 && this.status < 300;
    this.type = opts.type || 'basic';
    this.url = opts.url || '';
  }
  clone() { return new FakeResponse(this.body, { status: this.status, type: this.type, url: this.url }); }
}

class FakeCache {
  constructor() { this.map = new Map(); }
  async put(url, resp) { this.map.set(normalize(url), resp); }
  async match(url) { return this.map.get(normalize(url)) || null; }
  async add(req) {
    const url = normalize(req);
    const resp = await globalThis.__fetch(req);
    if (!resp.ok) throw new TypeError(`fetch failed ${url} ${resp.status}`);
    await this.put(url, resp);
  }
}

class FakeRequest {
  constructor(input, opts = {}) {
    const base = input instanceof FakeRequest ? input.url : input;
    this.url = new URL(base, SCOPE).href;
    this.method = (input instanceof FakeRequest ? input.method : opts.method) || 'GET';
    this.mode = (input instanceof FakeRequest && !opts.mode ? input.mode : opts.mode) || 'navigate';
    this.cache = opts.cache || (input instanceof FakeRequest ? input.cache : undefined);
  }
}

const caches = {
  store: new Map(),
  async open(name) { if (!this.store.has(name)) this.store.set(name, new FakeCache()); return this.store.get(name); },
  async keys() { return [...this.store.keys()]; },
  async delete(name) { return this.store.delete(name); },
  async match(url) { for (const c of this.store.values()) { const r = await c.match(url); if (r) return r; } return null; },
};

let networkUp = true;
const networkFail = new Set();   // urls that throw (offline)
const network404 = new Set();    // urls that return 404
let fetched = [];
globalThis.__fetch = async (req) => {
  const url = normalize(req);
  fetched.push({ url, cache: req.cache });
  if (!networkUp || networkFail.has(url)) throw new TypeError('offline');
  if (network404.has(url)) return new FakeResponse('404 body', { status: 404, url });
  return new FakeResponse('net:' + url, { url });
};
const fetchMock = (req) => globalThis.__fetch(req);

const listeners = {};
const swSelf = {
  location: new URL(SCOPE + 'sw.js'),
  registration: { scope: SCOPE },
  skipWaiting: async () => { swSelf.__skipWaiting = true; },
  clients: { claim: async () => { swSelf.__claimed = true; } },
  addEventListener: (ev, fn) => { (listeners[ev] = listeners[ev] || []).push(fn); },
};

const sandbox = {
  caches, fetch: fetchMock, Request: FakeRequest, Response: FakeResponse, URL,
  self: swSelf, console, Promise, setTimeout,
};
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(code, sandbox, { filename: swPath });

const fire = async (ev, event) => { for (const fn of listeners[ev] || []) await fn(event); };
const makeEvent = (req) => {
  const event = {
    request: req,
    respondWith: (p) => { event.__response = p; },
    waitUntil: (p) => { event.__waited = p; return p; },
  };
  return event;
};
const reqOf = (url, mode, method) => new FakeRequest(url, { mode, method });

(async () => {
  // --- 1. install ---------------------------------------------------------------
  networkUp = true;
  const ev1 = makeEvent();
  await fire('install', ev1);
  await ev1.__waited;

  const names = await caches.keys();
  assert.deepStrictEqual(names, [CACHE], `exactly one cache after install: ${names}`);
  const cache = await caches.open(CACHE);
  const expected = [...SHELL, ...EXTRA.map((e) => './' + e), `./${JS}`, `./${WASM}`];
  for (const s of expected) assert(await cache.match(s), `precached: ${s}`);
  assert.strictEqual(cache.map.size, expected.length, `no extra entries (${cache.map.size} vs ${expected.length})`);
  assert.ok(!swSelf.__skipWaiting, 'skipWaiting NOT called (updates wait for tabs to close)');
  // navigate fetches during install used cache:'reload' for the bundle
  const jsFetch = fetched.find((f) => f.url.endsWith(JS));
  assert.strictEqual(jsFetch.cache, 'reload', 'bundle fetched with cache:reload');
  console.log(`install: ${expected.length} entries precached (${SHELL.length} shell incl. launch.js + ${EXTRA.length} extras + bundle), no skipWaiting OK`);

  // --- 2. activate: keep current + previous only --------------------------------
  await caches.open('gridcraft-cache-2020-01-01T00:00:00Z');   // old
  await caches.open('gridcraft-cache-2026-11-03T00:00:00Z');   // previous
  await caches.open('gridcraft-0.16.0+ (252c815c327d)');       // legacy format orphan
  const ev2 = makeEvent();
  await fire('activate', ev2);
  await ev2.__waited;
  const after = (await caches.keys()).sort();
  assert.deepStrictEqual(after, ['gridcraft-cache-2026-11-03T00:00:00Z', CACHE].sort(),
    `kept previous+current, deleted old+legacy, got: ${after}`);
  assert.ok(!swSelf.__claimed, 'clients.claim NOT called');
  console.log('activate: keeps current+previous, drops old+legacy, no claim OK');

  // --- 2b. cache-first must prefer the CURRENT cache over the retained previous one -------
  // Stable-name shell files (manifest.webmanifest, launch.js) change content between builds.
  // CacheStorage.match() searches caches in creation order and the previous build's cache was
  // created FIRST in a real browser — a bare cross-cache match would therefore serve the OLD
  // copy one build late (this exact shadowing hid a file_handlers-less manifest from
  // Chromium's silent manifest refresh). The cross-cache fallback must still resolve assets
  // that only the previous cache holds (a stale index.html during the propagation window).
  {
    const PREV = 'gridcraft-cache-2026-11-03T00:00:00Z';
    const prev = await caches.open(PREV);
    await prev.put(SCOPE + 'manifest.webmanifest', new FakeResponse('MANIFEST-V1'));
    await prev.put(SCOPE + 'launch.js', new FakeResponse('LAUNCH-V1'));
    await prev.put(SCOPE + 'old-hash-only.js', new FakeResponse('OLD-ASSET'));
    await cache.put(SCOPE + 'manifest.webmanifest', new FakeResponse('MANIFEST-V2'));
    await cache.put(SCOPE + 'launch.js', new FakeResponse('LAUNCH-V2'));
    // Faithful creation order: in the browser the previous build's cache was opened first.
    caches.store.delete(PREV);
    caches.store.delete(CACHE);
    caches.store.set(PREV, prev);
    caches.store.set(CACHE, cache);

    fetched = [];
    for (const [name, want] of [['manifest.webmanifest', 'MANIFEST-V2'], ['launch.js', 'LAUNCH-V2']]) {
      const e = makeEvent(reqOf(SCOPE + name, 'no-cors'));
      await fire('fetch', e);
      const r = await e.__response;
      assert.strictEqual(r.body, want, `${name} served from the CURRENT cache, not the previous`);
    }
    const eOld = makeEvent(reqOf(SCOPE + 'old-hash-only.js', 'no-cors'));
    await fire('fetch', eOld);
    const rOld = await eOld.__response;
    assert.strictEqual(rOld.body, 'OLD-ASSET', 'previous-cache fallback still resolves old assets');
    assert.strictEqual(fetched.length, 0, 'no network for any cache hit');
    console.log('fetch preference: current cache wins for stable names, previous-cache fallback OK');
  }

  // --- 3. fetch: navigation network-first, bypasses HTTP cache -------------------
  fetched = [];
  let ev = makeEvent(reqOf(SCOPE, 'navigate'));
  await fire('fetch', ev);
  let resp = await ev.__response;
  assert(resp && resp.body === 'net:' + SCOPE, 'navigate served from network when online');
  const navFetch = fetched.find((f) => f.url === SCOPE);
  assert.strictEqual(navFetch.cache, 'reload', 'navigate fetched with cache:reload (stale index never re-served)');
  const cachedIndex = await cache.match('./index.html');
  assert.strictEqual(cachedIndex.body, 'net:' + SCOPE, 'fresh shell cached under ./index.html');
  console.log('fetch navigate online: network-first via cache:reload, shell cached OK');

  // --- 4. non-shell navigation must NOT overwrite the cached index ----------------
  ev = makeEvent(reqOf(SCOPE + 'some/other/page', 'navigate'));
  await fire('fetch', ev);
  resp = await ev.__response;
  assert(resp && resp.ok, 'non-shell navigation served');
  assert.strictEqual((await cache.match('./index.html')).body, 'net:' + SCOPE,
    'non-shell navigation did not poison ./index.html');
  console.log('fetch navigate non-shell: index cache untouched OK');

  // --- 5. non-OK navigation (404) must NOT be cached ------------------------------
  network404.add(SCOPE + 'missing');
  ev = makeEvent(reqOf(SCOPE + 'missing', 'navigate'));
  await fire('fetch', ev);
  resp = await ev.__response;
  assert.strictEqual(resp.status, 404, '404 passed through');
  assert.strictEqual((await cache.match('./index.html')).body, 'net:' + SCOPE,
    '404 body not cached as shell');
  console.log('fetch navigate 404: passed through, shell not poisoned OK');

  // --- 6. offline navigation falls back to cached shell ---------------------------
  networkUp = false;
  ev = makeEvent(reqOf(SCOPE, 'navigate'));
  await fire('fetch', ev);
  resp = await ev.__response;
  assert(resp && resp.body.startsWith('net:'), 'offline navigate falls back to cached shell');
  console.log('fetch navigate offline: cached shell OK');

  // --- 7. hashed asset + snippet cache-first (no network hit) ---------------------
  fetched = [];
  networkUp = true; // even online, a cached asset must not touch the network
  for (const p of [JS, EXTRA[0]]) {
    ev = makeEvent(reqOf(SCOPE + p, 'no-cors'));
    await fire('fetch', ev);
    resp = await ev.__response;
    assert(resp && resp.body.includes(p), `asset served from cache: ${p}`);
  }
  assert.strictEqual(fetched.length, 0, 'zero network fetches for cached assets');
  console.log('fetch assets: cache-first (bundle + snippet), zero network OK');

  // --- 8. passthrough: non-GET, cross-origin, out-of-scope, sw.js ------------------
  for (const [req, label] of [
    [reqOf(SCOPE + 'x', undefined, 'POST'), 'non-GET'],
    [reqOf('https://evil.example/gridcraft/x'), 'cross-origin'],
    [reqOf('https://sloth-os.github.io/other/x'), 'out-of-scope'],
    [reqOf(SCOPE + 'sw.js'), 'sw.js itself'],
  ]) {
    const e = makeEvent(req);
    await fire('fetch', e);
    assert(!e.__response, `${label} not intercepted`);
  }
  console.log('fetch passthrough: non-GET / cross-origin / out-of-scope / sw.js OK');

  // --- 9. offline asset not in any cache → 503 -------------------------------------
  networkUp = false;
  const e = makeEvent(reqOf(SCOPE + 'never-cached.png', 'no-cors'));
  await fire('fetch', e);
  resp = await e.__response;
  assert(resp && resp.status === 503, 'uncached asset offline → 503');
  console.log('fetch uncached offline: 503 OK');

  clearTimeout(watchdog);
  console.log('\nALL SERVICE WORKER TESTS PASSED');
})().catch((err) => { clearTimeout(watchdog); console.error('FAIL:', err.message); process.exit(1); });
