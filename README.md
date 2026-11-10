# gridcraft-web

Weekly automatic publication of [GridCraft](https://github.com/storytold/gridcraft) — the
open-source spreadsheet app written in pure Rust — as a WebAssembly build on **GitHub Pages**,
installable as a **PWA** and working **offline**.

- **Site:** https://sloth-os.github.io/gridcraft/
- **Upstream:** https://github.com/storytold/gridcraft

## How it works

Every Monday at 03:17 UTC (and on demand via *Run workflow*), [`.github/workflows/publish-web.yml`](.github/workflows/publish-web.yml)
— a leading **test** job runs the local PWA regression suite (`tests/run-local.sh`) and gates
everything else:

1. Checks out the latest `main` of `storytold/gridcraft` (an optional `gridcraft-ref` input
   pins a different ref for test runs) and records its version and commit SHA.
2. Builds `apps/gridcraft-web` with [trunk](https://trunkrs.dev/) **0.22.1 (pinned)** —
   `--release --locked`, wasm-opt, all asset URLs relative so the site works under the
   `/gridcraft/` project-pages prefix. `--locked` makes cargo honor upstream's committed
   `Cargo.lock` exactly (a lock needing updates fails the build instead of silently
   shipping different dependencies); `wasm-bindgen-cli` is installed at the exact version
   that lock pins.
3. Wraps the trunk output into a PWA:
   - `manifest.webmanifest` — app name, stable `id`, theme colour, 192px + 512px +
     maskable icons (`pwa/manifest.webmanifest`), version stamped into the description.
   - `sw.js` — a service worker that precaches **everything the offline app needs**: the
     app shell (index/offline/manifest/icons), the hashed `gridcraft-web-*.js` + `*_bg.wasm`
     bundle fetched with base64 SHA-256 SRI hashes, and every other file trunk emitted
     (the hashed favicon and the eframe snippet modules the bundle statically imports —
     a missing snippet would break the offline boot). Navigations are network-first with
     an offline fallback; all other assets are cache-first, always from the current build's
     cache first (stable names like `manifest.webmanifest` and `launch.js` change content
     between builds, so the retained previous cache must never shadow them). The build fails
     if any `@PLACEHOLDER@` survives substitution, and a post-deploy **verify** job
     smoke-tests the live site (wiring, stamp, SRI format, the file-handling manifest and
     `launch.js` content, the boot-signal DOM ids, and a `HEAD 200` for every precached file).
   - `launch.js` — the File Handling consumer that bridges OS file launches into the WASM
     app (see *Opening files from the OS* below); precached so file launches work offline.
   - `offline.html` — shown when the app itself isn't cached yet.
4. Deploys to GitHub Pages via `actions/configure-pages` + `actions/deploy-pages`.
5. Commits [`build-info.json`](build-info.json) back to this repo (see *Provenance and
   keepalive* below).

This repository contains **no gridcraft source code** — only the publishing workflow, the
PWA shell in `pwa/`, and the local test harness in `tests/`. Everything else is built fresh
from upstream every week.

## Offline behaviour and the update cycle

After the first full load (while online), everything the app needs is in CacheStorage and it
starts with or without a network. Each publish writes a byte-different `sw.js` (build stamp +
hashed asset names), which is how browsers discover the new build. The new worker installs in
the background and activates **once every tab of the old build is closed** — there is
deliberately no `skipWaiting`/`clientsClaim`, so an in-flight spreadsheet session is never
yanked, and `activate` keeps the previous build's cache so a stale `index.html` (GitHub Pages
serves `max-age=600`) still resolves its old hashed assets during the propagation window.
(Cache-first lookups try the current build's cache first, so the older copy can never shadow
a changed stable-name file like the manifest.)
Navigation fetches bypass the browser HTTP cache, so a reload after a deploy can never re-serve
a stale index pointing at deleted assets. The upstream app itself keeps user data in
`localStorage` / IndexedDB, which the service worker never touches.

## PWA install

Installable on desktop (Chrome/Edge: the install icon in the address bar) and Android
(WebAPK). iOS: *Share → Add to Home Screen*. The manifest uses upstream's icon artwork:
`icons/icon-512.png` as-is (`purpose: any`), `icons/icon-192.png` for the standard 192px
slot, and a full-bleed maskable variant for Android's circular launcher mask.

## Opening files from the OS (File Handling)

On desktop Chromium (Chrome/Edge on Linux, macOS, Windows, ChromeOS) the installed app
registers itself for spreadsheet files — the manifest's `file_handlers` covers exactly the
formats upstream's Linux `.desktop` file registers: **.xlsx, .xlsm, .xlsb, .ods, .csv,
.tsv**. Opening one of them "with GridCraft" launches the app and imports the file just
like drag-and-drop does:

- `launch_handler` is `focus-existing`: a file launch focuses an already-running GridCraft
  window and imports the file there as a new document — it never navigates or reloads, so
  an in-flight session is not yanked (the same philosophy as the service worker's update
  cycle).
- The WASM app can't see `window.launchQueue`, so `pwa/launch.js` is the bridge: it takes
  the OS-delivered `FileSystemFileHandle`s, waits for the app to finish booting, and hands
  the files to eframe as a synthesized `drop` event on the canvas — the app's existing
  drag-and-drop import path. The script is part of the precached app shell, so an offline
  launch works too.
- Where the File Handling API doesn't exist (Firefox, Safari, regular browser tabs) the
  script does nothing; browser users keep the in-app *File › Open* picker.
- The bridge waits for positive boot signals (`window.gridcraft`, or the loading overlay
  having been *seen and removed*) and only counts a delivery when eframe consumes the drop
  event — anything else retries until a 2-minute deadline, then fails loudly in the console.

Rollout caveats: the OS-side "Open with GridCraft" entries are registered by Chromium's
*silent manifest update* (on app launch and roughly daily), not at build time — right after
a deploy they may take a while to appear, and restarting the app nudges the refresh. A
GridCraft window that was already open before this feature shipped has no consumer yet and
silently swallows one launch; reloading that window once picks up the bridge. A real OS
launch cannot be automated in CI (the browser routes it outside the page); the manual smoke
test is: install the PWA, restart it, then *Open with → GridCraft* on a `.csv` and check it
imports as a new document (works offline too, after one online load).

## Provenance and keepalive

Each successful deploy commits [`build-info.json`](build-info.json) with the upstream
version, commit SHA, build timestamp, run URL and site URL — so the repo always records
what the live site was built from. That weekly push doubles as the cron **keepalive**:
GitHub automatically disables scheduled workflows in public repositories after 60 days
without repository activity, and this repo would otherwise never see a push. If the badge
ever goes stale (e.g. upstream broke the build for weeks and the schedule was disabled),
re-enable it under *Actions → Publish web (GitHub Pages) → … menu → Enable workflow*.

## Accepted risks

- **Unreviewed upstream:** the weekly schedule builds and publishes `storytold/gridcraft@main`
  with no review gate. A malicious or broken upstream commit would ship to the live site
  (the build job therefore runs with `contents: read` only; the Pages OIDC token is scoped
  to the deploy job).
- **No CSP:** the deployed page ships without a Content-Security-Policy. Adding one that
  allows the wasm bundle is possible but currently left to upstream's defaults.
- **No manifest screenshots:** Chrome's richer install prompt needs `screenshots`, which
  would require rendering the app during the build; only the basic install prompt shows.

## Running a build manually

*Actions → Publish web (GitHub Pages) → Run workflow.* Optionally set `gridcraft-ref`
(e.g. a tag or a PR head SHA) to build something other than `main`.

## Tests

`bash tests/run-local.sh` — offline regression test for the PWA shell, also run by the
workflow's gating **test** job on every publish. It extracts the
workflow's *real* assemble and verify scripts from the YAML (so tests can't drift from CI),
runs them against a fake trunk output, then exercises the generated `sw.js` in a
ServiceWorker mock (install precache set, activate cache rotation, current-cache preference
over the retained previous cache, network-first navigations, cache-first assets, scope
filtering) and `pwa/launch.js` in a DOM mock (File Handling consumer: overlay-gated cold
boot, warm launch via `window.gridcraft`, delivery retries until the drop is consumed,
fail-closed renamed overlay, pinned 120 s deadline, partial/non-file-handle skips,
concurrent launches). Both suites run under a real-time watchdog, so a hung promise fails
instead of looking like a pass. Needs `python3` (+PyYAML), `node`, `openssl`, `curl`; no
network access.

## Licence

The workflow and PWA shell in this repo are trivial glue. GridCraft itself is
`MIT OR Apache-2.0`; the published site bundles upstream's build (including its fonts and
artwork). `LICENSE-MIT`, `LICENSE-APACHE` and `NOTICE` in this repo are copies of
upstream's, which govern the distributed build — see also upstream's `ATTRIBUTION.md`.
