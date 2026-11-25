// BRO-7930: _pending drain rotation, mtime fallback, collision settling, bare-title guard, health alerts,
// and the limbo gate. Every test requires the REAL module (CLAUDE.md §15); nothing is restated.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
// BRO-8107: the shared guards this reaches read shows from a fixture, not the live
// data/shows.json, so this test stays in test.yml's blocking batch.
process.on('exit', require('./shows-json-fixture.js').useShowsFixture([]));
// BRO-8118: the alert router reads a fixture ledger, not the tracked data/audit/alert-ledger.json (CI mode merges it otherwise).
process.env.ALERT_LEDGER_PATH = path.join(os.tmpdir(), `pending-drain-bro7930-alert-ledger-${process.pid}.json`);
const { pendingFileTimestamp, orderPendingWork, rotateTiered, pathKey } = require('./pending-drain-order.js');
const { urlsSameArticle, classifyTargetCollision, promotionBlockRule } = require('./pending-drain-collision.js');
const { evaluateDrainHealth, loadState, saveState } = require('./pending-drain-state.js');
const { genericSingleWordTitle, passesGenericTitleIdentity } = require('./generic-title-guard.js');
const { classifyLimbo, shortTitleEvidence, applyDecision, misattributedWetRoundup } = require('./limbo-gate.js');
const { routeLimbo } = require('./route-limbo.js');

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
  for (const t of ['13', 'G', 'Da', '44']) assert.ok(genericSingleWordTitle(t, { shortNumeric: true }), t);
  for (const t of ['Hamilton', 'Art', 'Red', 'Six', 'Wicked']) assert.equal(genericSingleWordTitle(t), null, t);
  assert.equal(passesGenericTitleIdentity('https://www.dailymail.co.uk/travel/article-123/best-restaurants-44-street.html', '44', { shortNumeric: true }), false);
  assert.equal(passesGenericTitleIdentity('https://www.timeout.com/newyork/theater/44-the-musical-off-broadway-review', '44', { shortNumeric: true }), true);
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
  assert.deepEqual(loadState(root), { cursors: { recent: null, other: null }, turn: 0, history: [] });
  saveState(root, { cursors: { recent: 'a/b.json', other: null }, turn: 3, history: [{ at: 'x' }] });
  assert.equal(loadState(root).cursors.recent, 'a/b.json');
  assert.equal(loadState(root).turn, 3);
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

test('short-title evidence: quoted or numeric-dash only, case-sensitive', () => {
  assert.ok(shortTitleEvidence({ fullText: "Big tech in tense 'Job' at Writers Theatre" }, { title: 'Job' }));
  assert.ok(shortTitleEvidence({ fullText: 'Reviews 44—The Musical Deirdre' }, { title: '44' }));
  assert.ok(!shortTitleEvidence({ fullText: 'a job well done, the end of the line' }, { title: 'End' }));
  assert.ok(!shortTitleEvidence({ fullText: 'x' }, { title: 'Two Halves of Guinness' }));
  assert.ok(shortTitleEvidence({ fullText: 'x', url: 'https://exeuntnyc.com/reviews/review-six-at-the-brooks-atkinson-theatre/' }, { title: 'SIX' }));
  assert.ok(!shortTitleEvidence({ fullText: 'x', url: 'https://example.com/six-reasons-to-visit-nyc/' }, { title: 'SIX' }));
  assert.ok(!shortTitleEvidence({ fullText: 'x', url: 'https://x.com/news/year-in-review-top-west-end-moments/' }, { title: 'End' }));
  assert.ok(!shortTitleEvidence({ fullText: 'x', url: 'https://x.com/news/review-six-film-captures-the-substance/' }, { title: 'SIX' }));
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
  assert.match(src, /rotateTiered\(/);
  assert.match(src, /lib\/route-limbo/);
  assert.match(src, /raiseDrainHealthAlerts\(state\.history\)/);
});

const { urlYearConflict } = require('./url-year-guard.js');
test('URL-year reject: a year that is part of the show title is not a date (1984, the real Times review that was deleted)', () => {
  assert.equal(urlYearConflict('https://www.thetimes.com/culture/theatre-dance/article/1984-review-a-clever-take-on-orwells-classic-gjsnvnxjm', 2014, '1984'), null);
  assert.equal(urlYearConflict('https://deadline.com/2026/10/box-office-x-1237151001/', 2009, '9 to 5'), '2026');
  assert.equal(urlYearConflict('https://x.com/2025/review', 2026, 'Hamlet'), null);
});

test('tiered rotation: recent-show files first on even turns, older first on odd; each tier resumes from its own cursor; both are fully covered', () => {
  const mk = (id, n) => ({ showId: id, files: Array.from({ length: n }, (_, i) => ({ file: `f${i}.json`, ts: 0 })) });
  const shows = [mk('new-a', 4), mk('new-b', 4), mk('old-a', 6), mk('old-b', 6)];
  const tierOf = id => (id.startsWith('new') ? 'recent' : 'other');
  const first = rotateTiered(shows, { cursors: {}, tierOf, recentFirst: true });
  assert.equal(first.work[0].showId, 'new-a');
  assert.equal(rotateTiered(shows, { cursors: {}, tierOf, recentFirst: false }).work[0].showId, 'old-a');
  assert.deepEqual(first.tierEnds, { recent: 'new-b/f3.json', other: 'old-b/f5.json' });
  // resume: recent cursor mid-way skips what was done; other cursor null starts at its top
  const resumed = rotateTiered(shows, { cursors: { recent: 'new-a/f3.json' }, tierOf, recentFirst: true }).work;
  assert.deepEqual(resumed.slice(0, 2).map(w => w.showId), ['new-b', 'old-a']);
  // coverage: 10 files per run walks every file in both tiers within ceil(total / K) runs when cursors persist
  const K = 7, total = 20; const seen = new Set(); let cursors = {}; let turn = 0;
  for (let run = 0; run < Math.ceil(total / K) + 2; run++) {
    const t = rotateTiered(shows, { cursors, tierOf, recentFirst: turn++ % 2 === 0 });
    const keys = t.work.flatMap(w => w.files.map(f => pathKey(w.showId, f))).slice(0, K);
    keys.forEach(k => seen.add(k));
    for (const tier of ['recent', 'other']) {
      const mine = keys.filter(k => tierOf(k.split('/')[0]) === tier);
      if (mine.length) cursors = { ...cursors, [tier]: mine[mine.length - 1] >= t.tierEnds[tier] ? null : mine[mine.length - 1] };
    }
  }
  assert.equal(seen.size, total);
});

test('END-TO-END on a temp _pending tree: planPendingWork(raw) feeds rotateTiered without losing file names', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pend-'));
  process.env.REVIEW_TEXTS_DIR = root;
  fs.mkdirSync(path.join(root, '_pending', 'new-show'), { recursive: true });
  fs.writeFileSync(path.join(root, '_pending', 'new-show', 'a--1.json'), '{}');
  const replay = require('../replay-pending-bylines.js');
  const raw = replay.planPendingWork(['new-show'], { raw: true });
  const t = rotateTiered(raw, { cursors: {}, tierOf: () => 'recent', recentFirst: true });
  assert.deepEqual(t.work, [{ showId: 'new-show', files: ['a--1.json'] }]);
  delete process.env.REVIEW_TEXTS_DIR;
});

test('promotion guard: a rebuild-excluded candidate is blocked; a textless stub (no-signal rule) is still promoted', () => {
  const show = { id: 's', title: 'S' };
  const g = r => ({ explainExclusion: () => r });
  assert.equal(promotionBlockRule({}, show, '/x', { guards: g('blockedReviewUrl'), noSignalRules: ['noTextOrScoreSignal'] }), 'blockedReviewUrl');
  assert.equal(promotionBlockRule({}, show, '/x', { guards: g('noTextOrScoreSignal'), noSignalRules: ['noTextOrScoreSignal'] }), null);
  assert.equal(promotionBlockRule({}, show, '/x', { guards: g(null), noSignalRules: [] }), null);
  assert.equal(promotionBlockRule({ url: 'https://www.broadwayworld.com/shows/show.php?showid=1' }, { id: 's', title: 'S' }, '/x'), 'listingPageUrl'); // the real guard, real rule
});

test('WET roundup under another outlet is flagged even when it carries the roundup star (so it never looks scored)', () => {
  const g = guardsStub({ isRoundupUrl: () => ({ isRoundup: true }) });
  const d = { ...base, outletId: 'times-uk', url: 'https://www.westendtheatre.com/9/news/x-reviews/', aggregatorStars: '4/5', assignedScore: 80 };
  assert.equal(misattributedWetRoundup(d, g).flag.isRoundupArticle, true);
  assert.equal(misattributedWetRoundup({ ...d, outletId: 'westendtheatre' }, g), null);
  assert.equal(misattributedWetRoundup({ ...d, isRoundupArticle: true }, g), null);
});

test('raiseDrainHealthAlerts fires the zero-promote alert and resolves the growth one (real function, injected router)', async () => {
  const { raiseDrainHealthAlerts } = require('../replay-pending-bylines.js');
  const z = (pending = 100) => ({ scope: 'all-open', inspected: 20, promoted: 0, dropped: 0, rejected: 0, tagged: 0, pending });
  const fired = [], resolved = [];
  const h = await raiseDrainHealthAlerts([z(), z(), z(), z()], { alert: async o => { fired.push(o.conditionKey); }, resolve: async k => { resolved.push(k); } });
  assert.equal(h.zeroPromote, true);
  assert.deepEqual(fired, ['pending-drain-zero-promote']);
  assert.deepEqual(resolved, ['pending-drain-growth', 'pending-open-growth']); // BRO-8089: the open-growth condition resolves when quiet
});

// Ship-check findings (BRO-7930): scoped cursors, stale needsRefetch, 4-digit numeric titles, wedge on unreadable stub.
test('state keeps separate open_/pending cursors', async () => {
  const fs = await import('node:fs'); const os = await import('node:os'); const path = await import('node:path');
  const ds = (await import('node:module')).createRequire(import.meta.url)('./pending-drain-state.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pds-'));
  ds.saveState(dir, { cursors: { recent: 'a', other: null, open_recent: 'b', open_other: 'c' }, turn: 1, history: [] });
  const s = ds.loadState(dir);
  assert.equal(s.cursors.open_recent, 'b'); assert.equal(s.cursors.open_other, 'c'); assert.equal(s.cursors.recent, 'a');
});
test('scoring decision clears stale needsRefetch', async () => {
  const lg = (await import('node:module')).createRequire(import.meta.url)('./limbo-gate.js');
  const out = lg.applyDecision({ needsRefetch: true }, { route: 'scoring', rule: 'queued' }, '2026-11-21T00:00:00Z');
  assert.equal(out.needsRefetch, undefined);
  assert.equal(lg.applyDecision({}, { route: 'refetch', rule: 'x' }, 'n').needsRefetch, true);
});
test('4-digit numeric title (1984) is not a bare generic title; 3-digit still is', async () => {
  const g = (await import('node:module')).createRequire(import.meta.url)('./generic-title-guard.js');
  assert.equal(g.genericSingleWordTitle('1984'), null);
  assert.equal(g.genericSingleWordTitle('13'), null, 'discovery keeps the narrow rule');
  assert.equal(g.genericSingleWordTitle('13', { shortNumeric: true }), '13');
  assert.equal(g.genericSingleWordTitle('1984', { shortNumeric: true }), null);
});

// BRO-7945 section, block-scoped so its fixtures (NOW, mk, ...) do not collide with the BRO-7930 ones above.
{
/**
 * BRO-7945 (follow-up to BRO-7930). Part B: the _pending drain fetched the same article once per
 * same-title production and re-judged every copy forever. Part A: scored, includable files that
 * rebuild drops with no recorded reason. These tests drive the REAL processShow(), the real
 * siblingForArticle/makeFetchCache and the real findScoredAbsent; no network.
 */

// Lazy: the BRO-7930 END-TO-END test above must be the first to load this module (it reads REVIEW_TEXTS_DIR at load).
const replay = new Proxy({}, { get: (_, k) => require('../replay-pending-bylines.js')[k] });
const { makeFetchCache, siblingForArticle } = require('./pending-sibling-productions.js');
const { findScoredAbsent, summarizeScoredAbsent, wholeShowSkipReason } = require('./scored-absent.js');
const { explainRecoveryExclusion } = require('./recovery-exclusions.js');

const NOW = new Date('2026-11-21T12:00:00Z');
const mk = (id, open, close) => ({ id, title: 'A Streetcar Named Desire', venue: 'V', openingDate: open, previewsStartDate: open, closingDate: close, category: 'broadway', market: 'broadway', status: 'closed' });
const S1992 = mk('a-streetcar-named-desire-1992', '1992-04-12', '1992-08-30');
const S2005 = mk('a-streetcar-named-desire-2005', '2005-04-26', '2005-07-24');
const S2025 = mk('a-streetcar-named-desire-2025', '2025-03-01', '2025-06-01');
const ALL = [S1992, S2005, S2025];
// Dateless: a dated url is settled by triage (BRO-8065 url-date rule) before the fetch these tests exercise.
const URL_ = 'https://ew.com/theater/a-streetcar-named-desire-review/';
const html = `<html><head><title>A Streetcar Named Desire review</title><script type="application/ld+json">${JSON.stringify({ '@type': 'NewsArticle', datePublished: '2025-03-11T08:00:00Z', author: { '@type': 'Person', name: 'Jane Critic' } })}</script></head><body><article>${'<p>A Streetcar Named Desire is staged with conviction and the cast of A Streetcar Named Desire delivers across both acts.</p>'.repeat(14)}</article></body></html>`;

function seedAll(shows, file = 'ew--6aa1dc39.json') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bro7945-'));
  for (const s of shows) {
    const dir = path.join(root, '_pending', s.id); fs.mkdirSync(dir, { recursive: true }); fs.mkdirSync(path.join(root, s.id), { recursive: true });
    fs.writeFileSync(path.join(dir, file), JSON.stringify({ showId: s.id, outletId: 'ew', criticName: 'Unknown', url: URL_, contentTier: 'stub', pendingReason: 'no-byline' }));
  }
  return root;
}
const baseDeps = (root, fetch, extra = {}) => ({ root, fetch, allShows: ALL, dryRun: false, explicitScope: false, now: () => NOW, budget: { exceeded: () => false, minutes: 0 }, alert: async () => ({}), emit: () => {}, ...extra });

test('drain: one fetch per URL per run across same-title productions, siblings settled', async (t) => {
  const root = seedAll(ALL); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let calls = 0;
  const cached = makeFetchCache(async () => { calls++; return { content: html, source: 'mock' }; });
  const out = {};
  for (const s of [S1992, S2005]) out[s.id] = await replay.processShow(s.id, baseDeps(root, cached, { show: s }));
  assert.equal(calls, 1, 'two out-of-window copies, one paid fetch');
  assert.equal(out[S1992.id].redundantCopies.sibling, 1);
  assert.equal(out[S2005.id].redundantCopies.sibling, 1);
  const tag = JSON.parse(fs.readFileSync(path.join(root, '_pending', S1992.id, 'ew--6aa1dc39.json'), 'utf8'));
  assert.equal(tag.promoteSettled, 'sibling');
  assert.equal(tag.promoteSettledSibling, S2025.id);
  assert.ok(fs.existsSync(path.join(root, '_pending', S1992.id, 'ew--6aa1dc39.json')), 'never deleted');
});

test('drain: outside every same-title window is tagged settled junk, no sibling', async (t) => {
  const root = seedAll([S1992, S2005]); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const cached = makeFetchCache(async () => ({ content: html, source: 'mock' }));
  const r = await replay.processShow(S1992.id, baseDeps(root, cached, { show: S1992, allShows: [S1992, S2005] }));
  assert.equal(r.redundantCopies['outside-all'], 1);
  const tag = JSON.parse(fs.readFileSync(path.join(root, '_pending', S1992.id, 'ew--6aa1dc39.json'), 'utf8'));
  assert.equal(tag.promoteSettled, 'outside-all');
});

test('siblingForArticle: same title in any market, decidably in window, live copy', () => {
  assert.equal(siblingForArticle(S1992, ALL, '2025-03-11').id, S2025.id);
  assert.equal(siblingForArticle(S1992, ALL, '2025-03-11', { hasCopy: () => false }), null);
  assert.equal(siblingForArticle(S1992, ALL, '1999-01-01'), null);
  // A regional copy of a Broadway review: the Broadway production owns it across markets.
  assert.equal(siblingForArticle({ ...S1992, id: 'r', market: 'regional', category: 'regional' }, ALL, '2025-03-11').id, S2025.id);
  // An undated sibling never owns an article.
  assert.equal(siblingForArticle(S1992, [{ ...S2025, openingDate: null, previewsStartDate: null }], '2025-03-11'), null);
});

test('makeFetchCache caches a thrown error too (no second paid try)', async () => {
  let n = 0; const f = makeFetchCache(async () => { n++; throw new Error('boom'); });
  await assert.rejects(f('u')); await assert.rejects(f('u'));
  assert.equal(n, 1);
  assert.deepEqual(f.stats(), { unique: 1, calls: 2, cacheHits: 1 });
});

// ---- Part A -----------------------------------------------------------------------------
const SHOW = { id: 'x-2026', title: 'X', openingDate: '2026-01-10', previewsStartDate: '2026-01-01', category: 'broadway', market: 'broadway', status: 'open' };
const file = (o = {}) => ({ file: 'ew--a.json', mtimeMs: 0, data: { outletId: 'ew', llmScore: { score: 70 }, contentTier: 'complete', ...o } });
const find = (files, ledger = new Map(), extra = {}) => findScoredAbsent({
  showId: SHOW.id, show: SHOW, files, presentOutlets: new Set(), ledger,
  explain: () => null, scoreable: () => true, nowMs: 1e12, ...extra,
});

test('scored-absent: unrecorded drop is SILENT, recorded is explained, young is grace', () => {
  const r = find([file()]); assert.equal(r[0].status, 'silent');
  assert.equal(find([file()], new Map([['ew--a.json', 'skippedSyndicated']]))[0].status, 'explained');
  assert.equal(find([{ ...file(), mtimeMs: 1e12 - 3600e3 }])[0].status, 'grace');
  assert.equal(summarizeScoredAbsent(find([file()])).silent, 1);
});

test('scored-absent: decided flags, unscored, present outlet and non-includable are not rows', () => {
  assert.equal(find([file({ wrongProduction: true })]).length, 0);
  assert.equal(find([file({ llmScore: null })]).length, 0);
  assert.equal(find([file()], new Map(), { presentOutlets: new Set(['ew']) }).length, 0);
  assert.equal(find([file()], new Map(), { explain: () => 'wrongShow' }).length, 0);
});

test('recovery predicate: relative profile URL and evergreen ticket page stop looking includable', () => {
  const ctx = { outletRegionMap: {}, dualMarketOutlets: new Set() };
  const base = { outletId: 'ew', llmScore: { score: 70 }, contentTier: 'complete', fullText: 'x '.repeat(400), publishDate: '2026-02-01' };
  assert.equal(explainRecoveryExclusion({ ...base, url: '/people/Steve-Barnes/' }, SHOW, 'a.json', ctx), 'invalidUrl');
  assert.equal(explainRecoveryExclusion({ ...base, url: 'http://www.theatrereviews.com/allegiance-at-the-longacre-theatre-tickets/' }, SHOW, 'a.json', ctx), 'listingPageUrl');
});

test('scored-absent: grace comes from the record stamps, not a fresh checkout mtime', () => {
  const old = { ...file({ rescoreCompletedAt: '2020-01-01T00:00:00Z' }), mtimeMs: 1e12 - 1000 };
  assert.equal(find([old], new Map(), { nowMs: Date.parse('2026-11-21T00:00:00Z') })[0].status, 'silent');
});

test('scored-absent: a whole-show rebuild skip (upcoming any market, Broadway previews) is explained, not silent', () => {
  assert.equal(wholeShowSkipReason({ status: 'upcoming', category: 'west-end' }), 'skippedUpcomingShows');
  assert.equal(wholeShowSkipReason({ status: 'previews' }), 'skippedPreviewsShows');
  assert.equal(wholeShowSkipReason({ status: 'previews', category: 'off-broadway' }), null);
  assert.equal(wholeShowSkipReason({ status: 'open', category: 'broadway' }), null);
  const r = findScoredAbsent({ showId: 'u', show: { ...SHOW, status: 'upcoming' }, files: [file()], presentOutlets: new Set(), ledger: new Map(),
    explain: () => null, scoreable: () => true, nowMs: 1e12 });
  assert.deepEqual([r[0].status, r[0].reason], ['explained', 'skippedUpcomingShows']);
});
}
