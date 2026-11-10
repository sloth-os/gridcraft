#!/usr/bin/env bash
# Local regression test for the PWA shell — no network access needed.
#
# Runs the workflow's REAL "Assemble the PWA site" and verify smoke-test scripts
# (extracted from the YAML, so the test can't drift from CI) against a faithful
# fake trunk output, then exercises the generated sw.js in a ServiceWorker mock
# (tests/sw-test.js, plain node — install/activate/fetch semantics).
#
# Usage:  bash tests/run-local.sh
# Needs:  bash, python3 (+PyYAML), node, openssl, curl
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT="$(pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"; [[ -n "${SRV_PID:-}" ]] && kill "$SRV_PID" 2>/dev/null || true' EXIT

VERSION=0.16.0
SHA=abc1234
TS=2026-01-01T00:00:00Z
JS=gridcraft-web-c40cb0ab7da8bf2c.js
WASM=gridcraft-web-99e5c067acb270d_bg.wasm

echo "== extract real step scripts from the workflow =="
python3 - "$WORK" <<'PY'
import pathlib, sys, yaml
wf = yaml.safe_load(pathlib.Path(".github/workflows/publish-web.yml").read_text())
work = pathlib.Path(sys.argv[1])
assemble = next(s for s in wf["jobs"]["build"]["steps"] if s.get("name") == "Assemble the PWA site")
(work / "assemble.sh").write_text(assemble["run"])
(work / "verify.sh").write_text(wf["jobs"]["verify"]["steps"][0]["run"])
print("  assemble.sh + verify.sh extracted")
PY

echo "== fake trunk output =="
mkdir -p "$WORK/site/snippets/eframe-test"
cat > "$WORK/site/index.html" <<'HTML'
<!DOCTYPE html>
<html>
  <head>
    <meta charset="utf-8">
    <title>GridCraft</title>
    <link rel="icon" href="./gridcraft-45f84b7721cb79a9.ico" integrity="sha384-aaa"/>
    <link rel="modulepreload" href="./snippets/eframe-test/inline0.js" crossorigin="anonymous" integrity="sha384-ccc"/>
  </head>
  <body>
    <div id="gridcraft_loading">Loading GridCraft…</div>
    <script type="module">import init from './gridcraft-web-c40cb0ab7da8bf2c.js'; init();</script>
  </body>
</html>
HTML
echo 'export function egui_text_agent_activate(){}' > "$WORK/site/snippets/eframe-test/inline0.js"
head -c 5000 /dev/urandom | base64 > "$WORK/site/$JS"
head -c 20000 /dev/urandom > "$WORK/site/$WASM"
head -c 1000 /dev/urandom > "$WORK/site/gridcraft-45f84b7721cb79a9.ico"
touch "$WORK/site/.trunk-lock"

echo "== run the workflow's real assemble step =="
cd "$WORK"
ln -s "$ROOT/pwa" pwa
export GRIDCRAFT_VERSION=$VERSION UPSTREAM_SHA=$SHA BUILD_TS=$TS GITHUB_OUTPUT="$WORK/gh-output"
: > "$GITHUB_OUTPUT"
bash "$WORK/assemble.sh" > "$WORK/assemble.log" 2>&1 || { cat "$WORK/assemble.log"; exit 1; }
grep -q "js_name=$JS" "$GITHUB_OUTPUT"
grep -q "wasm_name=$WASM" "$GITHUB_OUTPUT"
[[ ! -e publish/.trunk-lock ]]
echo "  assemble OK (outputs set, .trunk-lock dropped)"

echo "== service worker semantics (tests/sw-test.js) =="
node "$ROOT/tests/sw-test.js" "$WORK/publish/sw.js"

echo "== deploy smoke test (workflow's real verify script, over local HTTP) =="
PORT=$((20000 + RANDOM % 20000))
(cd "$WORK/publish" && exec python3 -m http.server "$PORT" >/dev/null 2>&1) &
SRV_PID=$!
sleep 1
# BASE deliberately WITHOUT trailing slash — that's what configure-pages emits.
BASE="http://127.0.0.1:$PORT" EXPECTED_STAMP="$VERSION+$TS ($SHA)" \
  JS_NAME="$JS" WASM_NAME="$WASM" CB=local bash "$WORK/verify.sh" | tail -2
kill "$SRV_PID" 2>/dev/null || true; SRV_PID=

echo
echo "ALL LOCAL PWA TESTS PASSED"
