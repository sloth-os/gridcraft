# gridcraft-web

Weekly automatic publication of [GridCraft](https://github.com/storytold/gridcraft) — the
open-source spreadsheet app written in pure Rust — as a WebAssembly build on **GitHub Pages**,
installable as a **PWA** and working **offline**.

- **Site:** https://sloth-os.github.io/gridcraft/
- **Upstream:** https://github.com/storytold/gridcraft

## How it works

Every Monday at 03:17 UTC (and on demand via *Run workflow*), [`.github/workflows/publish-web.yml`](.github/workflows/publish-web.yml):

1. Checks out the latest `main` of `storytold/gridcraft` (an optional `gridcraft-ref` input
   pins a different ref for test runs).
2. Builds `apps/gridcraft-web` with [trunk](https://trunkrs.dev/) (`--release`, wasm-opt, all
   asset URLs relative so the site works under the `/gridcraft/` project-pages prefix).
3. Wraps the trunk output into a PWA:
   - `manifest.webmanifest` — app name, theme colour, icons (`pwa/manifest.webmanifest`)
   - `sw.js` — a service worker that precaches `index.html`, the hashed `gridcraft-web-*.js`
     and `*_bg.wasm` bundle (with SHA-256 integrity hashes), and the icons. Navigations are
     network-first with an offline fallback; hashed assets are cache-first. Each publish
     writes a byte-different `sw.js`, which is how browsers discover the new build.
   - `offline.html` — shown when the app itself isn't cached yet.
4. Deploys to GitHub Pages via `actions/configure-pages` + `actions/deploy-pages`.

This repository contains **no gridcraft source code** — only the publishing workflow and the
PWA shell in `pwa/`. Everything else is built fresh from upstream every week.

## Offline behaviour

After the first full load (while online), the app is cached by the service worker and starts
with or without a network. The weekly build takes over on the next visit: `index.html` is
always fetched network-first, the new `sw.js` activates immediately (`skipWaiting` +
`clientsClaim`), and old caches are dropped. The upstream app itself keeps user data in
`localStorage` / IndexedDB, which the service worker never touches.

## PWA install

Installable on desktop (Chrome/Edge: the install icon in the address bar) and Android
(WebAPK). iOS: *Share → Add to Home Screen*. The manifest uses upstream's icon artwork:
`icons/icon-512.png` as-is (`purpose: any`) and a full-bleed maskable variant for Android's
circular launcher mask.

## Running a build manually

*Actions → Publish web (GitHub Pages) → Run workflow.* Optionally set `gridcraft-ref`
(e.g. a tag or a PR head SHA) to build something other than `main`.

## Licence

The workflow and PWA shell in this repo are trivial glue. GridCraft itself is
`MIT OR Apache-2.0` — see the upstream repository.
