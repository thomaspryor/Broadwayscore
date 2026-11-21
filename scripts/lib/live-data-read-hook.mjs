// live-data-read-hook.mjs (BRO-7101) — records which test files read the
// repo's live, bot-rewritten state (data/**) at RUNTIME.
//
// Why runtime and not a source scan: a test usually reaches data/shows.json
// through a library default (loadShows(), getAllShows(), a script's DATA_DIR),
// not a literal path in the test file, and a static scan also flags fixtures
// that build a tmp/data/shows.json tree. Only the real path opened at runtime
// tells the two apart. Fed to scripts/live-data-lane.js, which decides each
// test's lane (blocking unit batch vs the non-blocking live-data lane).
//
// Load with:  node --import ./scripts/lib/live-data-read-hook.mjs --test ...
// (node --test passes --import on to every test-file subprocess). Inert unless
// LIVE_DATA_READ_LOG names a file; each read appends one JSON line
// {"test":"tests/unit/x.test.mjs","path":"data/shows.json","direct":false} to it. Never throws
// into the test: a logging failure is swallowed.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { fileURLToPath } from 'node:url';

const LOG = process.env.LIVE_DATA_READ_LOG;
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const { liveDataRelPath, isTestCaller } = createRequire(import.meta.url)('./live-data-paths.js');

function testFile() {
  // A process a test spawned (execFileSync('node', [script])) inherits
  // LIVE_DATA_TEST from the test-file process, so its reads are charged to the
  // test, not to the script. Otherwise node --test runs each file in its own
  // process and argv[1] is that file.
  if (process.env.LIVE_DATA_TEST) return process.env.LIVE_DATA_TEST;
  const a = process.argv[1] || '';
  return a ? path.relative(ROOT, path.resolve(a)).split(path.sep).join('/') : '';
}

if (LOG) {
  const test = testFile();
  // Reach grandchildren: node --test forwards --import only to the test-file
  // processes it starts, not to processes a test spawns itself.
  if (test && !process.env.LIVE_DATA_TEST) process.env.LIVE_DATA_TEST = test;
  const self = `--import=${fileURLToPath(import.meta.url)}`;
  if (!(process.env.NODE_OPTIONS || '').includes(self)) {
    process.env.NODE_OPTIONS = `${process.env.NODE_OPTIONS || ''} ${self}`.trim();
  }
  const seen = new Set();
  const HOOK = fileURLToPath(import.meta.url);
  // Who made the read: the first stack frame outside node internals and this
  // hook. "direct" = the test file (or a helper under tests/) read data/ itself,
  // which means it asserts on that file. "indirect" = a library or a spawned
  // script read it, e.g. a venue table loaded at import; scripts/live-data-lane.js
  // counts those only for core data (see isHotPath).
  const callerIsTest = () => {
    const lim = Error.stackTraceLimit;
    Error.stackTraceLimit = 40; // require() of a .json sits ~8 internal frames deep
    const stack = String(new Error().stack);
    Error.stackTraceLimit = lim;
    for (const line of stack.split('\n').slice(2)) {
      const m = /(?:\(|at )((?:file:\/\/)?\/[^():]+):\d+:\d+\)?\s*$/.exec(line); // skips node:internal frames
      if (!m) continue;
      const f = m[1].startsWith('file://') ? fileURLToPath(m[1]) : m[1];
      if (f === HOOK) continue;
      const rel = path.relative(ROOT, f).split(path.sep).join('/');
      return isTestCaller(rel, test);
    }
    return false;
  };
  const record = (p) => {
    try {
      let s = p;
      if (s instanceof URL) s = fileURLToPath(s);
      else if (Buffer.isBuffer(s)) s = s.toString();
      if (typeof s !== 'string') return; // fd
      if (s.startsWith('file://')) s = fileURLToPath(s);
      const rel = liveDataRelPath(path.resolve(s), ROOT);
      if (!rel) return;
      const direct = callerIsTest();
      const key = `${direct ? 'd' : 'i'}:${rel}`;
      if (seen.has(key)) return;
      seen.add(key);
      origAppend(LOG, JSON.stringify({ test, path: rel, direct }) + '\n');
    } catch { /* never break the test */ }
  };
  const origAppend = fs.appendFileSync.bind(fs);
  const wrap = (obj, name) => {
    const orig = obj[name];
    if (typeof orig !== 'function') return;
    obj[name] = function patched(p, ...rest) { record(p); return orig.call(this, p, ...rest); };
  };
  // Reads and opens. existsSync/statSync are deliberately NOT counted: probing
  // whether a file exists is not asserting on its content.
  for (const n of ['readFileSync', 'readFile', 'openSync', 'open', 'createReadStream', 'readdirSync', 'readdir']) wrap(fs, n);
  for (const n of ['readFile', 'open', 'readdir']) wrap(fs.promises, n);
  // `import { readFileSync } from 'node:fs'` binds the ESM named export, which
  // is a copy taken at startup; push the patched functions into it.
  try { syncBuiltinESMExports(); } catch { /* best effort */ }
  // ESM `import x from '../data/shows.json' with { type: 'json' }` does not go
  // through the public fs object; a load hook sees it. CJS require() of .json
  // calls fs.readFileSync, already wrapped above.
  try {
    const { register } = await import('node:module');
    if (typeof register === 'function') {
      register('./live-data-read-loader.mjs', import.meta.url, { data: { log: LOG, test, root: ROOT } });
    }
  } catch { /* older node: CJS + fs coverage only */ }
}
