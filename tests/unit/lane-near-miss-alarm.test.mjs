// BRO-7748: press-night near-misses and found-not-live gaps. The Blue Man Group replay below is the incident: with the
// strict matcher as it was before BRO-7739 (matchOpts {fuzzy:true}, no main-title rule) the TheaterMania review vanished
// silently; now it must come back as a near-miss carrying the one command that ingests it.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const d = require('../../scripts/lib/opening-night-lane/discovery.js');
const nm = require('../../scripts/lib/opening-night-lane/near-miss.js');
const { createPressSignalsNotifier } = require('../../scripts/lib/press-night-signals-notify.js');

const BMG = { id: 'blue-man-group-a-new-holiday-surprise-2026', title: 'Blue Man Group “A New Holiday Surprise”', venue: 'Lunt-Fontanne Theatre', openingDate: '2026-11-17', category: 'broadway', market: 'broadway', slug: 'blue-man-group-a-new-holiday-surprise', cast: [] };
const TM_INDEX = 'https://www.theatermania.com/news/?categories=reviews';
const TM_URL = 'https://www.theatermania.com/news/review-blue-man-groups-broadway-christmas-show-is-a-lump-of-coal_1860029/';
const TM_HEADLINE = 'Blue Man Group’s Broadway Christmas Show Is a Lump of Coal';
// The review page as TheaterMania serves it (trimmed): it names the show and its venue (BRO-7743's corroboration).
const TM_PAGE = `<html><head><title>${TM_HEADLINE}</title><script>var x = 'Lunt-Fontanne';</script></head><body><article><h1>${TM_HEADLINE}</h1>
  <p>Blue Man Group: A New Holiday Surprise has arrived at the Lunt-Fontanne Theatre for a limited holiday run, and the three cobalt
  performers spend ninety minutes drumming, catching marshmallows and painting with gumballs.</p>
  <p>It is a slight, repetitive evening that mistakes volume for wonder, and the holiday theme is a coat of tinsel at best.</p></article></body></html>`;
const INDEX_HTML = `<html><body><main>
  <article><a href="${TM_URL}"><h3>Review: ${TM_HEADLINE}</h3></a><time datetime="2026-11-18T02:00:00Z">November 17, 2026</time></article>
  <article><a href="https://www.theatermania.com/news/review-the-fantasticks-returns_1859990/"><h3>Review: The Fantasticks Returns</h3></a></article>
</main></body></html>`;

test('leadTitle splits a quoted subtitle, a colon or a dash, and refuses a one-word lead', () => {
  assert.equal(nm.leadTitle(BMG.title), 'Blue Man Group');
  assert.equal(nm.leadTitle('Hamlet: A New Version'), null);
  assert.equal(nm.leadTitle('Much Ado About Nothing'), null);
  assert.equal(nm.leadTitle('Harry Potter and the Cursed Child - Part One'), 'Harry Potter and the Cursed Child');
});

test('nearMissSignals: the BMG TheaterMania headline and slug name the show; unrelated items do not', () => {
  const s = nm.nearMissSignals({ title: TM_HEADLINE, url: TM_URL }, BMG);
  assert.ok(s.some((x) => x.startsWith('lead-title:Blue Man Group')), JSON.stringify(s));
  assert.deepEqual(nm.nearMissSignals({ title: 'Review: The Fantasticks Returns', url: 'https://www.theatermania.com/news/review-the-fantasticks-returns_1/' }, BMG), []);
  // venue alone (theatre news) is no base signal
  const venueShow = { ...BMG, title: 'Some Other Show', cast: [{ name: 'Jane Q Actor' }] };
  assert.deepEqual(nm.nearMissSignals({ title: 'Lunt-Fontanne Theatre gets new seats', url: 'https://x.com/news/lunt-fontanne-seats' }, venueShow), []);
  // venue AND a cast member together is a base signal
  assert.ok(nm.nearMissSignals({ title: 'Jane Q Actor shines at the Lunt-Fontanne', url: 'https://x.com/review/jane' }, venueShow).includes('venue+cast'));
});

test('nearMissSignals: one-word and run-together titles (The Fantasticks dry-run misses, 2026-11-16)', () => {
  const F = { id: 'the-fantasticks-2026', title: 'The Fantasticks', venue: 'Some Theatre', cast: [] };
  assert.ok(nm.nearMissSignals({ url: 'https://www.jkstheatrescene.com/2026/11/review-fantasticks.html' }, F).includes('title-word:fantasticks'));
  assert.ok(nm.nearMissSignals({ url: 'https://www.talkinbroadway.com/page/world/TheFantasticks.html' }, F).length);
  // a short one-word title is not distinctive enough
  assert.deepEqual(nm.nearMissSignals({ url: 'https://x.com/review-chess-club' }, { title: 'Chess' }), []);
});

test('gapCandidates: only vouched, not-admitted, not-intentionally-refused sightings past 15 minutes', () => {
  const firstSeen = new Map();
  const base = { url: 'https://a.com/review/x', knownOutlet: true, aggregatorCited: true, admitted: false };
  const t0 = Date.parse('2026-11-18T02:00:00Z');
  const s = [base, { ...base, url: 'https://a.com/review/admitted', admitted: true }, // An earlier production's review on the outlet's own listing (dated a year off): refused on purpose, never an alert.
    { url: 'https://a.com/review/old', knownOutlet: true, vettedOutlet: true, reviewLike: true, rejectedFor: 'outside-night-window', rejectedDayOffset: -400 },
    { url: 'https://a.com/review/unvouched', knownOutlet: true }, { ...base, url: 'https://unknown.com/r', knownOutlet: false }];
  assert.deepEqual(nm.gapCandidates(s, { firstSeen, now: t0 }), []);
  const later = nm.gapCandidates(s, { firstSeen, now: t0 + 16 * 60000 });
  assert.deepEqual(later.map((g) => g.url), ['https://a.com/review/x']);
  assert.equal(later[0].ageMin, 16);
});

test('recordNew alerts each URL once per kind per night', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nm-'));
  const args = { showId: BMG.id, night: '2026-11-17', kind: 'near-miss', items: [{ url: TM_URL }] };
  assert.equal(nm.recordNew(dir, args).length, 1);
  assert.equal(nm.recordNew(dir, args).length, 0);
  assert.equal(nm.recordNew(dir, { ...args, kind: 'gap' }).length, 1);
});

async function bmgReplay() {
  const fetchText = async (u) => { if (String(u) === TM_INDEX) return INDEX_HTML; throw new Error(`not recorded: ${u}`); };
  return d.runDiscoveryPass({
    show: BMG, night: '2026-11-17', now: Date.parse('2026-11-18T02:10:00Z'), startedAt: Date.parse('2026-11-18T01:30:00Z'),
    fetchText, timeZone: 'America/New_York',
    // matchOpts {fuzzy:true}: the strict matcher as it was before BRO-7739 (no main-title rule), which refused this review.
    adapters: [d.sectionIndexAdapter({ outlets: [{ outletId: 'theatermania', indexUrl: TM_INDEX }], matchOpts: { fuzzy: true } })],
  });
}

test('BMG replay (BRO-7739 reverted): the refused TheaterMania review surfaces as a near-miss, never admitted', async () => {
  const r = await bmgReplay();
  assert.ok(!(r.admitted || []).some((a) => a.url.includes('1860029')), 'old matcher should not admit it (premise of the replay)');
  const hit = (r.nearMisses || []).find((n) => n.url.includes('1860029'));
  assert.ok(hit, `near-miss missing; got ${JSON.stringify(r.nearMisses)}`);
  assert.equal(hit.outletId, 'theatermania');
  assert.ok(!(r.nearMisses || []).some((n) => n.url.includes('fantasticks')), 'other show flagged');
});

test('BMG replay: the alert names the URL and the one ingest command, on Discord and the coordinator card', async () => {
  const r = await bmgReplay();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nm-'));
  const fresh = nm.recordNew(dir, { showId: BMG.id, night: '2026-11-17', kind: 'near-miss', items: r.nearMisses });
  const sent = { discord: [], comment: [] };
  const notify = createPressSignalsNotifier({
    env: { DISCORD_WEBHOOK_ALERTS: 'https://discord.invalid/hook', LINEAR_API_KEY: 'x' }, log: () => {}, card: 'BRO-5955', fetchPage: async () => TM_PAGE,
    discord: async (_w, t) => { sent.discord.push(t); return true; }, comment: async (c, b) => { sent.comment.push([c, b]); return true; },
  });
  const out = await notify({ show: BMG, night: '2026-11-17', nearMisses: fresh, gaps: [] });
  assert.ok(out.discord && out.comment);
  const cmd = nm.ingestCommand(BMG.id, { url: TM_URL, outletId: 'theatermania' }).primary;
  for (const t of [sent.discord[0], sent.comment[0][1]]) {
    assert.ok(t.includes(TM_URL), t);
    assert.ok(t.includes(`add it: \`${cmd}\``), t);
  }
  assert.equal(sent.comment[0][0], 'BRO-5955');
  assert.ok(sent.discord[0].includes('(the page names the show)'), sent.discord[0]);
});

test('BRO-7743: the page check needs the show AND its venue or cast, outside scripts; it never blocks the alert', async () => {
  assert.equal(nm.pageNamesShow(TM_PAGE, BMG), true);
  assert.equal(nm.pageNamesShow(TM_PAGE.replace(/Lunt-Fontanne Theatre/, 'a Broadway house'), BMG), false, 'venue only inside <script> must not count');
  assert.equal(nm.pageNamesShow('<html>Just a moment...</html>', BMG), null, 'a challenge page is no evidence either way');
  const notify = createPressSignalsNotifier({ env: { LINEAR_API_KEY: 'x' }, log: () => {}, card: 'BRO-5955', fetchPage: async () => { throw new Error('403'); }, comment: async () => true });
  const out = await notify({ show: BMG, night: '2026-11-17', nearMisses: [{ url: TM_URL, outletId: 'theatermania', adapter: 'section-index', signals: ['x'] }] });
  assert.equal(out.comment, true);
  assert.ok(!/page (names|did not)/.test(out.text));
});

test('ingest command: the lane inbox when it exists, else the ingest workflow; apostrophes survive the shell', () => {
  const it = { url: "https://x.com/it's-a-review/", outletId: 'o' };
  assert.match(nm.ingestCommand('s', it, { inbox: true }).primary, /^node scripts\/opening-night-lane-inbox\.js add --show=s --url='https:\/\/x\.com\/it'\\''s-a-review\/' --outlet=o$/);
  const w = nm.ingestCommand('s', it, { inbox: false });
  assert.match(w.primary, /^node scripts\/capped-workflow-dispatch\.js --workflow=ingest-urls\.yml --priority -f show_id=s -f urls=/);
  assert.equal(w.fallback, null);
});

test('recordNew: the per-adapter cap applies after dedupe, so already-alerted URLs never starve a new one', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nm-'));
  const mk = (i, adapter = 'idx') => ({ key: `https://a.com/r${i}`, url: `https://www.a.com/r${i}/`, adapter });
  const first = nm.recordNew(dir, { showId: 's', night: 'n', kind: 'near-miss', items: [1, 2, 3, 4, 5, 6].map((i) => mk(i)), perAdapter: 5 });
  assert.equal(first.length, 5);
  const second = nm.recordNew(dir, { showId: 's', night: 'n', kind: 'near-miss', items: [1, 2, 3, 4, 5, 6, 7].map((i) => mk(i)), perAdapter: 5 });
  assert.deepEqual(second.map((x) => x.key), ['https://a.com/r6', 'https://a.com/r7']);
  // the same review under another URL form is the same key: no second alert
  assert.equal(nm.recordNew(dir, { showId: 's', night: 'n', kind: 'near-miss', items: [{ ...mk(1), url: 'https://a.com/r1' }] }).length, 0);
});

test('notifier: one failing channel does not hide the other, and nothing new sends nothing', async () => {
  const sent = [];
  const notify = createPressSignalsNotifier({ env: { DISCORD_WEBHOOK_ALERTS: 'https://discord.invalid/h', LINEAR_API_KEY: 'x' }, log: () => {}, card: 'BRO-5955',
    discord: async () => { throw new Error('down'); }, comment: async (c) => { sent.push(c); return true; } });
  const out = await notify({ show: BMG, night: '2026-11-17', nearMisses: [{ url: TM_URL, outletId: 'theatermania', adapter: 'section-index', signals: ['lead-title:Blue Man Group'] }] });
  assert.equal(out.discord, false); assert.equal(out.comment, true);
  assert.equal((await notify({ show: BMG, night: '2026-11-17' })).text, null);
});

test('notifier: a hung channel is cut off, so an alert never stalls the pass', async () => {
  const notify = createPressSignalsNotifier({ env: { DISCORD_WEBHOOK_ALERTS: 'https://discord.invalid/h', LINEAR_API_KEY: 'x' }, log: () => {}, card: 'BRO-5955', capMs: 50,
    discord: () => new Promise(() => {}), comment: async () => true });
  const t0 = Date.now();
  const out = await notify({ show: BMG, night: '2026-11-17', nearMisses: [{ url: TM_URL, outletId: 'theatermania', adapter: 'section-index', signals: ['x'] }] });
  assert.ok(Date.now() - t0 < 2000); assert.equal(out.discord, false); assert.equal(out.comment, true);
});

test('the coordinator card comes from the registry, not a hardcoded id', () => {
  const reg = require('../../scripts/lib/coordinator-registry.js').REGISTRY;
  const e = reg.find((x) => x.area === 'opening-night');
  assert.equal(require('../../scripts/lib/press-night-signals-notify.js').coordinatorCard(), e && e.card);
});

test('lane runner: near-miss alerts in the pass that sees it, a stuck known-outlet review alerts after 15 min, each once', async () => {
  const { runLaneNight } = require('../../scripts/lib/opening-night-lane/lane-runner.js');
  const NIGHT = '2026-11-17';
  const show = { id: 'test-show-2026', title: 'Test Show', category: 'broadway', market: 'broadway', openingDate: NIGHT, venue: 'Nowhere Theatre' };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nm-run-'));
  const STUCK = 'https://www.theguardian.com/stage/2026/nov/17/test-show-review-broadway';
  const NEAR = 'https://www.theatermania.com/news/review-tests-big-night_1/';
  let t = Date.parse(`${NIGHT}T23:00:00Z`);
  const calls = [];
  await runLaneNight({
    show, night: NIGHT, openingDate: NIGHT, ledgerDir: dir, maxPasses: 3,
    fetchText: async () => '<html><body>no date here</body></html>',
    adapters: [{ name: 'idx', kind: 'section-index', phase: 'main', discover: async () => [
      { url: STUCK, title: 'Test Show review: a fine night', outletId: 'guardian', source: 'outlet-index', vettedOutlet: true },
      { url: NEAR, title: 'Review: Test’s big night', outletId: 'theatermania', source: 'outlet-index', nearMiss: ['title-words:2/2'] },
    ] }],
    fetchReview: async () => { throw new Error('nothing should be admitted'); }, scoreReview: async () => 80,
    publishPorts: { updateReviews: async () => {}, regenShow: async () => {}, deploy: async () => {}, fetchLiveShow: async () => ({ rv: [] }) },
    now: () => t, wait: async (ms) => { t += Math.max(ms || 0, 8 * 60000); }, abandonPending: () => true,
    onPressSignals: async (sig) => { calls.push({ at: t, near: sig.nearMisses.map((n) => n.url), gaps: sig.gaps.map((g) => g.url) }); },
  });
  const near = calls.flatMap((c) => c.near);
  const gaps = calls.flatMap((c) => c.gaps);
  assert.deepEqual(near, [NEAR], JSON.stringify(calls));
  assert.deepEqual(gaps, [STUCK], JSON.stringify(calls));
  assert.equal(calls[0].near.length, 1, 'the near-miss must alert in the first pass');
});

// Review of BRO-7748 (post-land ship-check): Discord cut-off, copy-safe commands, kill switch, shadow wiring.
test('discordChunks keeps every line, each message under the Discord cap', async () => {
  const { discordChunks } = require('../../scripts/lib/press-night-signals-notify.js');
  const lines = Array.from({ length: 60 }, (_, i) => `line ${i} ${'x'.repeat(80)}`);
  const parts = discordChunks(lines.join('\n'));
  assert.ok(parts.length > 1);
  for (const p of parts) assert.ok(p.length <= 1900, `chunk ${p.length}`);
  assert.deepEqual(parts.join('\n').split('\n'), lines);
});

test('a long alert reaches Discord whole, in several messages', async () => {
  const { createPressSignalsNotifier } = require('../../scripts/lib/press-night-signals-notify.js');
  const sent = [];
  const notify = createPressSignalsNotifier({ env: { DISCORD_WEBHOOK_ALERTS: 'https://discord.invalid/x' }, log: () => {}, discord: async (_w, t) => { sent.push(t); return true; }, card: null, fetchPage: async () => '' });
  const nearMisses = Array.from({ length: 20 }, (_, i) => ({ url: `https://www.theatermania.com/news/r-${i}`, outletId: 'theatermania', adapter: 'rss', title: `Review ${i}`, signals: ['lead-title:X'], pageNamesShow: null }));
  const r = await notify({ show: { id: 's', title: 'S' }, night: '2026-11-17', nearMisses, gaps: [] });
  assert.equal(r.discord, true);
  assert.ok(sent.length > 1);
  for (let i = 0; i < 20; i++) assert.ok(sent.join('\n').includes(`https://www.theatermania.com/news/r-${i}`));
});

test('alert commands are in backticks so Discord shows them copy-safe', () => {
  const nm = require('../../scripts/lib/opening-night-lane/near-miss.js');
  const msg = nm.formatPressSignals({ id: 's' }, '2026-11-17', { nearMisses: [{ url: "https://x.example/a'b", outletId: 'o', adapter: 'rss', signals: ['t'] }], gaps: [] });
  assert.match(msg.description, /add it: `node scripts\/[^`]+`/);
});

test('PRESS_SIGNALS_OFF=1 silences the notifier', async () => {
  const { createPressSignalsNotifier } = require('../../scripts/lib/press-night-signals-notify.js');
  let sent = 0;
  const notify = createPressSignalsNotifier({ env: { PRESS_SIGNALS_OFF: '1', DISCORD_WEBHOOK_ALERTS: 'https://discord.invalid/x' }, log: () => {}, discord: async () => { sent++; return true; }, card: null });
  const r = await notify({ show: { id: 's' }, night: '2026-11-17', nearMisses: [{ url: 'https://x.example/a', signals: ['t'] }], gaps: [] });
  assert.equal(sent, 0); assert.equal(r.text, null);
});

test('the shadow lane wires the press-night alarm (not on replays)', () => {
  const src = fs.readFileSync(require.resolve('../../scripts/opening-night-lane-shadow.js'), 'utf8');
  assert.match(src, /onPressSignals: replay \? null : require\('\.\/lib\/press-night-signals-notify'\)\.createPressSignalsNotifier\(\)/);
});

test('nearMissFind: a show-news story (extension, casting) on a known outlet is not a missed review; a /news/review- slug still is', () => {
  const d = require('../../scripts/lib/opening-night-lane/discovery.js');
  const show = { id: 'blue-man-group-holiday-2026', title: 'Blue Man Group “A New Holiday Surprise”', venue: 'Astor Place Theatre' };
  const budget = () => ({ left: 40 });
  // BRO-7781 sim night: nystagereview is a review-without-word host, so its news items carried a review signal.
  assert.equal(d.nearMissFind({ url: 'https://nystagereview.com/news/extension-news/blue-man-group-a-holiday-spectacular-extends-through-january/', title: 'Blue Man Group “A Holiday Spectacular” extends through January' }, show, budget()), null);
  // An item with its own review word under /news/ is still judged on its signals (TheaterMania files reviews there).
  const tm = d.nearMissFind({ url: TM_URL, title: 'Review: Blue Man Group’s Broadway Christmas Show Is a Lump of Coal' }, show, budget());
  assert.ok(tm && tm.nearMiss.length, 'the BMG TheaterMania review still surfaces');
  // A host-only outlet's dated review path that the strict matcher refuses still surfaces.
  const nysr = d.nearMissFind({ url: 'https://nystagereview.com/2026/11/18/blue-man-group-a-holiday-spectacular/', title: 'Blue Man Group A Holiday Spectacular' }, show, budget());
  assert.ok(nysr && nysr.nearMiss.length, 'a review-path item on a host-only outlet still surfaces');
  // URLs nonReviewReason throws on never throw out of nearMissFind (one throw would drop the adapter's whole pass).
  for (const url of ['https://nystagereview.com//', 'https://nystagereview.com/2026/%E0%A4%A/blue-man-group-a-holiday-spectacular']) {
    assert.doesNotThrow(() => d.nearMissFind({ url, title: 'Blue Man Group A Holiday Spectacular' }, show, budget()), url);
  }
});
