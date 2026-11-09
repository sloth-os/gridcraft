# gridcraft-web

Weekly automatic publication of [GridCraft](https://github.com/storytold/gridcraft) — the
open-source spreadsheet app written in pure Rust — as a WebAssembly build on **GitHub Pages**,
installable as a **PWA** and working **offline**.

- **Site:** https://sloth-os.github.io/gridcraft/
- **Upstream:** https://github.com/storytold/gridcraft

## How it works

Every Monday at 03:17 UTC (and on demand via *Run workflow*), [`.github/workflows/publish-web.yml`](.github/workflows/publish-web.yml):

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
     an offline fallback; all other assets are cache-first. The build fails if any
     `@PLACEHOLDER@` survives substitution, and a post-deploy **verify** job smoke-tests
     the live site (wiring, stamp, SRI format, and a `HEAD 200` for every precached file).
   - `offline.html` — shown when the app itself isn't cached yet.
4. Deploys to GitHub Pages via `actions/configure-pages` + `actions/deploy-pages`.
5. Commits [`build-info.json`](build-info.json) back to this repo (see *Provenance and
   keepalive* below).

This repository contains **no gridcraft source code** — only the publishing workflow and the
PWA shell in `pwa/`. Everything else is built fresh from upstream every week.

## Offline behaviour and the update cycle

After the first full load (while online), everything the app needs is in CacheStorage and it
starts with or without a network. Each publish writes a byte-different `sw.js` (build stamp +
hashed asset names), which is how browsers discover the new build. The new worker installs in
the background and activates **once every tab of the old build is closed** — there is
deliberately no `skipWaiting`/`clientsClaim`, so an in-flight spreadsheet session is never
yanked, and `activate` keeps the previous build's cache so a stale `index.html` (GitHub Pages
serves `max-age=600`) still resolves its old hashed assets during the propagation window.
Navigation fetches bypass the browser HTTP cache, so a reload after a deploy can never re-serve
a stale index pointing at deleted assets. The upstream app itself keeps user data in
`localStorage` / IndexedDB, which the service worker never touches.

## PWA install

Installable on desktop (Chrome/Edge: the install icon in the address bar) and Android
(WebAPK). iOS: *Share → Add to Home Screen*. The manifest uses upstream's icon artwork:
`icons/icon-512.png` as-is (`purpose: any`), `icons/icon-192.png` for the standard 192px
slot, and a full-bleed maskable variant for Android's circular launcher mask.

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

## Licence

The workflow and PWA shell in this repo are trivial glue. GridCraft itself is
`MIT OR Apache-2.0`; the published site bundles upstream's build (including its fonts and
artwork). `LICENSE-MIT`, `LICENSE-APACHE` and `NOTICE` in this repo are copies of
upstream's, which govern the distributed build — see also upstream's `ATTRIBUTION.md`.
