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
