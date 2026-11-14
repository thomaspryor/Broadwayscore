// BRO-3435: done-gate hardening — sibling data-repo evidence, fetch ref-lock
// retry, HTTP status surfaced in refusals.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  extractEvidenceRefs,
  evaluateEvidence,
  makeRemoteLookup,
} = require('../../scripts/lib/done-evidence-verify.js');
const { fetchOriginMain } = require('../../scripts/lib/card-premises-auditor.js');

const LOCAL = 'thomaspryor/Broadwayscore';
const SHA = 'a'.repeat(39) + '1';
const DATA_URL = `https://github.com/thomaspryor/broadway-scorecard-data/commit/${SHA}`;

test('extract: a sibling data-repo commit URL is reported as sibling (and still foreign)', () => {
  const refs = extractEvidenceRefs(`merged deployed checked (${DATA_URL})`, { originRepo: LOCAL });
  assert.deepEqual(refs.siblings, [{ repo: 'thomaspryor/broadway-scorecard-data', sha: SHA }]);
  assert.equal(refs.foreign.length, 1);
  assert.deepEqual(refs.commits, []);
});

test('extract: an unknown repo is foreign only, never a sibling', () => {
  const refs = extractEvidenceRefs(`(https://github.com/someone/else/commit/${SHA})`, { originRepo: LOCAL });
  assert.deepEqual(refs.siblings, []);
  assert.equal(refs.foreign.length, 1);
});

test('evaluate: sibling commit on main that names the issue verifies', () => {
  const refs = extractEvidenceRefs(DATA_URL, { originRepo: LOCAL });
  const r = evaluateEvidence(refs, {
    issueIdentifier: 'BRO-3435',
    siblingCommit: () => ({ onMain: true, message: 'data: fix thing (BRO-3435)' }),
  });
  assert.equal(r.verified, true);
});

test('evaluate: sibling commit that does not name the issue is unverified, not proof', () => {
  const refs = extractEvidenceRefs(DATA_URL, { originRepo: LOCAL });
  const r = evaluateEvidence(refs, {
    issueIdentifier: 'BRO-3435',
    siblingCommit: () => ({ onMain: true, message: 'data: unrelated BRO-34350' }),
  });
  assert.equal(r.verified, null);
  assert.match(r.reason, /does not mention BRO-3435/);
});

test('evaluate: sibling lookup failure surfaces the HTTP status in the reason', () => {
  const refs = extractEvidenceRefs(DATA_URL, { originRepo: LOCAL });
  const siblingCommit = () => null;
  siblingCommit.lastError = 'HTTP 401';
  const r = evaluateEvidence(refs, { issueIdentifier: 'BRO-3435', siblingCommit });
  assert.equal(r.verified, null);
  assert.match(r.reason, /HTTP 401/);
});

test('evaluate: PR lookup failure surfaces the HTTP status instead of "lookup failed"', () => {
  const getPrMergeCommit = () => null;
  getPrMergeCommit.lastError = 'HTTP 403';
  const r = evaluateEvidence({ commits: [], prs: [7], foreign: [] }, { getPrMergeCommit, isCommitOnMain: () => null });
  assert.equal(r.verified, null);
  assert.match(r.reason, /HTTP 403/);
});

test('evaluate: foreign non-sibling repo keeps the original "another repo" reason', () => {
  const refs = extractEvidenceRefs(`https://github.com/someone/else/commit/${SHA}`, { originRepo: LOCAL });
  const r = evaluateEvidence(refs, { siblingCommit: () => null });
  assert.equal(r.verified, null);
  assert.match(r.reason, /another repo/);
});

test('remote lookup: commitIn queries the named sibling repo and caches per repo+sha', () => {
  const urls = [];
  const remote = makeRemoteLookup({
    originRepo: LOCAL,
    httpGetJson: (u) => { urls.push(u); return { status: 'behind', merge_base_commit: { commit: { message: 'BRO-1' } } }; },
  });
  const a = remote.commitIn('thomaspryor/broadway-scorecard-data', SHA);
  remote.commitIn('thomaspryor/broadway-scorecard-data', SHA);
  assert.equal(a.onMain, true);
  assert.equal(urls.length, 1);
  assert.match(urls[0], /repos\/thomaspryor\/broadway-scorecard-data\/compare\/main\.\.\./);
});

test('fetchOriginMain: retries a ref-lock collision, gives up on other errors', async () => {
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const path = await import('node:path');
  const dir = mkdtempSync(path.join(tmpdir(), 'fetch-retry-'));
  // Not a git repo with an origin: every fetch fails with a non-lock error ->
  // exactly one attempt, no sleep.
  let sleeps = 0;
  const ok = fetchOriginMain({ repo: dir, attempts: 3, sleepMs: () => { sleeps++; } });
  assert.equal(ok, false);
  assert.equal(sleeps, 0);
});

test('fetchOriginMain: a ref-lock collision is retried and then succeeds', async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fetch-lock-'));
  const counter = path.join(dir, 'n');
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin);
  // Fake git: `fetch` fails with a lock error the first time, passes after.
  fs.writeFileSync(path.join(bin, 'git'), `#!/bin/sh
case "$1" in
  fetch)
    n=$(cat "${counter}" 2>/dev/null || echo 0); n=$((n+1)); echo $n > "${counter}"
    if [ "$n" -lt 2 ]; then echo "fatal: cannot lock ref 'refs/remotes/origin/main': Unable to create '.git/refs/remotes/origin/main.lock'" >&2; exit 1; fi
    exit 0;;
  *) exit 1;;
esac
`, { mode: 0o755 });
  const oldPath = process.env.PATH;
  process.env.PATH = `${bin}:${oldPath}`;
  let sleeps = 0;
  try {
    assert.equal(fetchOriginMain({ repo: dir, attempts: 3, sleepMs: () => { sleeps++; } }), true);
  } finally { process.env.PATH = oldPath; }
  assert.equal(sleeps, 1);
  assert.equal(fs.readFileSync(counter, 'utf8').trim(), '2');
});
