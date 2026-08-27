// Regression tests for scripts/audit-fetch-timeouts.js (#1862, BRO-108
// follow-up: repo-wide fetch()/https.get()/http.get() timeout-protection
// scanner). Every false-positive class listed below was caught live by
// running the scanner against the real corpus and manually verifying a
// sample of its findings — each fixture pins the fix so it can't regress.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { checkSource, checkFile, listScannableFiles } = require('./audit-fetch-timeouts.js');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, '..');

// --- fetch() detection ---

test('unprotected fetch() is flagged', () => {
  const src = `async function go() {\n  const r = await fetch(url);\n  return r;\n}`;
  const findings = checkSource('fixture.js', src);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].call, 'fetch()');
});

test('fetch() with AbortSignal.timeout(N) — literal — is not flagged', () => {
  const src = `async function go() {\n  const r = await fetch(url, { signal: AbortSignal.timeout(15000) });\n  return r;\n}`;
  assert.deepEqual(checkSource('fixture.js', src), []);
});

test('fetch() with AbortSignal.timeout(variable) is not flagged', () => {
  // Real gap found live: scripts/lib/linear-client.js used
  // AbortSignal.timeout(timeoutMs) — a \d+-only regex missed it entirely.
  const src = `async function go(timeoutMs) {\n  const r = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });\n  return r;\n}`;
  assert.deepEqual(checkSource('fixture.js', src), []);
});

test('fetch() protected by AbortController + setTimeout(...abort()) is not flagged', () => {
  // Real gap found live: scripts/backfill-pv-critics.js's fetchWithTimeout()
  // sets up the controller/timer BEFORE the fetch() call — scanning only
  // forward from the call site missed it.
  const src = `
    async function fetchWithTimeout(url, timeoutMs = 8000) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      const resp = await fetch(url, { signal: controller.signal });
      clearTimeout(timer);
      return resp;
    }`;
  assert.deepEqual(checkSource('fixture.js', src), []);
});

test('two fetch() calls in one function, one protected one not — only the unprotected one is flagged', () => {
  // The core bug two independent adversarial reviews (Claude + Codex)
  // converged on live: "enclosing function scope" checked "does ANY
  // protection pattern appear anywhere in this text", not "does it protect
  // THIS call" — so one call's AbortController would silently mask a
  // completely unrelated, genuinely unprotected sibling call in the same
  // function. Fixed by tying the AbortController/AbortSignal search to the
  // specific `signal:` identifier this call actually uses.
  const src = `
    async function doTwoThings(url1, url2) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 5000);
      const a = await fetch(url1, { signal: controller.signal });
      clearTimeout(timer);
      const b = await fetch(url2);
      return [a, b];
    }`;
  const findings = checkSource('fixture.js', src);
  assert.equal(findings.length, 1, `expected exactly the unprotected fetch(url2) to be flagged, got: ${JSON.stringify(findings)}`);
  assert.equal(findings[0].line, 7);
});

test('two https.get() calls in one function, one protected one not — only the unprotected one is flagged', () => {
  const src = `
    function doTwoThings() {
      const req1 = https.get(url1, { timeout: 15000 }, cb1);
      req1.on('timeout', () => req1.destroy());
      const req2 = https.get(url2, { timeout: 15000 }, cb2);
      // req2 has no destroy handler at all — a real gap
    }`;
  const findings = checkSource('fixture.js', src);
  assert.equal(findings.length, 1, `expected exactly the unprotected req2 call to be flagged, got: ${JSON.stringify(findings)}`);
  assert.equal(findings[0].line, 5);
});

test('export async function (TypeScript) is a real function boundary', () => {
  // Real false negative found live: scripts/llm-scoring/batch-clients.ts
  // uses `export async function submitOpenAIBatch(...)` throughout — the
  // boundary regex required the match to start with `function`/`async
  // function`, so a leading `export ` prefix meant ZERO boundaries were
  // found in the whole file, collapsing all 7 exported functions (14 fetch()
  // calls) into one shared scope.
  const src = `
    export async function callA(url1, url2) {
      const a = await fetch(url1, { signal: AbortSignal.timeout(5000) });
      return a;
    }
    export async function callB(url) {
      const b = await fetch(url);
      return b;
    }`;
  const findings = checkSource('fixture.ts', src);
  assert.equal(findings.length, 1, `expected only callB's fetch to be flagged, got: ${JSON.stringify(findings)}`);
  assert.equal(findings[0].line, 7);
});

test('a TypeScript class method with a return-type annotation is a real function boundary', () => {
  // Real false negative found live: scripts/llm-scoring/kimi-scorer.ts's
  // `async scoreReview(...): Promise<KimiScoringOutcome> {` — the `: Type`
  // return annotation sits between the closing paren and the body's `{`,
  // so the naive "closing paren then whitespace then {" check landed on the
  // return-type text and never recognized the method as a boundary.
  const src = `
    class Client {
      async methodA(x: string): Promise<void> {
        const a = await fetch(x, { signal: AbortSignal.timeout(5000) });
        return a;
      }
      async methodB(x: string): Promise<void> {
        const b = await fetch(x);
        return b;
      }
    }`;
  const findings = checkSource('fixture.ts', src);
  assert.equal(findings.length, 1, `expected only methodB's fetch to be flagged, got: ${JSON.stringify(findings)}`);
  assert.equal(findings[0].line, 8);
});

test('a top-level arrow function assigned with const is a real function boundary', () => {
  const src = `
    const helperA = async (url) => {
      const a = await fetch(url, { signal: AbortSignal.timeout(5000) });
      return a;
    };
    const helperB = async (url) => {
      const b = await fetch(url);
      return b;
    };`;
  const findings = checkSource('fixture.js', src);
  assert.equal(findings.length, 1, `expected only helperB's fetch to be flagged, got: ${JSON.stringify(findings)}`);
  assert.equal(findings[0].line, 7);
});

test('a parenthesized non-arrow expression is NOT mistaken for an arrow-function boundary', () => {
  // Regression guard for the ORIGINAL boundary bug (searchTodayTixByTitle,
  // discover-new-shows.js): `const n = (a || b).toLowerCase()` must not be
  // treated as an arrow-function head just because `= (` appears.
  const src = `
    function go() {
      const req = https.get(url, { timeout: 15000 }, (res) => {
        const n = (res.displayName || res.name || '').toLowerCase();
        return n;
      });
      req.on('timeout', () => req.destroy());
    }`;
  assert.deepEqual(checkSource('fixture.js', src), []);
});

test('a function literally named fetch() (shadowing global) is never flagged', () => {
  // Real false positive found live across 6 files (fetch-bww-roundups.js,
  // fetch-from-wayback.js, scripts/lib/author-pages/{muckrack,bww,nysr,
  // nysun}.js): each defines its own `function fetch(...)` wrapper around
  // https.get(). The declaration itself matched FETCH_RE, and internal
  // recursive/self calls read as "global fetch() missing AbortSignal" —
  // inapplicable advice, since AbortSignal doesn't apply to a hand-rolled
  // https.get() wrapper at all. The real gap (if any) belongs to the
  // https.get() scan instead.
  const src = `
    function fetch(url) {
      return new Promise((resolve, reject) => {
        const req = https.get(url, { timeout: 30000 }, (res) => {
          if (res.statusCode >= 300 && res.statusCode < 400) {
            fetch(res.headers.location).then(resolve).catch(reject);
            return;
          }
          resolve(res);
        });
        req.on('error', reject);
        req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
      });
    }
    async function caller() { return fetch(someUrl); }`;
  assert.deepEqual(checkSource('fixture.js', src), []);
});

// --- https.get()/http.get() detection ---

test('https.get() with no timeout at all is flagged', () => {
  const src = `function go() {\n  https.get(url, (res) => {}).on('error', () => {});\n}`;
  const findings = checkSource('fixture.js', src);
  assert.equal(findings.length, 1);
  assert.match(findings[0].detail, /no \{ timeout: N \} option/);
});

test('https.get() with { timeout: N } but no destroy handler is flagged (the BRO-108 gap)', () => {
  // The exact shape that survived a first-pass fix in discover-new-shows.js
  // and was only caught by adversarial review (BRO-108, second commit):
  // Node emits 'timeout' but does nothing on its own without a listener.
  const src = `function go() {\n  const req = https.get(url, { timeout: 15000 }, (res) => {});\n  req.on('error', () => {});\n}`;
  const findings = checkSource('fixture.js', src);
  assert.equal(findings.length, 1);
  assert.match(findings[0].detail, /no \.on\('timeout', \.\.\.\) handler/);
});

test('https.get() with { timeout: N } + .on(\'timeout\', ...) destroy handler is not flagged', () => {
  const src = `function go() {\n  const req = https.get(url, { timeout: 15000 }, (res) => {});\n  req.on('error', () => {});\n  req.on('timeout', () => { req.destroy(); });\n}`;
  assert.deepEqual(checkSource('fixture.js', src), []);
});

test('https.get() protected via req.setTimeout(N, ...destroy()) is not flagged', () => {
  const src = `function go() {\n  const req = https.get(url, (res) => {});\n  req.setTimeout(15000, () => { req.destroy(); });\n}`;
  assert.deepEqual(checkSource('fixture.js', src), []);
});

test('destroy() with arguments still counts (req.destroy(new Error(...)))', () => {
  const src = `function go() {\n  const req = https.get(url, (res) => {});\n  req.setTimeout(90000, () => req.destroy(new Error('Request timeout')));\n}`;
  assert.deepEqual(checkSource('fixture.js', src), []);
});

test('.on(\'timeout\', function() { this.destroy(); }) — this.destroy() also counts', () => {
  const src = `function go() {\n  https.get(url, { timeout: 15000 }, (res) => {}).on('error', () => {}).on('timeout', function() { this.destroy(); });\n}`;
  assert.deepEqual(checkSource('fixture.js', src), []);
});

// --- string/comment false-positive guards ---

test('the literal text "fetch(" inside a string/template is never a call site', () => {
  // Real false positive found live: scripts/backlog-drain.js has
  // `` `, ${n} card fetch(es) FAILED...` `` — prose, not a call.
  const src = 'function go(n) {\n  return `, ${n} card fetch(es) FAILED (rate limit? not cached, retried next tick)`;\n}';
  assert.deepEqual(checkSource('fixture.js', src), []);
});

test('the literal text "https.get(" inside a comment is never a call site', () => {
  const src = `function go() {\n  // use fetchPage() instead of https.get(url) directly\n  return fetchPage(url);\n}`;
  assert.deepEqual(checkSource('fixture.js', src), []);
});

test('a comment merely NAMING a protection pattern does not satisfy the check', () => {
  const src = `function go() {\n  // remember to add AbortSignal.timeout(15000) here\n  const r = fetch(url);\n  return r;\n}`;
  const findings = checkSource('fixture.js', src);
  assert.equal(findings.length, 1, 'the comment must not fake protection for the real unprotected call');
});

// --- exemption ---

test('// hygiene-fetch-timeout-ok: <reason> suppresses the whole file', () => {
  const src = `// hygiene-fetch-timeout-ok: read-only tool, run once by hand and watched\nfunction go() {\n  https.get(url, () => {});\n}`;
  assert.deepEqual(checkSource('fixture.js', src), []);
});

// --- unparseable-file fallback still catches the common // case ---

test('a file that fails to tokenize still excludes // comment lines via the raw fallback', () => {
  const broken = `function ( { >>> not valid js\n// fetch(url) mentioned in a comment\nconst x = fetch(realUrl);`;
  const findings = checkSource('fixture.js', broken);
  // Must still see the REAL call (fail open, never silently hide it) but not
  // double-count the commented-out mention.
  assert.equal(findings.filter(f => f.call === 'fetch()').length, 1);
});

// --- end-to-end regression: the exact file BRO-108 fixed ---

test('scripts/discover-new-shows.js has zero unprotected call sites (BRO-108, PR 629)', () => {
  const findings = checkFile(path.join(REPO_ROOT, 'scripts', 'discover-new-shows.js'));
  assert.deepEqual(findings, [], `expected discover-new-shows.js to be clean, got: ${JSON.stringify(findings, null, 2)}`);
});

// --- scanner plumbing ---

test('listScannableFiles finds real scripts/ files and excludes itself + test files', () => {
  const files = listScannableFiles(path.join(REPO_ROOT, 'scripts'));
  assert.ok(files.length > 500, `expected hundreds of scannable files, got ${files.length}`);
  assert.ok(!files.some((f) => f.endsWith('audit-fetch-timeouts.js')), 'must exclude itself');
  assert.ok(!files.some((f) => /\.test\.(js|mjs|ts)$/.test(f)), 'must exclude test files');
  assert.ok(files.some((f) => f.endsWith('discover-new-shows.js')), 'must include a known real script');
});

test('full-repo scan runs without crashing and returns a plain array', () => {
  // Non-blocking smoke test (suggested approach step 2 of #1862: 100+ files
  // of pre-existing debt can't gate CI yet) — just proves the scanner
  // completes cleanly across the whole real corpus, not the specific count.
  const files = listScannableFiles(path.join(REPO_ROOT, 'scripts'));
  const findings = files.flatMap((f) => checkFile(f));
  assert.ok(Array.isArray(findings));
  for (const f of findings) {
    assert.ok(f.file && typeof f.line === 'number' && f.call && f.detail, `malformed finding: ${JSON.stringify(f)}`);
  }
});
