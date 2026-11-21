// BRO-7930: _pending drain rotation, mtime fallback, collision settling, bare-title guard, health alerts,
// and the limbo gate. Every test requires the REAL module (CLAUDE.md §15); nothing is restated.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { pendingFileTimestamp, orderPendingWork, pathKey } = require('./pending-drain-order.js');
const { urlsSameArticle, classifyTargetCollision } = require('./pending-drain-collision.js');
const { evaluateDrainHealth, loadState, saveState } = require('./pending-drain-state.js');
const { genericSingleWordTitle, passesGenericTitleIdentity } = require('./generic-title-guard.js');
const { classifyLimbo, shortTitleEvidence, applyDecision } = require('./limbo-gate.js');
const { routeLimbo } = require('../route-limbo-reviews.js');

test('a file with no firstSeenAt/publishDate falls back to its mtime, not 0', () => {
  const day = 864e5 * 20000;
  assert.equal(pendingFileTimestamp({}, day + 5000), day);
  assert.equal(pendingFileTimestamp({}, day + 5000), pendingFileTimestamp({}, day + 9000)); // same-day burst ties
  assert.equal(pendingFileTimestamp({ publishDate: '2026-01-02' }, 99), Date.parse('2026-01-02'));
  assert.equal(pendingFileTimestamp({}, 0), 0);
});

test('rotation: a budget of K files per run reaches EVERY file within ceil(N/K) runs (the 2,446 never-reached files)', () => {
  const shows = [];
  for (let s = 0; s < 7; s++) shows.push({ showId: `show-${s}`, files: Array.from({ length: 9 }, (_, i) => ({ file: `f${i}.json`, ts: 0 })) }); // all ts 0 = the no-timestamp files that used to sort last
  const N = 63, K = 10;
  const seen = new Set();
  let cursor = null;
  for (let run = 0; run < Math.ceil(N / K); run++) {
    const flat = orderPendingWork(shows, { mode: 'rotate', cursor }).flatMap(s => s.files.map(f => pathKey(s.showId, f)));
    const batch = flat.slice(0, K);
    batch.forEach(k => seen.add(k));
    cursor = batch[batch.length - 1];
  }
  assert.equal(seen.size, N);
});

test('rotation wraps when the cursor is past the end or its file was drained', () => {
  const shows = [{ showId: 'a', files: [{ file: '1.json', ts: 0 }, { file: '2.json', ts: 0 }] }];
  assert.deepEqual(orderPendingWork(shows, { mode: 'rotate', cursor: 'a/9.json' }), [{ showId: 'a', files: ['1.json', '2.json'] }]);
  assert.deepEqual(orderPendingWork(shows, { mode: 'rotate', cursor: 'a/1.json' }), [{ showId: 'a', files: ['2.json', '1.json'] }]);
});

test('default mode is still newest-first (opening-night poller, BRO-4408)', () => {
  const out = orderPendingWork([{ showId: 'old', files: [{ file: 'x.json', ts: 1 }] }, { showId: 'new', files: [{ file: 'y.json', ts: 9 }] }]);
  assert.deepEqual(out.map(s => s.showId), ['new', 'old']);
});

test('collision: www / query / path-prefix / 1-char typo variants are the same article; another article is not', () => {
  assert.ok(urlsSameArticle('https://www.thestage.co.uk/reviews/x-review-y', 'https://thestage.co.uk/reviews/x-review-y'));
  assert.ok(urlsSameArticle('https://www.broadwayworld.com/westend/article/Review-RENT-20261008', 'https://www.broadwayworld.com/article/Review-RENT-20261008?utm_source=n'));
  assert.ok(urlsSameArticle('https://culturesauce.com/other-desert-cities-julia-louis-dreyfus-broadway-review/', 'https://culturesauce.com/ther-desert-cities-julia-louis-dreyfus-broadway-review/'));
  assert.ok(!urlsSameArticle('https://deadline.com/2026/11/zosia-mamet-girls-revival-in-talks-1237223594/', 'https://deadline.com/2026/11/adam-driver-shuts-down-girls-return-1237216089/'));
  assert.equal(classifyTargetCollision({ url: 'https://a.com/x-1' }, { url: 'https://b.com/x-1' }), 'different-article');
});

test('bare-title guard: numeric and 1-2 letter titles need identity; ordinary titles are untouched', () => {
  for (const t of ['13', 'G', 'Da', '44']) assert.ok(genericSingleWordTitle(t), t);
  for (const t of ['Hamilton', 'Art', 'Red', 'Six', 'Wicked']) assert.equal(genericSingleWordTitle(t), null, t);
  assert.equal(passesGenericTitleIdentity('https://www.dailymail.co.uk/travel/article-123/best-restaurants-44-street.html', '44'), false);
  assert.equal(passesGenericTitleIdentity('https://www.timeout.com/newyork/theater/44-the-musical-off-broadway-review', '44'), true);
});

test('health: N zero runs fires, one resolved file clears it; sustained growth fires', () => {
  const z = (pending = 100) => ({ scope: 'all-open', inspected: 20, promoted: 0, dropped: 0, rejected: 0, tagged: 0, pending });
  assert.equal(evaluateDrainHealth([z(), z(), z()]).zeroPromote, false);
  assert.equal(evaluateDrainHealth([z(), z(), z(), z()]).zeroPromote, true);
  assert.equal(evaluateDrainHealth([z(), z(), z(), z(), { ...z(), tagged: 1 }]).zeroPromote, false);
  assert.equal(evaluateDrainHealth([z(100), z(120), z(140), z(170)]).growth, true);
  assert.equal(evaluateDrainHealth([z(100), z(120), z(110), z(170)]).growth, false);
});

test('state round-trips and a missing file is an empty state', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'drain-state-'));
  assert.deepEqual(loadState(root), { cursor: null, history: [] });
  saveState(root, { cursor: 'a/b.json', history: [{ at: 'x' }] });
  assert.equal(loadState(root).cursor, 'a/b.json');
});

// ---- limbo gate ----
const NOW = Date.parse('2026-11-21T00:00:00Z');
const show = { id: 'ex-2026', title: 'Example Show', openingDate: '2026-05-01', status: 'open' };
const base = { showId: 'ex-2026', outletId: 'timeout', criticName: 'A Critic', url: 'https://www.timeout.com/x', contentTier: 'complete', fullText: 'x'.repeat(100), firstSeenAt: '2026-10-01T00:00:00Z' };
const guardsStub = (over = {}) => ({ hasValidScore: () => false, explainExclusion: () => null, isRoundupUrl: () => ({ isRoundup: false }), ...over });
const queueStub = (skip = null) => ({ unscoredSkipReason: () => skip, UNSCORED_SKIP: { NO_SCORABLE_TEXT: 'no_scorable_text', TERMINAL_TEXT_GATE: 'terminal_text_gate_block', STICKY_REJECTION: 'sticky' } });

test('limbo: flagged, scored, tiered-out and incompleteReason files are NOT limbo', () => {
  const g = guardsStub();
  const c = d => classifyLimbo({ ...base, ...d }, show, '/x/y.json', { nowMs: NOW, guards: g, scoringQueue: queueStub() });
  assert.equal(c({ isNonReview: true }), null);
  assert.equal(c({ assignedScore: 80 }), null);
  assert.equal(c({ contentTier: 'stub' }), null);
  assert.equal(c({ incompleteReason: 'url_content_mismatch' }), null);
  assert.equal(c({ limboRoutedAt: '2026-11-01' }), null);
});

test('limbo: inside the grace window waits; past it every file gets exactly one route', () => {
  const g = guardsStub();
  const c = (d, gOver, q) => classifyLimbo({ ...base, ...d }, show, '/x/y.json', { nowMs: NOW, guards: gOver || g, scoringQueue: queueStub(q) });
  assert.equal(c({ firstSeenAt: '2026-11-18T00:00:00Z' }).route, 'grace');
  assert.equal(c({}, guardsStub({ explainExclusion: () => 'blockedReviewUrl' })).route, 'reject');
  assert.equal(c({}, g, 'no_scorable_text').route, 'refetch');
  assert.equal(c({}, g, null).route, 'scoring');
});

test('limbo: a WestEndTheatre roundup filed under another outlet is flagged isRoundupArticle', () => {
  const g = guardsStub({ isRoundupUrl: () => ({ isRoundup: true }) });
  const d = { ...base, url: 'https://www.westendtheatre.com/1/news/x-reviews/', criticName: 'Ghenet Pinderhughes Randall' };
  const r = classifyLimbo(d, show, '/x/y.json', { nowMs: NOW, guards: g, scoringQueue: queueStub() });
  assert.equal(r.rule, 'wet-roundup-misattributed');
  assert.equal(applyDecision(d, r, '2026-11-21T00:00:00Z').isRoundupArticle, true);
  // the real WET outlet's own page is not touched by this rule
  assert.notEqual(classifyLimbo({ ...d, outletId: 'westendtheatre' }, show, '/x/y.json', { nowMs: NOW, guards: g, scoringQueue: queueStub() }).rule, 'wet-roundup-misattributed');
});

test('short-title evidence: quoted or numeric-dash only, case-sensitive', () => {
  assert.ok(shortTitleEvidence({ fullText: "Big tech in tense 'Job' at Writers Theatre" }, { title: 'Job' }));
  assert.ok(shortTitleEvidence({ fullText: 'Reviews 44—The Musical Deirdre' }, { title: '44' }));
  assert.ok(!shortTitleEvidence({ fullText: 'a job well done, the end of the line' }, { title: 'End' }));
  assert.ok(!shortTitleEvidence({ fullText: 'x' }, { title: 'Two Halves of Guinness' }));
});

test('CLASS GUARD: routeLimbo finds every past-grace limbo file and respects the grace window', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'limbo-'));
  fs.mkdirSync(path.join(root, show.id));
  const put = (f, d) => fs.writeFileSync(path.join(root, show.id, f), JSON.stringify({ ...base, ...d }));
  put('a.json', {});                                   // queued -> scoring
  put('b.json', { url: 'https://www.westendtheatre.com/1/news/x-reviews/' });
  put('c.json', { firstSeenAt: '2026-11-19T00:00:00Z' }); // grace
  put('d.json', { assignedScore: 70 });                // scored: not limbo
  const guards = guardsStub({ isRoundupUrl: u => ({ isRoundup: /westendtheatre/.test(u) }) });
  const common = { root, shows: [show], nowMs: NOW, guards, days: 760 };
  const q = routeLimbo({ ...common, apply: false });
  assert.equal(q.rows.length, 2);
  assert.equal(q.counts.grace, 1);
});

test('the sweep calls the gate and the rotation (a refactor back to newest-first/no gate fails here)', () => {
  const src = fs.readFileSync(path.join(path.dirname(new URL(import.meta.url).pathname), '../replay-pending-bylines.js'), 'utf8');
  assert.match(src, /mode: 'rotate'/);
  assert.match(src, /route-limbo-reviews/);
  assert.match(src, /raiseDrainHealthAlerts\(state\.history\)/);
});

const { urlYearConflict } = require('./url-year-guard.js');
test('URL-year reject: a year that is part of the show title is not a date (1984, the real Times review that was deleted)', () => {
  assert.equal(urlYearConflict('https://www.thetimes.com/culture/theatre-dance/article/1984-review-a-clever-take-on-orwells-classic-gjsnvnxjm', 2014, '1984'), null);
  assert.equal(urlYearConflict('https://deadline.com/2026/10/box-office-x-1237151001/', 2009, '9 to 5'), '2026');
  assert.equal(urlYearConflict('https://x.com/2025/review', 2026, 'Hamlet'), null);
});
