#!/bin/sh
# Load each extension against a stubbed Spotify and report anything that throws.
#
# Parsing is not enough: "sleep is not defined" is perfectly valid JavaScript
# and only fails when the line runs. This catches undefined identifiers and
# anything else that blows up at load or during init.
set -e
cd "$(dirname "$0")"
D="${TMPDIR:-/tmp}/bmx-smoke"; mkdir -p "$D"
cat > "$D/smoke.js" <<'EOF'
ObjC.import('Foundation');
var read = p => $.NSString.stringWithContentsOfFileEncodingError(p, $.NSUTF8StringEncoding, null).js;
var logs = [], errs = [];
globalThis.console = {
  log: (...a) => logs.push(a.join(' ')), warn: (...a) => logs.push('WARN ' + a.join(' ')),
  error: (...a) => errs.push(a.join(' ')), debug(){}, table(){},
};
// Everything Spicetify exposes, stubbed: any property is callable and any call
// returns the same stub, so chains like Spicetify.Platform.PlaylistAPI.add()
// resolve. Symbol handling keeps it usable in template literals.
var noop = new Proxy(function(){}, {
  get: (t, k) => (k === Symbol.toPrimitive || k === 'toString' || k === 'valueOf') ? (() => '') : noop,
  apply: () => noop, construct: () => noop,
});
globalThis.window = globalThis;
globalThis.addEventListener = () => {}; globalThis.removeEventListener = () => {};
globalThis.dispatchEvent = () => true;
globalThis.document = noop;
globalThis.localStorage = { _d:{}, getItem(k){return this._d[k]??null},
  setItem(k,v){this._d[k]=String(v)}, removeItem(k){delete this._d[k]}, clear(){this._d={}} };
globalThis.Spicetify = noop;
globalThis.setTimeout = () => 0;          // don't run deferred work
globalThis.setInterval = () => 0;
globalThis.MutationObserver = function(){ return { observe(){} } };
globalThis.CustomEvent = function(){}; globalThis.Event = function(){};
globalThis.requestIdleCallback = () => 0;
var out = { file: FILE.split('/').pop() };
try { new Function(read(FILE))(); out.loaded = true; }
catch (e) { out.loaded = false; out.threw = String(e); }
out.errors = errs;
JSON.stringify(out);
EOF
fail=0
for f in better-mix/better-mix.js; do
  sed "s|FILE|'$PWD/$f'|g" "$D/smoke.js" > "$D/run.js"
  r=$(osascript -l JavaScript "$D/run.js" 2>&1 | tail -1)
  case "$r" in
    *'"loaded":true'*'"errors":[]'*) printf "  ok    %s\n" "$f" ;;
    *) printf "  FAIL  %s\n     %s\n" "$f" "$r"; fail=1 ;;
  esac
done
[ "$fail" = 0 ] && echo "all extensions load clean" || { echo "smoke test failed"; exit 1; }
