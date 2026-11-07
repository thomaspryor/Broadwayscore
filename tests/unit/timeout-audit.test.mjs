// CI gate for BRO-2383 (BRO-108 follow-up, repo-wide): every https.get()/
// http.get() call site under scripts/ and scripts/lib/ must carry timeout
// protection. Unlike scripts/audit-fetch-timeouts.js's own informational
// full-repo scan (which also reports fetch() gaps, non-blocking by design —
// #1862, too large a surface to gate in one pass), this test is a hard CI
// gate scoped to exactly BRO-2383's acceptance criteria: https.get()/
// http.get() only. fetch() timeout coverage is tracked separately and is not
// gated here.
//
// "Excluding explicitly third-party scripts or known exceptions documented
// in the test itself" (acceptance criteria) maps to the scanner's existing
// per-file `// hygiene-fetch-timeout-ok: <reason>` exemption comment — any
// future genuine exception is documented at its call site, not carved out
// here. As of BRO-2383 there are zero such exemptions in the corpus; this
// test fails if a NEW unprotected http(s).get() call is introduced without
// one.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { checkFile, listScannableFiles } = require('../../scripts/audit-fetch-timeouts.js');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, '..', '..');

test('every https.get()/http.get() call site under scripts/ has timeout protection (BRO-2383)', () => {
  const files = listScannableFiles(path.join(REPO_ROOT, 'scripts'));
  const findings = files
    .flatMap((f) => checkFile(f))
    .filter((f) => f.call === 'https.get()/http.get()');

  assert.deepEqual(
    findings,
    [],
    `Found ${findings.length} https.get()/http.get() call site(s) without timeout protection:\n` +
      findings.map((f) => `  ${f.file}:${f.line} — ${f.detail}`).join('\n') +
      `\n\nFix: add { timeout: N } plus a .on('timeout', ...) handler that calls .destroy() ` +
      `(or req.setTimeout(N, cb) with cb calling .destroy()). See scripts/discover-new-shows.js ` +
      `for the established pattern (BRO-108, PR 629). ` +
      `Genuine exception? Add  // hygiene-fetch-timeout-ok: <reason>  to the file.`
  );
});

// BRO-3603 / BRO-3840: the fetch() (143 sites) and https.request()/
// http.request() (55 sites) gaps are fixed too, so the same hard gate now
// covers every call class the scanner knows. A new unprotected call fails
// here with its file:line.
for (const call of ['fetch()', 'https.request()/http.request()']) {
  test(`every ${call} call site under scripts/ has timeout protection (BRO-3603/BRO-3840)`, () => {
    const files = listScannableFiles(path.join(REPO_ROOT, 'scripts'));
    const findings = files.flatMap((f) => checkFile(f)).filter((f) => f.call === call);
    assert.deepEqual(
      findings.map((f) => `${path.relative(REPO_ROOT, f.file)}:${f.line}`),
      [],
      `Found ${findings.length} ${call} call site(s) without timeout protection.\n` +
        (call === 'fetch()'
          ? 'Fix: pass signal: AbortSignal.timeout(N) in the fetch options.'
          : "Fix: req.setTimeout(N, () => req.destroy(new Error('...'))) next to the request's .on('error') handler.") +
        '\nGenuine exception? Add  // hygiene-fetch-timeout-ok: <reason>  to the file.'
    );
  });
}

test('scanner: the shorthand `{ timeout }` option counts as a timeout option (BRO-3840)', () => {
  const { checkSource } = require('../../scripts/audit-fetch-timeouts.js');
  const shorthand = "function f(url, timeout) {\n  const req = https.request(url, { method: 'HEAD', timeout }, () => {});\n  req.on('timeout', () => { req.destroy(); });\n  req.on('error', () => {});\n}\n";
  assert.deepEqual(checkSource('x.js', shorthand), []);
  // The option alone is still not protection: no destroy handler -> flagged.
  const noDestroy = "function f(url, timeout) {\n  const req = https.request(url, { timeout }, () => {});\n  req.on('error', () => {});\n}\n";
  assert.equal(checkSource('x.js', noDestroy).length, 1);
});

test('scanner: http module aliases are resolved per file (BRO-5261)', () => {
  const { checkSource } = require('../../scripts/audit-fetch-timeouts.js');
  const ternary = "const https = require('https');\nfunction f(u) {\n  const client = u.protocol === 'http:' ? require('http') : https;\n  return new Promise((res, rej) => { client.get(u, {}, () => {}).on('error', rej); });\n}\n";
  assert.equal(checkSource('x.js', ternary).length, 1, 'ternary alias call is seen');
  const required = "function f(u) {\n  const trHttp = require('https');\n  trHttp.get(u, {}, () => {}).on('error', () => {});\n}\n";
  assert.equal(checkSource('x.js', required).length, 1, 'require alias call is seen');
  const inline = "function f(o) {\n  const req = require('https').request(o, () => {});\n  req.on('error', () => {});\n  req.end();\n}\n";
  assert.equal(checkSource('x.js', inline).length, 1, "require('https').request is seen");
  const fixed = "function f(u) {\n  const trHttp = require('https');\n  trHttp.get(u, {}, () => {}).on('error', () => {}).setTimeout(30000, function () { this.destroy(new Error('t')); });\n}\n";
  assert.deepEqual(checkSource('x.js', fixed), []);
  // A Map or other object that happens to share an alias-like name is not http.
  const notHttp = "function f(k) {\n  const client = new Map();\n  return client.get(k);\n}\n";
  assert.deepEqual(checkSource('x.js', notHttp), []);
  // The module name inside a string is not a call.
  const inString = "const s = \"require('https').get(url)\";\n";
  assert.deepEqual(checkSource('x.js', inString), []);
});

test('scanner: an unrelated later .destroy( does not count as the timeout handler (BRO-5261)', () => {
  const { checkSource } = require('../../scripts/audit-fetch-timeouts.js');
  const filler = '  const pad = 1;\n'.repeat(60); // past the 800-char handler window
  const src = `function f(u) {\n  const req = https.request(u, () => {});\n  req.setTimeout(0);\n  req.on('error', () => {});\n${filler}  res2.destroy();\n}\n`;
  assert.equal(checkSource('x.js', src).length, 1);
});

test('scanner: a multi-line `https\\n  .get(` call is seen, and its request variable is not an alias (BRO-5261)', () => {
  const { checkSource } = require('../../scripts/audit-fetch-timeouts.js');
  const multiline = "function f(url) {\n  return new Promise((res, rej) => {\n    https\n      .get(url, {}, () => {})\n      .on('error', rej);\n  });\n}\n";
  assert.equal(checkSource('x.js', multiline).length, 1);
  const bounded = multiline.replace(".on('error', rej);", ".on('error', rej)\n      .setTimeout(60000, function () { this.destroy(new Error('t')); });");
  assert.deepEqual(checkSource('x.js', bounded), []);
  // `const req = https\n  .get(...)` binds the request, not the module.
  const reqVar = "function f(u, m) {\n  const req = https\n    .get(u, { timeout: 5000 }, () => {});\n  req.on('timeout', () => req.destroy());\n  req.on('error', () => {});\n  return m.get(u);\n}\nfunction g(req) { return req.get('x'); }\n";
  assert.deepEqual(checkSource('x.js', reqVar), []);
});
