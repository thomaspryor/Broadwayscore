// BRO-8236: urgent deploy triggers ship now only on a visitor-visible reveal.
// Fixtures are real public/data/shows files from poller commit 15785a08d:
// sweeney-todd cs 79.65 -> 79.42 (displays 80 -> 79, a reveal) and
// be-more-chill cs 66.27 -> 65.67 (displays 66 both times, not a reveal).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { reviewProjection, classifyReveal, resolveUrgency, classifyRange, openingIdsFrom, nytPicksChanged, isShowFile, MAX_SHOW_FILES, MAX_ANY_SHOW_FILES } = require('./deploy-reveal.js');
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const { CODE_PATHS, URGENT_SOURCES, ALWAYS_SHIP_SOURCES, isUrgent, isAlwaysShip, decide } = require('./should-deploy-gate.js');

const fx = (n) => fs.readFileSync(new URL(`../../tests/fixtures/deploy-reveal/${n}.json`, import.meta.url), 'utf8');
const SHOW = 'public/data/shows/x.json';
const readOf = (before, after) => () => ({ before, after });

test('rounded critic score change is a reveal (sweeney-todd 80 -> 79)', () => {
  const r = classifyReveal([SHOW], readOf(fx('sweeney-before'), fx('sweeney-after')));
  assert.equal(r.reveal, true);
  assert.equal(r.reason, 'reviews-changed');
});

test('sub-integer score drift is not a reveal (be-more-chill 66.27 -> 65.67)', () => {
  const r = classifyReveal([SHOW], readOf(fx('bmc-before'), fx('bmc-after')));
  assert.equal(r.reveal, false);
});

test('new review, changed score, changed verdict, or count are reveals', () => {
  const b = JSON.parse(fx('bmc-before'));
  const mut = (f) => { const a = structuredClone(b); f(a); return classifyReveal([SHOW], readOf(JSON.stringify(b), JSON.stringify(a))).reveal; };
  assert.equal(mut((a) => a.rv.push({ o: 'New York Times', cn: 'X', s: 80, v: 'positive', u: 'https://nyt.example/r' })), true);
  assert.equal(mut((a) => { a.rv[0].s += 1; }), true);
  assert.equal(mut((a) => { a.rv[0].v = a.rv[0].v === 'negative' ? 'rave' : 'negative'; }), true);
  assert.equal(mut((a) => { a.rc = (a.rc || 0) + 1; }), true);
  // Quote text, review order and a regenerated critics' take are not reveals.
  assert.equal(mut((a) => { a.cn = { ...(a.cn || {}), t: 'new take' }; }), false);
  assert.equal(mut((a) => { a.rv[0].q = 'different excerpt'; }), false);
  assert.equal(mut((a) => { a.rv.reverse(); }), false);
});

test('added or deleted show file: reveal only when it has reviews', () => {
  const withRv = JSON.stringify({ id: 'x', rv: [{ u: 'u', s: 70, v: 'positive' }] });
  const empty = JSON.stringify({ id: 'x', rv: [] });
  assert.equal(classifyReveal([SHOW], readOf(null, withRv)).reason, 'show-added');
  assert.equal(classifyReveal([SHOW], readOf(withRv, null)).reason, 'show-deleted');
  assert.equal(classifyReveal([SHOW], readOf(null, empty)).reveal, false);
});

test('code paths and NYT picks are reveals; unrelated data is not', () => {
  assert.equal(classifyReveal(['src/app/page.tsx'], () => null, { codePaths: CODE_PATHS }).reason, 'code');
  assert.equal(classifyReveal(['package.json'], () => null, { codePaths: CODE_PATHS }).reason, 'code');
  assert.equal(classifyReveal(['data/nyt-critics-picks.json'], () => null).reason, 'nyt-picks');
  assert.equal(classifyReveal(['data/audit/x.json', 'public/status.html'], () => null, { codePaths: CODE_PATHS }).reveal, false);
});

test('every uncertainty fails open (reveal)', () => {
  assert.equal(classifyReveal([SHOW], () => { throw new Error('x'); }).reason, 'read-error');
  assert.equal(classifyReveal([SHOW], () => null).reason, 'read-error');
  assert.equal(classifyReveal([SHOW], readOf('{bad', '{}')).reason, 'parse-error');
  const many = Array.from({ length: MAX_SHOW_FILES + 1 }, (_, i) => `public/data/shows/s${i}.json`);
  assert.equal(classifyReveal(many, readOf('{}', '{}')).reveal, true);
  const r = classifyRange('no-such-sha-1', 'no-such-sha-2');
  assert.equal(r.reveal, true);
  assert.match(r.reason, /^classify-error/);
});

test('reviewProjection ignores sub-integer cs, keeps rounded cs', () => {
  assert.equal(reviewProjection({ cs: 69.06, rv: [] }), reviewProjection({ cs: 69.17, rv: [] }));
  assert.notEqual(reviewProjection({ cs: 69.4, rv: [] }), reviewProjection({ cs: 69.6, rv: [] }));
});

test('resolveUrgency: urgent trigger without a reveal is downgraded to routine', () => {
  const A = 'a'.repeat(40); const B = 'b'.repeat(40);
  const no = { reveal: false, reason: 'no-visible-change(3 show files)' };
  assert.equal(resolveUrgency({ urgent: true, alwaysShip: false, baselineSha: A, headSha: B, reveal: no }).urgent, false);
  assert.equal(resolveUrgency({ urgent: true, alwaysShip: false, baselineSha: A, headSha: B, reveal: { reveal: true, reason: 'code' } }).urgent, true);
  // Missing classification, unknown baseline, or HEAD already live: unchanged (urgent).
  assert.equal(resolveUrgency({ urgent: true, alwaysShip: false, baselineSha: A, headSha: B, reveal: null }).urgent, true);
  assert.equal(resolveUrgency({ urgent: true, alwaysShip: false, baselineSha: null, headSha: B, reveal: no }).urgent, true);
  assert.equal(resolveUrgency({ urgent: true, alwaysShip: false, baselineSha: A, headSha: A, reveal: no }).urgent, true);
  assert.equal(resolveUrgency({ urgent: true, alwaysShip: true, baselineSha: A, headSha: B, reveal: no }).urgent, true);
  assert.equal(resolveUrgency({ urgent: false, alwaysShip: false, baselineSha: A, headSha: B, reveal: { reveal: true } }).urgent, false);
});

test('BRO-8261: opening-night-reveal is urgent but re-checked (not always-ship)', () => {
  assert.ok(URGENT_SOURCES.includes('opening-night-reveal'));
  assert.ok(!ALWAYS_SHIP_SOURCES.includes('opening-night-reveal'));
  assert.equal(isAlwaysShip({ eventName: 'workflow_dispatch', source: 'opening-night-reveal' }), false);
  assert.equal(isAlwaysShip({ eventName: 'workflow_dispatch', source: 'urgent' }), true);
  assert.equal(isAlwaysShip({ eventName: 'schedule', source: 'urgent' }), false);
  assert.ok(ALWAYS_SHIP_SOURCES.includes('urgent'));
  assert.ok(!ALWAYS_SHIP_SOURCES.includes('opening-night'));
  assert.ok(!ALWAYS_SHIP_SOURCES.includes('rebuild-fast'));
  assert.equal(isUrgent({ eventName: 'workflow_dispatch', source: 'opening-night-reveal' }), true);
  assert.equal(isUrgent({ eventName: 'workflow_dispatch', source: 'opening-night-routine' }), false);
});

test('only shows in the opening window can reveal', () => {
  const b = fx('sweeney-before'); const a = fx('sweeney-after');
  assert.equal(classifyReveal([SHOW], readOf(b, a), { openingIds: ['other'] }).reveal, false);
  assert.equal(classifyReveal([SHOW], readOf(b, a), { openingIds: ['x'] }).reveal, true);
  assert.equal(classifyReveal([SHOW], readOf(b, a), { openingIds: null }).reveal, true); // unknown window fails open
  assert.deepEqual(openingIdsFrom(JSON.stringify({ shows: [{ id: 'a' }], upcoming: [{ id: 'b' }] })), ['a', 'b']);
  assert.equal(openingIdsFrom('{bad'), null);
  assert.equal(openingIdsFrom(null), null);
});

test('NYT picks: only the url list counts, _meta timestamp churn does not', () => {
  const p = (urls, ts) => JSON.stringify({ _meta: { lastUpdated: ts }, urls });
  const r = (before, after) => classifyReveal(['data/nyt-critics-picks.json'], () => ({ before, after }));
  assert.equal(r(p(['a'], 't1'), p(['a'], 't2')).reveal, false);
  assert.equal(r(p(['a'], 't1'), p(['a', 'b'], 't2')).reveal, true);
  assert.equal(r('{bad', p(['a'], 't2')).reveal, true);
  assert.equal(nytPicksChanged(null), true);
});

test('classifyRange on real poller commit 15785a08d: sweeney-todd reveal is outside the opening window', (t) => {
  // BRO-8261: skip visibly, and only when the commit is really absent (shallow
  // CI checkout). Any other classify-error is a failure, not a skip.
  const has = spawnSync('git', ['cat-file', '-e', '15785a08d~1^{commit}'], { cwd: ROOT }).status === 0;
  if (!has) { t.skip('commit 15785a08d~1 not in this checkout (shallow history)'); return; }
  const r = classifyRange('15785a08d~1', '15785a08d', { codePaths: CODE_PATHS });
  assert.equal(r.reveal, false);
});

test('ship-check fixes: press-night sources always ship (private-only reveals)', () => {
  assert.ok(ALWAYS_SHIP_SOURCES.includes('lane-press-night'));
  assert.ok(ALWAYS_SHIP_SOURCES.includes('press-night-watchdog'));
});

test('ship-check fixes: empty or stale status file means unknown window (fail open)', () => {
  const st = (ids, gen) => JSON.stringify({ generatedAt: gen, shows: ids.map((id) => ({ id })), upcoming: [] });
  const now = Date.parse('2026-11-24T00:00:00Z') / 1000;
  assert.equal(openingIdsFrom(st([], '2026-11-23T23:00:00Z')), null);
  assert.deepEqual(openingIdsFrom(st(['a'], '2026-11-23T23:00:00Z'), { refEpochSec: now }), ['a']);
  assert.equal(openingIdsFrom(st(['a'], '2026-11-20T00:00:00Z'), { refEpochSec: now }), null);
  assert.equal(openingIdsFrom(st(['a'], undefined), { refEpochSec: now }), null);
});

test('ship-check fixes: first reviews for a show outside the window are a reveal', () => {
  const none = JSON.stringify({ _v: 4, id: 'x', rv: [] });
  const noKey = JSON.stringify({ _v: 4, id: 'x' });
  const one = JSON.stringify({ _v: 4, id: 'x', rv: [{ u: 'u', s: 70, v: 'positive' }] });
  const two = JSON.stringify({ _v: 4, id: 'x', rv: [{ u: 'u', s: 70, v: 'positive' }, { u: 'w', s: 60, v: 'mixed' }] });
  const opt = { openingIds: ['other'] };
  assert.equal(classifyReveal([SHOW], readOf(none, one), opt).reason, 'first-reviews');
  assert.equal(classifyReveal([SHOW], readOf(noKey, one), opt).reason, 'first-reviews');
  assert.equal(classifyReveal([SHOW], readOf(null, one), opt).reason, 'first-reviews');
  assert.equal(classifyReveal([SHOW], readOf(one, two), opt).reveal, false); // later review, routine
});

test('ship-check fixes: unknown show JSON shape or schema version change is a reveal', () => {
  const b = fx('bmc-before');
  const j = JSON.parse(b);
  const renamed = JSON.stringify({ ...j, rv: { list: j.rv } });
  const bumped = JSON.stringify({ ...j, _v: (j._v || 0) + 1 });
  assert.equal(classifyReveal([SHOW], readOf(b, renamed)).reason, 'schema-changed');
  assert.equal(classifyReveal([SHOW], readOf(b, bumped)).reason, 'schema-changed');
});

// BRO-8261: the gate's whole chain for a poller dispatch that over-reported a
// reveal (merge commit / classify error forced reveal=true): the gate's own
// classification says no reveal, so it is judged as a routine tick and held by
// the 45-min min-interval. A real reveal over the same fresh deploy still ships.
function judge({ source, reveal, deployAgeSec = 600 }) {
  const ev = 'workflow_dispatch';
  const urgentTrigger = isUrgent({ eventName: ev, source });
  const alwaysShip = isAlwaysShip({ eventName: ev, source });
  const u = resolveUrgency({ urgent: urgentTrigger, alwaysShip, baselineSha: 'aaa', headSha: 'bbb', reveal });
  return decide({
    eventName: u.urgent ? ev : 'schedule', gateDisabled: false, baselineSha: 'aaa', deployAgeSec,
    headSha: 'bbb', diffResult: 'dirty', dataDiffResult: 'dirty', codeDiffResult: 'clean', minIntervalSec: 45 * 60,
  });
}

test('BRO-8261: source=opening-night-reveal over a no-reveal range is routine (SKIP on min-interval)', () => {
  const noReveal = { reveal: false, reason: 'no-visible-change(3 show files)', file: null };
  assert.deepEqual(judge({ source: 'opening-night-reveal', reveal: noReveal }), { proceed: false, reason: 'min-interval' });
  // Same range, real reveal: ships now.
  assert.deepEqual(judge({ source: 'opening-night-reveal', reveal: { reveal: true, reason: 'first-reviews', file: SHOW } }), { proceed: true, reason: 'explicit-ship' });
  // Classification failed (null / error reveal): fails open, ships now.
  assert.deepEqual(judge({ source: 'opening-night-reveal', reveal: null }), { proceed: true, reason: 'explicit-ship' });
  assert.deepEqual(judge({ source: 'opening-night-reveal', reveal: { reveal: true, reason: 'baseline-fetch-error', file: null } }), { proceed: true, reason: 'explicit-ship' });
  // /go-live-now still skips the check.
  assert.deepEqual(judge({ source: 'urgent', reveal: noReveal }), { proceed: true, reason: 'explicit-ship' });
});

test('BRO-8261: every source the poller sends vercel-deploy.yml is urgent, none always-ship', () => {
  const y = fs.readFileSync(path.join(ROOT, '.github/workflows/opening-night-poller.yml'), 'utf8');
  // Every line that dispatches vercel-deploy.yml must name a literal source we
  // can read (no --field/-F/quoted/$VAR forms slipping past the check).
  const lines = y.split('\n').filter((l) => /gh workflow run vercel-deploy\.yml/.test(l));
  assert.ok(lines.length >= 2, 'poller deploy dispatches not found');
  const sources = lines.map((l) => {
    const m = l.match(/gh workflow run vercel-deploy\.yml -f source=([\w-]+)(?=\s|$)/);
    assert.ok(m, `unreadable vercel-deploy dispatch form: ${l.trim()}`);
    return m[1];
  });
  assert.deepEqual([...new Set(sources)].sort(), ['opening-night', 'opening-night-reveal']);
  for (const s of sources) {
    assert.ok(URGENT_SOURCES.includes(s), `${s} must be in URGENT_SOURCES`);
    assert.ok(!ALWAYS_SHIP_SOURCES.includes(s), `${s} must be re-checked by the gate`);
  }
});

// BRO-8261 cousin: express, broadcast, rebuild-fast, land and the gate's own
// hand-offs dispatch vercel-deploy.yml too. A typo'd source (opening_night)
// would silently become routine and wait out the min-interval, so every
// literal source any workflow sends must be one the gate knows.
test('BRO-8261: every literal vercel-deploy.yml source in any workflow is a known gate source', () => {
  const KNOWN_ROUTINE = ['land', 'deferred'];
  const dir = path.join(ROOT, '.github/workflows');
  const seen = new Set();
  for (const f of fs.readdirSync(dir).filter((n) => n.endsWith('.yml'))) {
    for (const l of fs.readFileSync(path.join(dir, f), 'utf8').split('\n')) {
      if (/^\s*#/.test(l) || !/vercel-deploy\.yml/.test(l)) continue;
      for (const m of l.matchAll(/-f source=([\w-]+)/g)) {
        seen.add(m[1]);
        assert.ok(URGENT_SOURCES.includes(m[1]) || KNOWN_ROUTINE.includes(m[1]), `${f}: unknown deploy source "${m[1]}"`);
      }
    }
  }
  for (const s of ['opening-night', 'opening-night-reveal', 'rebuild-fast', 'land']) assert.ok(seen.has(s), `expected a dispatch with source=${s}`);
});

test('BRO-8261: only public/data/shows/<id>.json counts as a show file', () => {
  assert.equal(isShowFile('public/data/shows/sweeney-todd-2026.json'), true);
  assert.equal(isShowFile('public/data/shows/sweeney-todd-2026.social.json'), false);
  assert.equal(isShowFile('public/data/shows/sub/x.json'), false);
  assert.equal(isShowFile('public/data/shows-index.json'), false);
  // A .social.json sibling never counts toward the show-file caps.
  const many = Array.from({ length: MAX_SHOW_FILES + 1 }, (_, i) => `public/data/shows/s${i}.social.json`);
  assert.equal(classifyReveal(many, () => ({ before: '{}', after: '{}' })).reveal, false);
});

test('BRO-8261: more show files than can be loaded fails open even with an opening show', () => {
  const files = Array.from({ length: MAX_ANY_SHOW_FILES + 1 }, (_, i) => `public/data/shows/s${i}.json`);
  // classifyRange loads no blobs past the cap: every read is null/null.
  const r = classifyReveal(files, () => ({ before: null, after: null }), { openingIds: ['s0'] });
  assert.equal(r.reveal, true);
  assert.match(r.reason, /too-many-show-files/);
});

// ---- BRO-8281: only Broadway changes keep ship-now ----
const { skipForCategory, revealCategoriesFromEnv, DEFAULT_REVEAL_CATEGORIES, NON_BROADWAY_CATEGORIES } = require('./deploy-reveal.js');
const OB = 'public/data/shows/the-dead-1904-off-broadway-2026.json';
const WE = 'public/data/shows/some-play-west-end-2026.json';
const BW = 'public/data/shows/hamilton-2015.json';
const showJson = (cat, rc, extra = {}) => JSON.stringify({ _v: 1, id: 'x', cat, cs: 70, rc, bd: [0, 0, 0, 0, 0], rv: [], au: null, ...extra });
const pair = (cat, rc0, rc1) => ({ before: showJson(cat, rc0), after: showJson(cat, rc1) });
const readMap = (m) => (f) => m[f];
const DEF = { revealCategories: DEFAULT_REVEAL_CATEGORIES };

test('BRO-8281: skipForCategory truth table', () => {
  const j = (cat) => (cat === undefined ? {} : { cat });
  assert.equal(skipForCategory('a-off-broadway-2026', j('off-broadway'), j('off-broadway'), DEFAULT_REVEAL_CATEGORIES), true);
  for (const c of NON_BROADWAY_CATEGORIES) {
    assert.equal(skipForCategory(`x-${c}-1`, j(c), j(c), DEFAULT_REVEAL_CATEGORIES), true, c);
  }
  assert.equal(skipForCategory('hamilton-2015', j('broadway'), j('broadway'), DEFAULT_REVEAL_CATEGORIES), false);
  assert.equal(skipForCategory('a-off-broadway-2026', j(undefined), j(undefined), DEFAULT_REVEAL_CATEGORIES), false, 'missing cat fails open');
  assert.equal(skipForCategory('a-off-broadway-2026', j('mars'), j('mars'), DEFAULT_REVEAL_CATEGORIES), false, 'unknown cat fails open');
  assert.equal(skipForCategory('a-off-broadway-2026', j('off-broadway'), j('broadway'), DEFAULT_REVEAL_CATEGORIES), false, 'reclassified either way counts');
  assert.equal(skipForCategory('a-off-broadway-2026', j('broadway'), j('off-broadway'), DEFAULT_REVEAL_CATEGORIES), false);
  assert.equal(skipForCategory('a-off-broadway-2026', null, j('off-broadway'), DEFAULT_REVEAL_CATEGORIES), true, 'added file');
  assert.equal(skipForCategory('a-off-broadway-2026', j('off-broadway'), null, DEFAULT_REVEAL_CATEGORIES), true, 'deleted file');
  assert.equal(skipForCategory('a-off-broadway-2026', j('off-broadway'), j('off-broadway'), null), false, 'null policy = old behavior');
  // Mislabel guard: a cat that says off-broadway on an id with no market hint is not trusted.
  assert.equal(skipForCategory('hamilton-2015', j('off-broadway'), j('off-broadway'), DEFAULT_REVEAL_CATEGORIES), false);
});

test('BRO-8281: non-Broadway show in the opening window is routine; same change with the switch is a reveal', () => {
  const read = readMap({ [OB]: pair('off-broadway', 3, 9) });
  const r = classifyReveal([OB], read, { openingIds: ['the-dead-1904-off-broadway-2026'], ...DEF });
  assert.equal(r.reveal, false);
  assert.match(r.reason, /1 non-broadway skipped/);
  const old = classifyReveal([OB], read, { openingIds: ['the-dead-1904-off-broadway-2026'], revealCategories: null });
  assert.equal(old.reveal, true);
  assert.equal(old.reason, 'reviews-changed');
});

test('BRO-8281: first reviews for a non-Broadway show outside the window are routine, Broadway ones still reveal', () => {
  const first = (cat) => ({ before: showJson(cat, 0), after: showJson(cat, 5, { cs: 70 }) });
  const ob = classifyReveal([WE], readMap({ [WE]: first('west-end') }), { openingIds: ['unrelated-show-2026'], ...DEF });
  assert.equal(ob.reveal, false);
  // a hand-built broadway first-reviews file (no market hint in id) still reveals
  const bw = classifyReveal([BW], readMap({ [BW]: { before: showJson('broadway', 0, { rv: [] }), after: showJson('broadway', 5, { rv: [{ o: 'NYT', s: 80 }] }) } }), { openingIds: ['unrelated-show-2026'], ...DEF });
  assert.equal(bw.reveal, true);
  assert.equal(bw.reason, 'first-reviews');
});

test('BRO-8281: mixed range reveals in either file order', () => {
  const m = { [OB]: pair('off-broadway', 3, 9), [BW]: pair('broadway', 3, 9) };
  const ids = ['the-dead-1904-off-broadway-2026', 'hamilton-2015'];
  for (const files of [[OB, BW], [BW, OB]]) {
    const r = classifyReveal(files, readMap(m), { openingIds: ids, ...DEF });
    assert.equal(r.reveal, true, files.join());
    assert.equal(r.file, BW);
  }
});

test('BRO-8281: unknown window still applies the category rule; caps and code paths still fail open', () => {
  const read = readMap({ [OB]: pair('off-broadway', 3, 9) });
  assert.equal(classifyReveal([OB], read, { openingIds: null, ...DEF }).reveal, false);
  assert.equal(classifyReveal([OB, 'src/app/page.tsx'], read, { codePaths: ['src/'], ...DEF }).reveal, true);
  const many = Array.from({ length: MAX_SHOW_FILES + 1 }, (_, i) => `public/data/shows/s${i}-off-broadway-2026.json`);
  const r = classifyReveal(many, () => pair('off-broadway', 1, 2), { openingIds: null, ...DEF });
  assert.equal(r.reveal, true);
  assert.match(r.reason, /too-many-show-files/);
});

test('BRO-8281: kill switch env maps to null policy and the workflows wire it in all three call sites', () => {
  assert.deepEqual(revealCategoriesFromEnv({}), DEFAULT_REVEAL_CATEGORIES);
  assert.deepEqual(revealCategoriesFromEnv({ GATE_REVEAL_ALL_CATEGORIES: 'false' }), DEFAULT_REVEAL_CATEGORIES);
  assert.equal(revealCategoriesFromEnv({ GATE_REVEAL_ALL_CATEGORIES: 'true' }), null);
  const wire = 'GATE_REVEAL_ALL_CATEGORIES: ${{ vars.DEPLOY_REVEAL_ALL_CATEGORIES }}';
  const deploy = fs.readFileSync(path.join(ROOT, '.github/workflows/vercel-deploy.yml'), 'utf8');
  const poller = fs.readFileSync(path.join(ROOT, '.github/workflows/opening-night-poller.yml'), 'utf8');
  assert.equal(deploy.split(wire).length - 1, 2, 'gate job + pre-warm step');
  assert.equal(poller.split(wire).length - 1, 1, 'poller classification step');
});
