// Unit tests for the Git Data API fallback path disqualifier (BRO-3663).
// Requires the REAL disqualifyingPath() rather than restating its rules
// (CLAUDE.md §15) — a production change to the predicate must fail these.
//
// The shell-level behaviour (that a disqualifying path suppresses the
// early-fallback break instead of forfeiting the retry budget) lives in
// push-with-retry.early-fallback-budget.test.sh — node:test cannot exercise
// bash control flow.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const { disqualifyingPath } = require('./api-fallback-disqualifier.js');
const realRegistry = require('./reconcile-merged-json.js');

const registry = {
  MANAGED: [{ file: 'data/audit/managed-thing.json' }],
  API_FALLBACK_SAFE: [{ file: 'data/audit/verified-single-writer.json' }],
  API_FALLBACK_MERGE: [{ file: 'data/audit/managed-thing.json' }],
};

test('an unaudited data/audit/ path disqualifies — the BRO-3663 production case', () => {
  assert.equal(
    disqualifyingPath(['data/audit/nobody-registered-me.json'], registry),
    'data/audit/nobody-registered-me.json'
  );
});

test('a registered apiFallbackSafe data/audit/ path does NOT disqualify', () => {
  assert.equal(disqualifyingPath(['data/audit/verified-single-writer.json'], registry), null);
});

test('a MANAGED file WITH apiFallbackMerge coverage does not disqualify (BRO-2413)', () => {
  assert.equal(disqualifyingPath(['data/audit/managed-thing.json'], registry), null);
});

test('a MANAGED file WITHOUT apiFallbackMerge coverage disqualifies', () => {
  const noMerge = { ...registry, API_FALLBACK_MERGE: [] };
  assert.equal(disqualifyingPath(['data/audit/managed-thing.json'], noMerge), 'data/audit/managed-thing.json');
});

test('shows.json and reviews.json always disqualify, registry regardless', () => {
  const permissive = {
    MANAGED: [],
    API_FALLBACK_SAFE: [{ file: 'data/shows.json' }, { file: 'data/reviews.json' }],
    API_FALLBACK_MERGE: [],
  };
  assert.equal(disqualifyingPath(['data/shows.json'], permissive), 'data/shows.json');
  assert.equal(disqualifyingPath(['data/reviews.json'], permissive), 'data/reviews.json');
});

test('ordinary source paths never disqualify — the early break must stay available', () => {
  assert.equal(disqualifyingPath(['src/app/page.tsx', 'scripts/foo.js', 'docs/x.md'], registry), null);
});

test('one bad path among many clean ones still disqualifies the whole diff', () => {
  const changed = ['src/a.ts', 'docs/b.md', 'data/audit/nobody-registered-me.json', 'src/c.ts'];
  assert.equal(disqualifyingPath(changed, registry), 'data/audit/nobody-registered-me.json');
});

test('an empty or missing CHANGED list is clean — nothing staged disqualifies nothing', () => {
  assert.equal(disqualifyingPath([], registry), null);
  assert.equal(disqualifyingPath(undefined, registry), null);
});

test('a malformed REGISTRY throws rather than answering "clean" — fail closed', () => {
  // The dangerous direction: a registry that loads but stops exporting MANAGED
  // must never read as "nothing is managed", which would let the fallback
  // overlay MANAGED files. Callers turn the throw into a non-zero exit.
  assert.throws(() => disqualifyingPath(['src/a.ts'], {}), /registry\.MANAGED is not an array/);
  assert.throws(() => disqualifyingPath(['src/a.ts'], null), /registry\.MANAGED is not an array/);
  assert.throws(
    () => disqualifyingPath(['src/a.ts'], { MANAGED: [], API_FALLBACK_SAFE: [] }),
    /registry\.API_FALLBACK_MERGE is not an array/
  );
});

// ── CLI-level bypasses closed by -z / --no-renames (adversarial review) ───────
// These pin the git INVOCATION, not just the predicate: both holes lived in how
// the changed-path list was produced, so disqualifyingPath() alone cannot see
// them. Both were reachable in the inline `node -e` version this module
// replaces.
const CLI = new URL('./api-fallback-disqualifier.js', import.meta.url).pathname;

function scratchRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'afd-'));
  const g = (...a) => execFileSync('git', ['-C', dir, ...a], { encoding: 'utf8' });
  g('init', '-q');
  g('config', 'user.email', 't@t.t');
  g('config', 'user.name', 't');
  return { dir, g, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function runCli(dir, base, head) {
  try {
    execFileSync(process.execPath, [CLI, base, head], { cwd: dir, encoding: 'utf8', stdio: 'pipe' });
    return 0;
  } catch (e) {
    return e.status;
  }
}

test('CLI: an unaudited audit path containing a TAB still disqualifies (needs -z)', () => {
  // Without -z git QUOTES this name, and the quoted form no longer
  // startsWith("data/audit/") — the path would read as clean.
  const { dir, g, cleanup } = scratchRepo();
  try {
    g('commit', '-q', '--allow-empty', '-m', 'base');
    const base = g('rev-parse', 'HEAD').trim();
    mkdirSync(join(dir, 'data', 'audit'), { recursive: true });
    writeFileSync(join(dir, 'data', 'audit', 'od\td.json'), '{}\n');
    g('add', '-A');
    g('commit', '-q', '-m', 'tabbed audit file');
    assert.equal(runCli(dir, base, 'HEAD'), 1, 'a quoted path must not read as clean');
  } finally { cleanup(); }
});

test('CLI: renaming shows.json onto a permitted path still disqualifies (needs --no-renames)', () => {
  // With rename detection on, --name-only reports only the DESTINATION, hiding
  // the protected source while the fallback goes on to delete it.
  const { dir, g, cleanup } = scratchRepo();
  try {
    mkdirSync(join(dir, 'data'), { recursive: true });
    writeFileSync(join(dir, 'data', 'shows.json'), JSON.stringify({ pad: 'x'.repeat(4000) }) + '\n');
    g('add', '-A');
    g('commit', '-q', '-m', 'add shows.json');
    const base = g('rev-parse', 'HEAD').trim();
    g('mv', 'data/shows.json', 'docs-note.json');
    g('commit', '-q', '-m', 'rename shows.json away');
    assert.equal(runCli(dir, base, 'HEAD'), 1, 'the protected SOURCE path must still disqualify');
  } finally { cleanup(); }
});

test('CLI: a clean ordinary diff still exits 0 — the fallback stays available', () => {
  const { dir, g, cleanup } = scratchRepo();
  try {
    g('commit', '-q', '--allow-empty', '-m', 'base');
    const base = g('rev-parse', 'HEAD').trim();
    writeFileSync(join(dir, 'notes.md'), 'hello\n');
    g('add', '-A');
    g('commit', '-q', '-m', 'ordinary change');
    assert.equal(runCli(dir, base, 'HEAD'), 0);
  } finally { cleanup(); }
});

test('against the REAL registry: show-review-gap.json is registered, a made-up sibling is not', () => {
  // Pins the two halves of the live BRO-3071 state this fix exists around:
  // the file that caused the incident is now registered, and the 360 files
  // that still are not remain disqualifying.
  assert.equal(disqualifyingPath(['data/audit/show-review-gap.json'], realRegistry), null);
  assert.equal(
    disqualifyingPath(['data/audit/bro-3663-definitely-unregistered.json'], realRegistry),
    'data/audit/bro-3663-definitely-unregistered.json'
  );
});
