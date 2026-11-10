/* GridCraft PWA — File Handling ("Open with" from the OS).
 *
 * The manifest's file_handlers make Chromium launch the installed app when the user opens a
 * spreadsheet (.xlsx/.xlsm/.xlsb/.ods/.csv/.tsv) from the OS, and deliver the picked files to
 * the page as FileSystemFileHandles on window.launchQueue. The WASM app can't see launchQueue,
 * so this script is the bridge: it waits for the app to boot, then hands the files over exactly
 * the way a user drag-and-drop would — eframe listens for 'drop' on the canvas and turns
 * dataTransfer.files into (name, bytes) imports (upstream apps/gridcraft-web web.rs → Inbox).
 *
 * This file is part of the precached app shell (sw.js APP_SHELL), so an OS file launch also
 * works offline. Keep it dependency-free and tiny.
 */
(() => {
  'use strict';
  if (
    typeof window === 'undefined' ||
    !window.launchQueue ||
    typeof window.launchQueue.setConsumer !== 'function'
  ) {
    return; // No File Handling API (Firefox/Safari, old browsers): nothing to do.
  }

  const CANVAS_ID = 'gridcraft_canvas';
  const LOADING_ID = 'gridcraft_loading';
  const BOOT_TIMEOUT_MS = 120000; // a cold offline boot loads a big wasm bundle from cache
  const POLL_MS = 200;

  const canvas = () => document.getElementById(CANVAS_ID) || document.querySelector('canvas');
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  // Positive boot signals — never trust a missing element alone:
  //  - window.gridcraft: the app's page API, installed while the eframe runner starts
  //    (upstream apps/gridcraft-web api.rs). The canvas 'drop' listener is attached moments
  //    later in the same startup; deliver() verifies consumption and the loop retries, so
  //    that gap cannot lose a file.
  //  - the #gridcraft_loading overlay was SEEN and is now gone: web.rs removes it only after
  //    the runner started OK. Requiring the sighting fails closed (deadline + loud error) if
  //    upstream ever renames the overlay, instead of dropping files onto a deaf canvas.
  function makeReadyCheck() {
    let sawLoading = false;
    return () => {
      if (window.gridcraft) return true;
      const loading = document.getElementById(LOADING_ID);
      if (loading) {
        sawLoading = true;
        return false;
      }
      return sawLoading;
    };
  }

  // Replay a user drag-and-drop: one 'drop' on the canvas carrying all the files. Returns
  // true only when a listener CONSUMED the event: eframe's canvas drop handler ends with
  // preventDefault() and the event is cancelable, so dispatchEvent() returning false is the
  // "eframe took it" signal (a coupling to eframe internals, but a false negative only costs
  // a retry, and true silence becomes a loud deadline error instead of a lost file).
  function deliver(files) {
    const target = canvas();
    if (!target) return false;
    const dt = new DataTransfer();
    for (const file of files) dt.items.add(file);
    return !target.dispatchEvent(
      new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }),
    );
  }

  window.launchQueue.setConsumer(async (params) => {
    // Chromium discards a rejected promise from the consumer (its IDL returns void — the
    // failure would surface only as an unhandledrejection), so catch everything here.
    try {
      // The consumer fires for EVERY launch of the app; only file launches carry handles.
      const handles = (params && params.files) || [];
      if (!handles.length) return;
      const files = [];
      for (const handle of handles) {
        // params.files is typed as FileSystemHandle; file launches deliver file handles.
        if (!handle || typeof handle.getFile !== 'function') {
          console.error('GridCraft: launched entry is not a file handle', handle && handle.name);
          continue;
        }
        try {
          files.push(await handle.getFile());
        } catch (err) {
          console.error('GridCraft: cannot read launched file', handle && handle.name, err);
        }
      }
      if (!files.length) return;

      const ready = makeReadyCheck();
      const deadline = Date.now() + BOOT_TIMEOUT_MS;
      let delivered = false;
      while (Date.now() <= deadline) {
        if (ready() && canvas()) {
          try {
            if (deliver(files)) {
              delivered = true;
              break;
            }
          } catch (err) {
            console.error('GridCraft: cannot hand launched files to the app', err);
          }
        }
        await sleep(POLL_MS);
      }
      if (delivered) {
        console.info('GridCraft: opened from the OS:', files.map((f) => f.name).join(', '));
      } else {
        console.error(
          'GridCraft: the app did not accept the launched files within',
          BOOT_TIMEOUT_MS,
          'ms:',
          files.map((f) => f.name).join(', '),
        );
      }
    } catch (err) {
      console.error('GridCraft: file-handling consumer failed', err);
    }
  });
})();
