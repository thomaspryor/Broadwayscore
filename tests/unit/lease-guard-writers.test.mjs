// BRO-6648 S1-T7: every old-path writer entry point skips a show only while the opening-night lane
// holds it. For each: a leased show writes nothing, an unleased show writes, and with the lease store
// unknown tonight's show waits only when LANE_ONLY_MARKETS covers it (BRO-6672), while another show writes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const guard = require(path.join(ROOT, 'scripts/lib/opening-night-lane/lease-guard.js'));
const { embargoForNight } = require(path.join(ROOT, 'scripts/lib/opening-night-lane/lane-only-markets.js'));
const { writableOpenings, refreshLeases } = require(path.join(ROOT, 'scripts/watch-aggregator-urls.js'));
const { dropLeasedReviews } = require(path.join(ROOT, 'scripts/collect-review-texts.js'));
const { writeReviewFiles } = require(path.join(ROOT, 'scripts/scrape-theatre-reviews.js'));

const TONIGHT = { id: 'tonight-show-2026', category: 'broadway', openingDate: '2026-11-05' };
const LATER = { id: 'later-show-2026', category: 'broadway', openingDate: '2026-12-20' };
const NOW = Date.parse(embargoForNight(TONIGHT, TONIGHT.openingDate)) - 60 * 60000; // an hour before tonight's embargo

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bro6648-writers-'));
const showsFile = path.join(dir, 'shows.json');
fs.writeFileSync(showsFile, JSON.stringify({ shows: [TONIGHT, LATER] }));

// One scenario per lease state; each test sets the env for its writer call.
const SCENARIOS = {
  leased: { leases: { [`${TONIGHT.id}|${TONIGHT.openingDate}`]: { holder: 'lane-gha', acquiredAt: new Date(NOW).toISOString(), heartbeatAt: new Date(NOW).toISOString(), expiresAt: new Date(NOW + 30 * 60000).toISOString() } } },
  unleased: { leases: {} },
  // tonight [] = the guard must recompute it
  unknown: { leases: {}, unknown: true, tonight: [], laneOnly: { ok: true, value: 'broadway' }, at: new Date(NOW).toISOString() },
  unknownShadow: { leases: {}, unknown: true, tonight: [], laneOnly: { ok: true, value: '' }, at: new Date(NOW).toISOString() }, // the Nov 8 hold
};
const files = {};
for (const [k, v] of Object.entries(SCENARIOS)) { files[k] = path.join(dir, `leases-${k}.json`); fs.writeFileSync(files[k], JSON.stringify(v)); }

function withLeases(kind, fn) {
  const prev = { l: process.env.OPENING_NIGHT_LEASES_FILE, s: process.env.OPENING_NIGHT_SHOWS_FILE, h: process.env.OPENING_NIGHT_LANE_HOLDER };
  process.env.OPENING_NIGHT_LEASES_FILE = files[kind];
  process.env.OPENING_NIGHT_SHOWS_FILE = showsFile;
  delete process.env.OPENING_NIGHT_LANE_HOLDER;
  try { return fn({ now: NOW }); } finally {
    for (const [k, e] of [['l', 'OPENING_NIGHT_LEASES_FILE'], ['s', 'OPENING_NIGHT_SHOWS_FILE'], ['h', 'OPENING_NIGHT_LANE_HOLDER']]) {
      if (prev[k] === undefined) delete process.env[e]; else process.env[e] = prev[k];
    }
  }
}

// Each writer reduced to "which of TONIGHT / LATER would it write".
const WRITERS = {
  'shared writableShowIds': (opts) => guard.writableShowIds([TONIGHT.id, LATER.id], { label: 'test', ...opts }),
  'watch-aggregator-urls writableOpenings': (opts) => writableOpenings([TONIGHT, LATER], opts).map((s) => s.id),
  'collect-review-texts dropLeasedReviews': (opts) => [...new Set(dropLeasedReviews([{ showId: TONIGHT.id }, { showId: LATER.id }, { showId: TONIGHT.id }], opts).map((r) => r.showId))],
  'scrape-theatre-reviews writeReviewFiles': (opts) => [TONIGHT.id, LATER.id].filter((id) => !writeReviewFiles([], id, path.join(dir, 'rt'), opts).leased),
};

for (const [name, run] of Object.entries(WRITERS)) {
  test(`${name}: a leased show writes nothing, the other show writes`, () => {
    assert.deepEqual(withLeases('leased', run), [LATER.id]);
  });
  test(`${name}: with no lease every show writes`, () => {
    assert.deepEqual(withLeases('unleased', run), [TONIGHT.id, LATER.id]);
  });
  test(`${name}: lease store unknown and LANE_ONLY_MARKETS covers tonight's show: it waits while another show writes`, () => {
    assert.deepEqual(withLeases('unknown', run), [LATER.id]);
  });
  test(`${name}: lease store unknown and LANE_ONLY_MARKETS unset (shadow): every show writes`, () => {
    assert.deepEqual(withLeases('unknownShadow', run), [TONIGHT.id, LATER.id]);
  });
}

test('the lane holder itself is not blocked by its own lease', () => {
  process.env.OPENING_NIGHT_LANE_HOLDER = 'lane-gha';
  try {
    process.env.OPENING_NIGHT_LEASES_FILE = files.leased;
    assert.deepEqual(guard.writableShowIds([TONIGHT.id], { now: NOW }), [TONIGHT.id]);
  } finally { delete process.env.OPENING_NIGHT_LANE_HOLDER; delete process.env.OPENING_NIGHT_LEASES_FILE; }
});

test('scrape-theatre-reviews: a held show keeps its rows as refused, so coverage still reports them missing', () => {
  const rows = [{ outlet: 'The Guardian', critic: 'A Critic' }];
  const res = withLeases('leased', (opts) => writeReviewFiles(rows, TONIGHT.id, path.join(dir, 'rt'), opts));
  assert.equal(res.created + res.updated, 0);
  assert.deepEqual(res.outcomes.map((o) => [o.action, o.outlet, o.critic]), [['skipped', 'The Guardian', 'A Critic']]);
  assert.ok(!fs.existsSync(path.join(dir, 'rt', TONIGHT.id)), 'nothing written under the held show');
});

test('watch-aggregator-urls loop: lease state is re-fetched at most every 5 minutes, and a failed fetch is survivable', () => {
  let calls = 0, marked = 0;
  const run = () => { calls++; };
  const markUnknown = () => { marked++; };
  const t0 = Date.now() + 10 * 60000;
  assert.equal(refreshLeases({ now: t0, run, markUnknown }), true);
  assert.equal(refreshLeases({ now: t0 + 60000, run, markUnknown }), false);
  assert.equal(marked, 0);
  assert.equal(refreshLeases({ now: t0 + 6 * 60000, run: () => { calls++; throw new Error('killed'); }, markUnknown }), true);
  assert.equal(calls, 2);
  assert.equal(marked, 1, 'a failed re-sync falls back to the unknown marker, not a stale known state');
});

test('markUnknown writes the marker the guard reads: covered tonight waits, unread variable writes everything', () => {
  const env = { OPENING_NIGHT_SHOWS_FILE: showsFile };
  const f = path.join(dir, 'leases-marked.json');
  assert.deepEqual(guard.markUnknown({ file: f, now: NOW, env, laneOnly: { ok: true, value: 'broadway' } }), { tonight: [TONIGHT.id], held: [TONIGHT.id] });
  assert.equal(JSON.parse(fs.readFileSync(f, 'utf8')).unknown, true);
  assert.deepEqual(guard.writableShowIds([TONIGHT.id, LATER.id], { file: f, now: NOW, env }), [LATER.id]);
  // No job env and no REVIEW_TEXTS_TOKEN: the variable is unread, so nothing waits.
  assert.deepEqual(guard.markUnknown({ file: f, now: NOW, env }), { tonight: [TONIGHT.id], held: [] });
  assert.deepEqual(JSON.parse(fs.readFileSync(f, 'utf8')).laneOnly, { ok: false, value: '' });
  assert.deepEqual(guard.writableShowIds([TONIGHT.id, LATER.id], { file: f, now: NOW, env }), [TONIGHT.id, LATER.id]);
});

test('skip lines go to stderr: --list-active stdout (read by the orchestrator) stays empty when every show is held', () => {
  const out = [];
  const orig = console.log;
  console.log = (...a) => out.push(a.join(' '));
  try { assert.deepEqual(withLeases('leased', (opts) => writableOpenings([TONIGHT], opts)), []); } finally { console.log = orig; }
  assert.deepEqual(out, []);
});

test('sync action: a crashed sync writes the unknown marker instead of leaving no file', () => {
  const a = fs.readFileSync(path.join(ROOT, '.github/actions/opening-night-lease-sync/action.yml'), 'utf8');
  assert.match(a, /if ! node "\$GITHUB_WORKSPACE\/scripts\/opening-night-lease\.js" sync; then/);
  assert.match(a, /markUnknown\(\)/);
});

// Entry points whose filter runs inside main() (or a TS module): the call to the shared guard is checked in source.
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
test('source: the remaining writer entry points filter through the shared guard before writing', () => {
  const idx = read('scripts/llm-scoring/index.ts');
  assert.match(idx, /require\('\.\.\/lib\/opening-night-lane\/lease-guard'\)/);
  assert.match(idx, /const allFiles = dropLeasedFiles\(everyFile\)/, 'llm-scoring drops leased shows from the batch');
  assert.match(idx, /for \(const f of everyFile\)/, 'global counts still cover every file');
  assert.match(read('scripts/recollect-for-scores.js'), /const showDirs = writableShowIds\(listShowDirs\(REVIEW_DIR\)/);
  const disc = read('scripts/discover-opening-night-reviews.js');
  assert.ok(disc.indexOf("writableShowIds([showId], { label: 'discover' })") > disc.indexOf('const showId = show.id || show.slug;'), 'discover returns before any work on a held show');
  const lbo = read('scripts/scrape-london-box-office-roundups.js');
  assert.ok(lbo.indexOf("label: 'lbo'") > 0 && lbo.indexOf("label: 'lbo'") < lbo.indexOf('// Process each matched roundup'), 'LBO filters both lists before processing');
  const col = read('scripts/collect-review-texts.js');
  const dropAt = col.indexOf('const kept = dropLeasedReviews(reviews)');
  assert.ok(dropAt > 0 && dropAt < col.indexOf('promoteAgedStubs(reviews)', col.indexOf('reviews.sort((a, b) => compareReviewPriority')), 'collect drops held reviews before the reserved slices and caps');
  const ing = read('scripts/ingest-urls.js');
  const ingAt = ing.indexOf("writableShowIds([showId], { label: 'ingest-urls' })");
  assert.ok(ingAt > ing.indexOf('Show not found') && ingAt < ing.indexOf('createOrMergeReviewFile(showId'), 'ingest-urls returns before writing a held show (it commits itself, so push-time enforce cannot undo it)');
  const cp = col.slice(col.indexOf('function pushReviewTextsCheckpoint'));
  const cpEnforce = cp.indexOf('enforce --dir=');
  assert.ok(cpEnforce > 0 && cpEnforce < cp.indexOf("execSync('git add -A'"), 'the mid-run checkpoint commit enforces the lease before staging');
  const watch = read('scripts/watch-aggregator-urls.js');
  assert.match(watch, /for \(const show of writableOpenings\(openings\)\)/, 'each watcher pass re-reads the guard');
  assert.match(watch, /writableOpenings\(openings\)\.map\(s => s\.id\)\.join/, '--list-active (the orchestrator dispatch list) leaves held shows out');
});

test('land-ingested-reviews pushReviewTexts: a held show (fan-out sibling) is reverted and not committed, the free show is', async () => {
  const { execSync } = await import('node:child_process');
  const { pushReviewTexts } = require(path.join(ROOT, 'scripts/lib/land-ingested-reviews.js'));
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'bro6648-rt-'));
  const git = (c) => execSync(`git -C "${repo}" ${c}`, { encoding: 'utf8' });
  git('init -q -b main'); git('config user.email t@t'); git('config user.name t');
  fs.writeFileSync(path.join(repo, 'README'), 'x'); git('add -A'); git('commit -qm init');
  const touched = [TONIGHT.id, LATER.id].map((id) => {
    fs.mkdirSync(path.join(repo, id)); const f = path.join(repo, id, 'outlet--critic.json'); fs.writeFileSync(f, '{}'); return f;
  });
  let pushed = 0;
  const res = withLeases('leased', ({ now }) => pushReviewTexts({
    reviewTextsDir: repo, touchedPaths: touched, message: 'test', exec: execSync, log: () => {},
    isCheckout: () => true, pushRetry: () => { pushed++; return { ok: true }; },
    leaseRevert: (dir) => guard.revertLeasedChanges(dir, guard.revertableShowIds({ now }).revert),
  }));
  assert.equal(res.pushed, true);
  assert.equal(pushed, 1);
  assert.deepEqual(git('show --name-only --format= HEAD').trim().split('\n'), [`${LATER.id}/outlet--critic.json`]);
  assert.ok(!fs.existsSync(touched[0]), 'the held show file is removed, not left for a later commit');
});

test('land-ingested-reviews: the real exec path checks the lease by default', () => {
  const src = read('scripts/lib/land-ingested-reviews.js');
  assert.match(src, /leaseRevert = exec === execSync \? revertHeldShows/);
  assert.ok(src.indexOf('leaseRevert(reviewTextsDir)') < src.indexOf('add -A -- ${q}'));
});
