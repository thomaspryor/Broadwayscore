// LIVE-DATA-LANE: reads data/shows.json (untracked core data); data/critic-registry.json (untracked core data). Runs in check-corpus-drift.yml, not test.yml's blocking batch (BRO-7101).
// BRO-6872: a fix plan ran ingest-review-from-url.js --stub-on-failure, the ingest wrote only a retry stub and exited 0,
// and execute-approved-fix.js marked the plan applied although no review reached the site. The ingest now reports a stub
// outcome to INGEST_OUTCOME_FILE and the fix runner fails the action (plan status partial).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const o = require('../../scripts/lib/ingest-outcome.js');
const ROOT = path.join(path.dirname(new URL(import.meta.url).pathname), '..', '..');

test('a retry-stub outcome is a failed recovery; anything else is not', () => {
  assert.match(o.stubProblem({ outcome: 'retry-stub', reason: 'fetch failed: 403' }) || '', /only a retry stub \(fetch failed: 403\)/);
  assert.equal(o.stubProblem(null), null, 'no outcome file (other scripts): unchanged');
  assert.equal(o.stubProblem({ outcome: 'ingested' }), null);
  assert.match(o.stubProblem({ outcome: 'skipped', reason: 'outside-date-window' }) || '', /skipped the page \(outside-date-window\)/);
});

test('write/read round trip; no env means no file', () => {
  const f = o.newOutcomeFile();
  try {
    o.writeIngestOutcome({ outcome: 'retry-stub', reason: 'x' }, { [o.ENV]: f });
    assert.deepEqual(o.readIngestOutcome(f), { outcome: 'retry-stub', reason: 'x' });
  } finally { o.removeOutcomeFile(f); }
  assert.equal(fs.existsSync(path.dirname(f)), false);
  o.writeIngestOutcome({ outcome: 'retry-stub' }, {}); // no-op, no throw
  assert.equal(o.readIngestOutcome('/nonexistent/x.json'), null);
});

test('the real ingest, given a page with no review, exits 0 and reports the stub (dry run)', (t) => {
  if (!fs.existsSync(path.join(ROOT, 'data', 'shows.json'))) { t.skip('no local core data'); return; }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bro6872-ingest-'));
  try {
    const html = path.join(dir, 'tiny.html');
    fs.writeFileSync(html, '<html><body>x</body></html>');
    const out = o.newOutcomeFile();
    const r = spawnSync(process.execPath, ['scripts/ingest-review-from-url.js', '--show=the-imaginary-invalid-2026',
      '--url=https://www.washingtonpost.com/entertainment/theater/2026/10/23/bro6872-test/', '--outlet=washpost',
      '--critic=Test Critic', '--publish-date=2026-10-23', `--html-file=${html}`, '--stub-on-failure', '--dry-run'],
    { cwd: ROOT, env: { ...process.env, [o.ENV]: out }, encoding: 'utf8', timeout: 120000 });
    assert.equal(r.status, 0, r.stderr.slice(-500));
    assert.match(o.stubProblem(o.readIngestOutcome(out)) || '', /retry stub \(no usable HTML/);
    o.removeOutcomeFile(out);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('execute-approved-fix wires the outcome into run-script actions', () => {
  const src = fs.readFileSync(path.join(ROOT, 'scripts/execute-approved-fix.js'), 'utf8');
  const fn = src.slice(src.indexOf('function executeRunScript'), src.indexOf('function executeReviewFileOp'));
  assert.match(fn, /\[outcome\.ENV\]: outcomeFile/);
  assert.match(fn, /stubProblem\(/);
  assert.match(fn, /if \(stubbed\) return \{ ok: false/);
});
