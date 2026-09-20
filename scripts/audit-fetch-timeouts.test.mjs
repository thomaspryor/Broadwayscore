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

test('a nested const-arrow helper declared AFTER the call does not truncate the outer function\'s scope (BRO-2383)', () => {
  // Real false positive found live: audit-show-score-url-redirects.js's
  // fetchTitle() declares `const req = https.get(...)`, then — after an
  // unrelated `const finish = () => {...}` helper nested inside the same
  // function — attaches `req.on('error', ...)` + `req.setTimeout(...destroy())`.
  // The old point-boundary scope ended at `finish`'s head (any nested
  // const-arrow counted as a NEW top-level boundary), cutting off before ever
  // reaching the real destroy handler.
  const src = `
    function fetchTitle(url) {
      return new Promise((resolve) => {
        const req = https.get(url, {}, (res) => {
          const finish = () => { resolve({ ok: true }); };
          finish();
        });
        req.on('error', (err) => resolve({ error: err.message }));
        req.setTimeout(15000, () => { req.destroy(); resolve({ error: 'timeout' }); });
      });
    }`;
  assert.deepEqual(checkSource('fixture.js', src), []);
});

test('https.get() options passed as a pre-built variable (not inlined) still finds the timeout', () => {
  // Real false positive found live: discover-dtli-slugs.js and
  // fetch-images.js both do `const options = { timeout: N, ... };
  // https.get(url, options, cb)` — the call's own argument text has no
  // literal "timeout:", just the bare identifier `options`.
  const src = `
    function httpGet(url) {
      return new Promise((resolve, reject) => {
        const options = { timeout: 20000, headers: {} };
        const req = https.get(url, options, (res) => { resolve(res); });
        req.on('error', reject);
        req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
      });
    }`;
  assert.deepEqual(checkSource('fixture.js', src), []);
});

test('an unrelated same-named identifier merely mentioned inside the callback body does not satisfy the options check', () => {
  // Real false negative found live (Codex adversarial review, BRO-2383): the
  // identifier scan originally matched ANY identifier appearing anywhere in
  // the call's argument text, including deep inside a callback function
  // BODY — so a same-named but unrelated variable with a { timeout: N }
  // declaration nearby could satisfy the check for a call whose real options
  // argument (`{}`) has no timeout at all.
  const src = `
    function f(url) {
      const metadata = { timeout: 15000 };
      const req = https.get(url, {}, res => console.log(metadata));
      req.on('timeout', () => req.destroy());
    }`;
  const findings = checkSource('fixture.js', src);
  assert.equal(findings.length, 1, `expected the real gap (no timeout in {}) to still be flagged, got: ${JSON.stringify(findings)}`);
});

test('an identifier options-lookalike with no matching { timeout } declaration does not false-negative', () => {
  const src = `
    function go(cb) {
      const req = https.get(url, cb, (res) => {});
      req.on('error', () => {});
    }`;
  // `cb` is a function parameter, never declared as `{ timeout: N, ... }` —
  // must not be mistaken for a timeout-bearing options object, and this call
  // has no destroy handler either, so it must still be flagged.
  const findings = checkSource('fixture.js', src);
  assert.equal(findings.length, 1);
});

// --- https.request()/http.request() detection (BRO-3838) ---

test('unprotected https.request() is flagged', () => {
  // The exact shape BRO-3832 hit live: scripts/batch-commercial-research.js's
  // analyzeShowWithClaude() POSTs to api.anthropic.com via https.request()
  // with zero timeout protection — outside the scanner's scope before this
  // fix, so it hung a 60min job without ever being flagged.
  const src = `
    function go(body) {
      const req = https.request({
        hostname: 'api.anthropic.com',
        path: '/v1/messages',
        method: 'POST',
      }, (res) => {});
      req.on('error', () => {});
      req.write(body);
      req.end();
    }`;
  const findings = checkSource('fixture.js', src);
  assert.equal(findings.length, 1, `expected the unprotected https.request() to be flagged, got: ${JSON.stringify(findings)}`);
  assert.equal(findings[0].call, 'https.request()/http.request()');
  assert.match(findings[0].detail, /no \{ timeout: N \} option/);
});

test('https.request() with { timeout: N } option but no destroy handler is flagged', () => {
  const src = `
    function go(body) {
      const req = https.request({ hostname: 'api.anthropic.com', method: 'POST', timeout: 30000 }, (res) => {});
      req.on('error', () => {});
      req.write(body);
      req.end();
    }`;
  const findings = checkSource('fixture.js', src);
  assert.equal(findings.length, 1);
  assert.match(findings[0].detail, /no \.on\('timeout', \.\.\.\) handler/);
});

test('https.request() with { timeout: N } + .on(\'timeout\', ...) destroy handler is not flagged', () => {
  const src = `
    function go(body) {
      const req = https.request({ hostname: 'api.anthropic.com', method: 'POST', timeout: 30000 }, (res) => {});
      req.on('error', () => {});
      req.on('timeout', () => { req.destroy(); });
      req.write(body);
      req.end();
    }`;
  assert.deepEqual(checkSource('fixture.js', src), []);
});

test('https.request() protected via req.setTimeout(N, ...destroy()) is not flagged', () => {
  const src = `
    function go(body) {
      const req = https.request({ hostname: 'api.anthropic.com', method: 'POST' }, (res) => {});
      req.setTimeout(30000, () => { req.destroy(); });
      req.write(body);
      req.end();
    }`;
  assert.deepEqual(checkSource('fixture.js', src), []);
});

test('http.request() (non-TLS) is covered by the same scan', () => {
  const src = `function go() {\n  const req = http.request({ host: 'example.com' }, (res) => {});\n  req.on('error', () => {});\n}`;
  const findings = checkSource('fixture.js', src);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].call, 'https.request()/http.request()');
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
