// scripts/lib/sync-audit-checkout.test.mjs — BRO-2314.
//
// The gate at scripts/lib/sync-audit-checkout.sh refused every run for six
// days (2026-08-20 → 2026-08-26) and parked com.broadwayscore.predispatch-
// queue-audit, because ff-only was permanently blocked by dirty append-only
// data/audit/*.jsonl ledgers that CI also moves on origin/main.
//
// Two things are under test:
//   * the pure decision layer, require()d from scripts/lib/sync-audit-decision.js
//     rather than restated here (CLAUDE.md rule 15) — production changes break
//     these tests, which is the point;
//   * the REAL shell script, driven against throwaway bare-origin + clone
//     pairs, so "the sync completes and no refusal snapshot is written" is
//     proven end to end rather than inferred.
//
// The pre-existing scripts/lib/sync-audit-checkout.test.sh keeps its own
// coverage of the clean / regenerable-reset / diverged / untracked shapes and
// needs no assertion inverted: its dirty-jsonl case uses
// data/audit/score-history.jsonl, which is NOT declared merge=union, so
// refusing it is still correct behaviour.
//
// Run: node --test scripts/lib/sync-audit-checkout.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const LIB = path.join(HERE, 'sync-audit-checkout.sh');
const {
  ffBlockingPaths, classifyBlock, unionLedgerLines, stripTornTrailingLine, unionIsSafe,
} = require(path.join(HERE, 'sync-audit-decision.js'));

// Deliberately FIXTURE names, not the real data/audit/stage-latency.jsonl and
// score-history.jsonl. These paths are only ever written inside a mkdtemp
// throwaway clone, but scripts/test-data-write-guard.js (rightly) refuses to
// distinguish that from a write to the real tracked file — a test naming a
// real tracked data path is the exact hazard tasks #1649/#1662 exist for. The
// realism these tests need comes from the .jsonl extension plus the
// merge=union attribute, never from the filename, so fixture names cost
// nothing. Do not "restore" the real names.
const LEDGER = 'data/audit/fixture-union-ledger.jsonl';       // merge=union
const PLAIN_LEDGER = 'data/audit/fixture-plain-ledger.jsonl'; // NO union attribute
const GITATTRS = `${LEDGER} merge=union\n`;

// ── pure decision layer ──────────────────────────────────────────────────────

test('ffBlockingPaths keeps only dirty paths origin/main actually moves', () => {
  // The live bug: two unrelated untracked job outputs made the classifier
  // report "dirty-outside-audit" while the real blockers were the ledgers.
  const blocking = ffBlockingPaths({
    dirtyPaths: [
      'data/audit/scraper-spend-ledger.jsonl',
      'data/audit/stage-latency.jsonl',
      'data/newsletter-drafts/sunday-review-20260823-0900.log',
      'data/opening-night-monitor/attempt-14-noop.json',
    ],
    originChangedPaths: [
      'data/audit/scraper-spend-ledger.jsonl',
      'data/audit/stage-latency.jsonl',
      'public/data/shows/schmigadoon-2026.json',
    ],
  });
  assert.deepEqual(blocking, [
    'data/audit/scraper-spend-ledger.jsonl',
    'data/audit/stage-latency.jsonl',
  ]);
});

test('ffBlockingPaths keeps an untracked path origin ADDS (it does block ff-only)', () => {
  assert.deepEqual(
    ffBlockingPaths({ dirtyPaths: ['brand-new.txt'], originChangedPaths: ['brand-new.txt'] }),
    ['brand-new.txt'],
  );
});

test('classifyBlock names the real blocker, not the first non-data/audit path', () => {
  const d = classifyBlock({
    blockingPaths: [PLAIN_LEDGER],
    aheadCount: 0,
    unionMergePaths: [],
  });
  assert.equal(d.action, 'refuse');
  assert.equal(d.reason, 'dirty-jsonl-ledger', 'a dirty non-union ledger is the blocker, so say so');
});

test('classifyBlock routes an all-union blocker set to recovery', () => {
  const paths = ['data/audit/stage-latency.jsonl', 'data/audit/scraper-spend-ledger.jsonl'];
  const d = classifyBlock({ blockingPaths: paths, aheadCount: 0, unionMergePaths: paths });
  assert.equal(d.action, 'union-recover');
  assert.deepEqual(d.unionPaths, paths);
});

test('classifyBlock refuses when even one blocker is not union-safe', () => {
  const d = classifyBlock({
    blockingPaths: ['data/audit/stage-latency.jsonl', 'other.txt'],
    aheadCount: 0,
    unionMergePaths: ['data/audit/stage-latency.jsonl'],
  });
  assert.equal(d.action, 'refuse');
  assert.equal(d.reason, 'dirty-outside-audit');
});

test('classifyBlock refuses a diverged checkout even when the blocker is union-safe', () => {
  // A local commit origin lacks cannot be fixed by a union, and entering the
  // recovery stage would truncate a live ledger for a merge that then fails.
  const paths = ['data/audit/stage-latency.jsonl'];
  const d = classifyBlock({ blockingPaths: paths, aheadCount: 1, unionMergePaths: paths });
  assert.equal(d.action, 'refuse');
  assert.equal(d.reason, 'diverged');
});

test('classifyBlock reports diverged when nothing dirty overlaps origin', () => {
  const d = classifyBlock({ blockingPaths: [], aheadCount: 0, unionMergePaths: [] });
  assert.equal(d.reason, 'diverged');
});

test('unionLedgerLines puts origin first and local-only rows last (rotation trims the front)', () => {
  const { merged, stats } = unionLedgerLines(['a', 'b', 'c'], ['b', 'c', 'local']);
  assert.deepEqual(merged, ['a', 'b', 'c', 'local']);
  assert.equal(stats.added, 1);
});

test('unionLedgerLines keeps an identical row appended on both sides exactly once', () => {
  const { merged } = unionLedgerLines(['x', 'same'], ['same']);
  assert.deepEqual(merged, ['x', 'same']);
});

test('unionLedgerLines never drops a row from either side (superset guarantee)', () => {
  const origin = ['o1', 'o2'];
  const local = ['l1', 'l2'];
  const { merged } = unionLedgerLines(origin, local);
  for (const l of [...origin, ...local]) assert.ok(merged.includes(l), `${l} survived`);
});

test('stripTornTrailingLine drops a half-written last row, keeps a clean one', () => {
  const good = ['{"a":1}', '{"b":2}'];
  assert.equal(stripTornTrailingLine(good).dropped, null);
  const torn = ['{"a":1}', '{"b":2}', '{"c":'];
  const r = stripTornTrailingLine(torn);
  assert.equal(r.dropped, '{"c":');
  assert.deepEqual(r.lines, good);
});

test('stripTornTrailingLine leaves a ledger that is legitimately not JSON alone', () => {
  const plain = ['hello', 'world'];
  assert.equal(stripTornTrailingLine(plain).dropped, null);
  assert.deepEqual(stripTornTrailingLine(plain).lines, plain);
});

test('unionIsSafe rejects a merge that would shrink either side', () => {
  assert.equal(unionIsSafe({ mergedCount: 5, baseCount: 4, extraCount: 5 }), true);
  assert.equal(unionIsSafe({ mergedCount: 3, baseCount: 4, extraCount: 1 }), false);
});

// ── integration: the real shell script ───────────────────────────────────────

function git(dir, ...args) {
  return execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' });
}

function setupPair(root, name, { attributes = GITATTRS, ledgerLines = ['a', 'b', 'c'] } = {}) {
  // mkdtempSync HERE, not path.join off a parameter: scripts/test-data-write-
  // guard.js traces a write target back to a tmp base by static analysis, and
  // it cannot follow a directory handed in as a function argument. Rooting the
  // pair in its own mkdtemp makes every write below provably temp-scoped —
  // which it always was, just not visibly to the guard.
  const base = fs.mkdtempSync(path.join(root, `${name}-`));
  const origin = path.join(base, 'origin');
  const clone = path.join(base, 'clone');
  execFileSync('git', ['init', '-q', '--bare', origin]);
  execFileSync('git', ['init', '-q', '-b', 'main', clone]);
  git(clone, 'config', 'user.email', 't@t.t');
  git(clone, 'config', 'user.name', 't');
  fs.mkdirSync(path.join(clone, 'data', 'audit'), { recursive: true });
  if (attributes) fs.writeFileSync(path.join(clone, '.gitattributes'), attributes);
  fs.writeFileSync(path.join(clone, LEDGER), ledgerLines.join('\n') + '\n');
  fs.writeFileSync(path.join(clone, 'other.txt'), 'hello\n');
  git(clone, 'add', '-A');
  git(clone, 'commit', '-q', '-m', 'init');
  git(clone, 'remote', 'add', 'origin', origin);
  git(clone, 'push', '-q', 'origin', 'main');
  return { origin, clone };
}

// Advance origin by one commit, as CI would. `mutate` receives the staging
// clone's path and writes whatever that commit should contain.
function advanceOrigin(root, origin, tmpName, mutate) {
  const via = path.join(root, tmpName);
  execFileSync('git', ['init', '-q', via]);
  git(via, 'config', 'user.email', 'ci@ci.ci');
  git(via, 'config', 'user.name', 'ci');
  git(via, 'remote', 'add', 'origin', origin);
  git(via, 'fetch', '-q', 'origin', 'main');
  git(via, 'checkout', '-q', 'main');
  mutate(via);
  git(via, 'add', '-A');
  git(via, 'commit', '-q', '-m', 'ci: advance');
  git(via, 'push', '-q', 'origin', 'main');
  fs.rmSync(via, { recursive: true, force: true });
}

function runSync(clone, tag) {
  const res = execFileSync('bash', [LIB, clone], {
    encoding: 'utf8',
    env: { ...process.env, SYNC_TAG: tag },
  });
  return res;
}

function trySync(clone, tag) {
  try {
    return { code: 0, out: runSync(clone, tag) };
  } catch (e) {
    return { code: e.status ?? 1, out: `${e.stdout || ''}${e.stderr || ''}` };
  }
}

const lines = (p) => fs.readFileSync(p, 'utf8').split('\n').filter(Boolean);
const count = (arr, v) => arr.filter((x) => x === v).length;

function withTmp(fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-audit-'));
  try { return fn(root); } finally { fs.rmSync(root, { recursive: true, force: true }); }
}

test('ACCEPTANCE: a dirty merge=union ledger that origin also moved no longer parks the job', () => {
  withTmp((root) => {
    const { origin, clone } = setupPair(root, 'acc');
    advanceOrigin(root, origin, 'via-acc', (via) => {
      fs.writeFileSync(path.join(via, LEDGER), 'a\nb\nc\norigin-only\n');
      fs.writeFileSync(path.join(via, 'scripts.txt'), 'new code from origin\n');
    });
    // Another job's in-flight append, uncommitted — the condition parking the
    // real job today.
    fs.appendFileSync(path.join(clone, LEDGER), 'local-only\n');

    const { code, out } = trySync(clone, 'acc');
    assert.equal(code, 0, `expected the sync to complete, got ${code}:\n${out}`);
    assert.equal(
      git(clone, 'rev-parse', 'HEAD').trim(),
      git(clone, 'rev-parse', 'origin/main').trim(),
      'the checkout must actually be on origin/main — the whole point of the gate',
    );
    assert.equal(
      fs.existsSync(path.join(clone, 'data/audit/sync-refused-acc.json')), false,
      'no sync-refused snapshot may be written for a run that recovered',
    );

    const after = lines(path.join(clone, LEDGER));
    assert.equal(count(after, 'local-only'), 1, "the other job's append survived, exactly once");
    assert.equal(count(after, 'origin-only'), 1, "origin's committed append survived, exactly once");
    assert.ok(
      after.indexOf('origin-only') < after.indexOf('local-only'),
      'origin rows first: both ledgers rotate by trimming the FRONT, so local rows must sit at the end',
    );
    assert.equal(
      fs.readFileSync(path.join(clone, 'scripts.txt'), 'utf8'), 'new code from origin\n',
      'the code the job was about to run on is now fresh',
    );
  });
});

test('a locally ROTATED ring-buffer ledger still recovers, losing no live row', () => {
  withTmp((root) => {
    // scraper-spend-ledger.jsonl is a ring buffer (provider-telemetry.js:69
    // keeps the newest tail), so the local copy is NOT an append-superset of
    // HEAD — it has dropped HEAD's oldest rows. A prefix-based union would
    // have refused here.
    const { origin, clone } = setupPair(root, 'rot', { ledgerLines: ['a', 'b', 'c', 'd'] });
    advanceOrigin(root, origin, 'via-rot', (via) => {
      fs.writeFileSync(path.join(via, LEDGER), 'a\nb\nc\nd\norigin-only\n');
    });
    fs.writeFileSync(path.join(clone, LEDGER), 'c\nd\nlocal-new\n'); // rotated: a,b dropped

    const { code, out } = trySync(clone, 'rot');
    assert.equal(code, 0, `expected recovery, got ${code}:\n${out}`);
    const after = lines(path.join(clone, LEDGER));
    for (const l of ['c', 'd', 'local-new', 'origin-only']) {
      assert.equal(count(after, l), 1, `${l} present exactly once`);
    }
  });
});

test('an identical row appended on BOTH sides is kept exactly once', () => {
  withTmp((root) => {
    const { origin, clone } = setupPair(root, 'dup');
    advanceOrigin(root, origin, 'via-dup', (via) => {
      fs.writeFileSync(path.join(via, LEDGER), 'a\nb\nc\nboth\n');
    });
    fs.writeFileSync(path.join(clone, LEDGER), 'a\nb\nc\nboth\nlocal\n');
    const { code, out } = trySync(clone, 'dup');
    assert.equal(code, 0, out);
    const after = lines(path.join(clone, LEDGER));
    assert.equal(count(after, 'both'), 1);
    assert.equal(count(after, 'local'), 1);
  });
});

test('a ledger with no trailing newline is not glued into one corrupt row', () => {
  withTmp((root) => {
    const { origin, clone } = setupPair(root, 'nl');
    advanceOrigin(root, origin, 'via-nl', (via) => {
      fs.writeFileSync(path.join(via, LEDGER), '{"a":1}\n{"o":2}'); // no trailing \n
    });
    fs.writeFileSync(path.join(clone, LEDGER), '{"a":1}\n{"l":3}'); // no trailing \n
    const { code, out } = trySync(clone, 'nl');
    assert.equal(code, 0, out);
    const raw = fs.readFileSync(path.join(clone, LEDGER), 'utf8');
    assert.ok(raw.endsWith('\n'), 'restored ledger ends with a newline');
    for (const l of raw.split('\n').filter(Boolean)) {
      assert.doesNotThrow(() => JSON.parse(l), `row "${l}" is still valid JSON`);
    }
  });
});

test('the refusal snapshot names the file that actually blocked ff-only', () => {
  withTmp((root) => {
    // A dirty NON-union ledger blocks; an unrelated untracked file origin
    // never adds does not. The old classifier reported the latter.
    const { origin, clone } = setupPair(root, 'reason');
    fs.writeFileSync(path.join(clone, PLAIN_LEDGER), '{"ts":1}\n');
    git(clone, 'add', '-A');
    git(clone, 'commit', '-q', '-m', 'add score-history');
    git(clone, 'push', '-q', 'origin', 'main');
    advanceOrigin(root, origin, 'via-reason', (via) => {
      fs.writeFileSync(path.join(via, PLAIN_LEDGER), '{"ts":1}\n{"ts":2}\n');
    });
    fs.writeFileSync(path.join(clone, PLAIN_LEDGER), '{"ts":1}\n{"ts":"local"}\n');
    fs.writeFileSync(path.join(clone, 'unrelated-job-output.log'), 'noise\n');

    const { code } = trySync(clone, 'reason');
    assert.equal(code, 1, 'a non-union dirty ledger must still refuse');
    const snap = JSON.parse(fs.readFileSync(path.join(clone, 'data/audit/sync-refused-reason.json'), 'utf8'));
    assert.equal(snap.reason, 'dirty-jsonl-ledger', `misclassified as ${snap.reason}`);
    assert.deepEqual(snap.blockingFiles, [PLAIN_LEDGER]);
    assert.ok(
      snap.dirtyFiles.includes('unrelated-job-output.log'),
      'the full dirty list is still reported, it just no longer drives the reason',
    );
    assert.equal(
      fs.readFileSync(path.join(clone, PLAIN_LEDGER), 'utf8'),
      '{"ts":1}\n{"ts":"local"}\n',
      'the refused ledger is never touched',
    );
  });
});

test('a dirty union ledger origin did NOT move never enters the recovery stage', () => {
  withTmp((root) => {
    // The dangerous path (briefly cleaning a live ledger) must only be reached
    // when it is genuinely the thing blocking the merge.
    const { origin, clone } = setupPair(root, 'notouch');
    advanceOrigin(root, origin, 'via-notouch', (via) => {
      fs.writeFileSync(path.join(via, 'other.txt'), 'v2\n');
    });
    fs.writeFileSync(path.join(clone, LEDGER), 'a\nb\nc\nlocal-only\n');
    const { code, out } = trySync(clone, 'notouch');
    assert.equal(code, 0, out);
    assert.ok(!/recovering/.test(out), `plain ff-only should have handled this:\n${out}`);
    assert.equal(
      fs.readFileSync(path.join(clone, LEDGER), 'utf8'), 'a\nb\nc\nlocal-only\n',
      'the ledger was carried across untouched',
    );
  });
});

test('an orphaned backup from a killed run is drained back into the ledger', () => {
  withTmp((root) => {
    const { clone } = setupPair(root, 'orphan');
    // Simulate a run killed between "clean the ledger" and "union it back":
    // the local rows exist only in the backup. PID 999999 is not running, so
    // the backup counts as orphaned.
    const backupDir = path.join(clone, '.git', 'sync-ledger-backups');
    fs.mkdirSync(backupDir, { recursive: true });
    const flat = LEDGER.replaceAll('/', '%');
    fs.writeFileSync(path.join(backupDir, `${flat}.999999.bak`), 'a\nb\nc\nrescued-row\n');

    const { code, out } = trySync(clone, 'orphan');
    assert.equal(code, 0, out);
    const after = lines(path.join(clone, LEDGER));
    assert.equal(count(after, 'rescued-row'), 1, 'the killed run\'s row came back');
    assert.equal(
      fs.readdirSync(backupDir).filter((f) => f.endsWith('.bak')).length, 0,
      'a drained backup is removed so it is not re-applied forever',
    );
  });
});

test('a backup owned by a LIVE process is left alone (concurrent instances)', () => {
  withTmp((root) => {
    // push_mutex_acquire fails open, so two gate instances really can overlap.
    // Draining a running instance's backup would delete the only copy of its
    // local rows while it is still mid-merge.
    const { clone } = setupPair(root, 'live');
    const backupDir = path.join(clone, '.git', 'sync-ledger-backups');
    fs.mkdirSync(backupDir, { recursive: true });
    const flat = LEDGER.replaceAll('/', '%');
    const bak = path.join(backupDir, `${flat}.${process.pid}.bak`);
    fs.writeFileSync(bak, 'a\nb\nc\nnot-mine\n');

    const { code, out } = trySync(clone, 'live');
    assert.equal(code, 0, out);
    assert.ok(fs.existsSync(bak), "a live owner's backup must survive");
    assert.equal(
      count(lines(path.join(clone, LEDGER)), 'not-mine'), 0,
      "and must not be merged into the ledger behind the owner's back",
    );
  });
});

// ── hardening added after the pre-ship adversarial review ────────────────────

test('a backup naming an UNTRACKED path is never written (filename is untrusted input)', () => {
  withTmp((root) => {
    const { clone } = setupPair(root, 'evil');
    const backupDir = path.join(clone, '.git', 'sync-ledger-backups');
    fs.mkdirSync(backupDir, { recursive: true });
    // A stale or hand-dropped .bak can name any repo-relative path; the drain
    // must not turn that into a write.
    fs.writeFileSync(path.join(backupDir, `${'other-untracked.txt'.replaceAll('/', '%')}.999999.bak`), 'pwned\n');

    const { code, out } = trySync(clone, 'evil');
    assert.equal(code, 0, out);
    assert.equal(fs.existsSync(path.join(clone, 'other-untracked.txt')), false, 'no file created');
    assert.match(out, /untracked path/, 'and it says why it refused');
  });
});

test('a backup whose path lost its merge=union attribute is not unioned', () => {
  withTmp((root) => {
    // score-history.jsonl is tracked here but has no union attribute, so
    // concatenating both sides is no longer a sanctioned resolution for it.
    const { clone } = setupPair(root, 'noattr');
    fs.writeFileSync(path.join(clone, PLAIN_LEDGER), '{"ts":1}\n');
    git(clone, 'add', '-A');
    git(clone, 'commit', '-q', '-m', 'add score-history');
    const backupDir = path.join(clone, '.git', 'sync-ledger-backups');
    fs.mkdirSync(backupDir, { recursive: true });
    fs.writeFileSync(
      path.join(backupDir, `${PLAIN_LEDGER.replaceAll('/', '%')}.999999.bak`),
      '{"ts":1}\n{"ts":"injected"}\n',
    );

    const { code, out } = trySync(clone, 'noattr');
    assert.equal(code, 0, out);
    assert.equal(
      fs.readFileSync(path.join(clone, PLAIN_LEDGER), 'utf8'), '{"ts":1}\n',
      'the non-union ledger was left exactly as it was',
    );
    assert.match(out, /no longer merge=union/);
  });
});

test('PID reuse cannot strand a backup forever (age fallback)', () => {
  withTmp((root) => {
    // A recovery lasts seconds. A backup older than an hour whose PID now
    // resolves to some unrelated long-lived process must still be drained.
    const { clone } = setupPair(root, 'pidreuse');
    const backupDir = path.join(clone, '.git', 'sync-ledger-backups');
    fs.mkdirSync(backupDir, { recursive: true });
    const bak = path.join(backupDir, `${LEDGER.replaceAll('/', '%')}.${process.pid}.bak`);
    fs.writeFileSync(bak, 'a\nb\nc\nstranded-row\n');
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
    fs.utimesSync(bak, twoHoursAgo, twoHoursAgo);

    const { code, out } = trySync(clone, 'pidreuse');
    assert.equal(code, 0, out);
    assert.equal(count(lines(path.join(clone, LEDGER)), 'stranded-row'), 1, 'the row came back');
  });
});

test('a STAGED ledger is still staged after recovery (checkout HEAD -- clears the index)', () => {
  withTmp((root) => {
    const { origin, clone } = setupPair(root, 'staged');
    advanceOrigin(root, origin, 'via-staged', (via) => {
      fs.writeFileSync(path.join(via, LEDGER), 'a\nb\nc\norigin-only\n');
    });
    fs.appendFileSync(path.join(clone, LEDGER), 'local-only\n');
    git(clone, 'add', '--', LEDGER); // another session staged it

    const { code, out } = trySync(clone, 'staged');
    assert.equal(code, 0, out);
    assert.notEqual(
      git(clone, 'diff', '--cached', '--name-only').trim(), '',
      "the gate must not silently unstage another session's staged ledger",
    );
    assert.equal(count(lines(path.join(clone, LEDGER)), 'local-only'), 1);
  });
});

test('merge=union alone is not enough — a non-jsonl union path is never recovered', () => {
  withTmp((root) => {
    // .gitattributes marks tests/unit-test-manifest.txt merge=union too, and
    // unioning a manifest RESURRECTS a line origin deliberately deleted. Only
    // append-only *.jsonl ledgers belong in the recovery stage.
    const MANIFEST = 'unit-test-manifest.txt';
    const { origin, clone } = setupPair(root, 'manifest', {
      attributes: `${LEDGER} merge=union\n${MANIFEST} merge=union\n`,
    });
    fs.writeFileSync(path.join(clone, MANIFEST), 'keep-a\ndelete-me\n');
    git(clone, 'add', '-A'); git(clone, 'commit', '-q', '-m', 'add manifest');
    git(clone, 'push', '-q', 'origin', 'main');
    advanceOrigin(root, origin, 'via-manifest', (via) => {
      fs.writeFileSync(path.join(via, MANIFEST), 'keep-a\n'); // origin DELETED a line
    });
    fs.writeFileSync(path.join(clone, MANIFEST), 'keep-a\ndelete-me\nlocal\n');

    const { code } = trySync(clone, 'manifest');
    assert.equal(code, 1, 'a non-jsonl union file must refuse, not be unioned');
    assert.equal(
      fs.readFileSync(path.join(clone, MANIFEST), 'utf8'), 'keep-a\ndelete-me\nlocal\n',
      'and it is left untouched — no resurrection of the deleted line',
    );
  });
});

test('a day-old backup is parked, not replayed into a rotating ledger', () => {
  withTmp((root) => {
    // Rotation keeps the newest tail; appending day-old rows would make rows
    // rotation already discarded the "newest" and displace genuinely newer ones.
    const { clone } = setupPair(root, 'stale');
    const backupDir = path.join(clone, '.git', 'sync-ledger-backups');
    fs.mkdirSync(backupDir, { recursive: true });
    const bak = path.join(backupDir, `${LEDGER.replaceAll('/', '%')}.999999.bak`);
    fs.writeFileSync(bak, 'a\nb\nc\nancient-row\n');
    const twoDaysAgo = new Date(Date.now() - 48 * 60 * 60 * 1000);
    fs.utimesSync(bak, twoDaysAgo, twoDaysAgo);

    const { code, out } = trySync(clone, 'stale');
    assert.equal(code, 0, out);
    assert.equal(count(lines(path.join(clone, LEDGER)), 'ancient-row'), 0, 'not replayed');
    assert.equal(fs.existsSync(`${bak}.stale`), true, 'parked, not destroyed');
    assert.equal(fs.existsSync(bak), false, 'and not re-tried every run');
  });
});

test('if the recovery stage cannot even start, the ledger is never truncated', () => {
  withTmp((root) => {
    // Force BACKUP_OK=0 by making the backup directory un-creatable (a plain
    // file sits where the dir must go). This is the rollback/refuse branch:
    // the promise is that no ledger is left cleaned-but-unrestored.
    const { origin, clone } = setupPair(root, 'nobackup');
    advanceOrigin(root, origin, 'via-nobackup', (via) => {
      fs.writeFileSync(path.join(via, LEDGER), 'a\nb\nc\norigin-only\n');
    });
    fs.appendFileSync(path.join(clone, LEDGER), 'local-only\n');
    fs.writeFileSync(path.join(clone, '.git', 'sync-ledger-backups'), 'not a directory\n');

    const { code } = trySync(clone, 'nobackup');
    assert.equal(code, 1, 'must refuse rather than proceed without a backup');
    assert.equal(
      fs.readFileSync(path.join(clone, LEDGER), 'utf8'), 'a\nb\nc\nlocal-only\n',
      'the ledger is exactly as it was — never cleaned, never truncated',
    );
  });
});

test("the recovery label 'dirty-union-ledger' can never reach a refusal snapshot", () => {
  // classifyBlock only ever pairs that reason with the union-recover action,
  // and the shell forces REASON=dirty-unresolved on both exits of the recovery
  // block — so the digest can never render a reason nobody has copy for.
  const paths = ['data/audit/stage-latency.jsonl'];
  const d = classifyBlock({ blockingPaths: paths, aheadCount: 0, unionMergePaths: paths });
  assert.equal(d.reason, 'dirty-union-ledger');
  assert.equal(d.action, 'union-recover', 'that reason is a RECOVERY label, never a refusal');
  for (const ahead of [1, 2]) {
    assert.notEqual(
      classifyBlock({ blockingPaths: paths, aheadCount: ahead, unionMergePaths: paths }).reason,
      'dirty-union-ledger',
    );
  }
});
