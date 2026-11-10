// BRO-7171 owner challenge 2026-11-09: find the original url of reviews we
// only know from a quote, by trying free sources (not by rule).
// Run: node --test scripts/lib/gap-url-find.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const UF = require('./gap-url-find.js');

test('title tokens and slug score: whole words only, stop words dropped', () => {
  assert.deepEqual(UF.titleTokens('Julie'), ['julie']);
  assert.deepEqual(UF.titleTokens("The Curious Incident of the Dog in the Night-Time"), ['curious', 'incident', 'dog', 'night', 'time']);
  // the real Telegraph url found by the Wayback CDX scan (2026-11-09)
  assert.equal(UF.slugTitleScore('https://www.telegraph.co.uk/theatre/what-to-see/vanessa-kirby-crown-jewel-lacklustre-julie-national-theatre/', 'Julie'), 1);
  // "juliet" is not "julie"
  assert.equal(UF.slugTitleScore('https://www.telegraph.co.uk/theatre/what-to-see/juliet-shaftesbury-theatre-review-essentially-glorified-panto/', 'Julie'), 0);
});

test('date window: publishDate is tight, opening date wider, show-id year last', () => {
  assert.deepEqual(UF.dateWindow({ publishDate: '2018-06-08' }, null), { from: '20180604', to: '20180629', anchor: '20180608', anchorKind: 'publishDate' });
  assert.equal(UF.dateWindow({}, { openingDate: '2018-06-01' }).anchorKind, 'openingDate');
  assert.equal(UF.dateWindow({}, {}), null);
  assert.equal(UF.yearWindow('julie-west-end-2018').from, '20180101');
});

test('outlet profile and title-start dirs are learned from corpus urls', () => {
  const urls = [
    'https://www.telegraph.co.uk/theatre/what-to-see/nine-night-review-x/',
    'https://www.telegraph.co.uk/theatre/what-to-see/hamilton-review-y/',
    'https://www.telegraph.co.uk/culture/theatre/theatre-reviews/123/z.html',
    'https://web.archive.org/web/2018/https://www.telegraph.co.uk/theatre/a/',
  ];
  const p = UF.learnOutletProfile(urls);
  assert.deepEqual(p.hosts, ['telegraph.co.uk']);
  assert.deepEqual(p.prefixes, ['telegraph.co.uk/theatre', 'telegraph.co.uk/culture']);
  const dirs = UF.learnTitleStartDirs([{ url: urls[0], title: 'Nine Night' }, { url: urls[1], title: 'Hamilton' }]);
  assert.deepEqual(dirs, ['telegraph.co.uk/theatre/what-to-see/']);
});

test('aggregator outbound links: outlet hosts only, archive wrappers unwrapped, critic context kept', () => {
  const html = `<div><p>Dominic Cavendish, Telegraph</p><a href="https://www.telegraph.co.uk/theatre/what-to-see/julie-review/">Read</a>
    <a href="https://www.theguardian.com/stage/2018/jun/08/julie">Guardian</a>
    <a href="https://web.archive.org/web/20180609/https://www.telegraph.co.uk/theatre/what-to-see/julie-review/">dup</a></div>`;
  const links = UF.extractOutboundLinks(html, ['telegraph.co.uk']);
  assert.equal(links.length, 1);
  assert.match(links[0].context, /Cavendish/);
  const ranked = UF.rankCandidates([{ url: 'https://www.telegraph.co.uk/news/other/', context: '' }, links[0]], { title: 'Julie', criticName: 'Dominic Cavendish' });
  assert.equal(ranked[0].url, links[0].url);
});

test('CDX parsing drops amp/asset variants and urls whose slug does not name the show', () => {
  const txt = [
    'https://www.telegraph.co.uk/theatre/what-to-see/vanessa-kirby-crown-jewel-lacklustre-julie-national-theatre/ 20180608090700 200',
    'https://www.telegraph.co.uk/theatre/what-to-see/vanessa-kirby-crown-jewel-lacklustre-julie-national-theatre/amp/ 20180609080503 200',
    'https://www.telegraph.co.uk/theatre/what-to-see/juliet-stevenson-interview/ 20200729144856 200',
  ].join('\n');
  const c = UF.parseCdxCandidates(txt, 'Julie');
  assert.deepEqual(c.map((x) => x.url), ['https://www.telegraph.co.uk/theatre/what-to-see/vanessa-kirby-crown-jewel-lacklustre-julie-national-theatre/']);
});

test('index fetch retries 503 with backoff; a hard 404 is not retried', async () => {
  let n = 0;
  const deps = { fetchText: async () => { n++; if (n < 3) { const e = new Error('HTTP 503'); e.status = 503; throw e; } return 'ok'; } };
  assert.equal(await UF.fetchIndexWithRetry('q', deps, { tries: 3, baseMs: 0, sleep: async () => {} }), 'ok');
  assert.equal(n, 3);
  n = 0;
  const d404 = { fetchText: async () => { n++; const e = new Error('HTTP 404'); e.status = 404; throw e; } };
  await assert.rejects(UF.fetchIndexWithRetry('q', d404, { baseMs: 0, sleep: async () => {} }), /404/);
  assert.equal(n, 1);
});

test('WAYBACK_CDX: an index outage is an error (not "nothing found"), so it never counts as tried', async () => {
  const ctx = { review: { showId: 'julie-west-end-2018', outletId: 'telegraph', publishDate: '2018-06-08' }, show: null, title: 'Julie',
    profile: { hosts: ['telegraph.co.uk'], prefixes: ['telegraph.co.uk/theatre'] }, hosts: ['telegraph.co.uk'], titleDirs: [] };
  const down = { fetchText: async () => { const e = new Error('HTTP 503'); e.status = 503; throw e; }, indexRetry: { baseMs: 0, sleep: async () => {} } };
  const r = await UF.runMethod('WAYBACK_CDX', ctx, down);
  assert.equal(r.candidates.length, 0);
  assert.match(r.error, /503/);
  // the same scan answering finds the review
  const up = { fetchText: async () => 'https://www.telegraph.co.uk/theatre/what-to-see/vanessa-kirby-crown-jewel-lacklustre-julie-national-theatre/ 20180608090700 200\n', indexRetry: { baseMs: 0, sleep: async () => {} } };
  const r2 = await UF.runMethod('WAYBACK_CDX', ctx, up);
  assert.equal(r2.error, null);
  assert.equal(r2.candidates[0].url, 'https://www.telegraph.co.uk/theatre/what-to-see/vanessa-kirby-crown-jewel-lacklustre-julie-national-theatre/');
});

test('url-find progress: union of live rows, errors and paid skips do not count; eligibility cools down', () => {
  const all = Object.fromEntries(UF.METHODS.map((m) => [m, 'no_candidates']));
  const row = (methods, ts, outcome = 'no_evidence') => ({ strategy: 'URL_FIND', outcome, ts, runId: 'r', detail: { policy: UF.URL_FIND_POLICY, methods } });
  // a row written under older evidence rules (no policy) never counts as done
  assert.equal(UF.urlFindProgress([{ strategy: 'URL_FIND', outcome: 'no_evidence', ts: '2026-11-09T01:00:00Z', detail: { methods: Object.fromEntries(UF.METHODS.map((m) => [m, 'no_candidates'])) } }]).missing.length, UF.METHODS.length);
  const now = Date.parse('2026-11-10T12:00:00Z');
  assert.deepEqual(UF.urlFindProgress([row({ ...all, SERP: 'skipped_paid' }, '2026-11-09T01:00:00Z')]).missing, ['SERP']);
  assert.deepEqual(UF.urlFindProgress([row({ ...all, SERP: 'skipped_paid' }, '2026-11-09T01:00:00Z'), row({ SERP: 'candidates_refused' }, '2026-11-10T01:00:00Z')]).missing, []);
  assert.deepEqual(UF.urlFindProgress([row({ ...all, WAYBACK_CDX: 'error' }, '2026-11-09T01:00:00Z')]).missing, ['WAYBACK_CDX']);
  // a non-evidence row (every method errored) carries nothing
  assert.equal(UF.urlFindProgress([row(all, '2026-11-09T01:00:00Z', 'non_evidence')]).missing.length, UF.METHODS.length);
  assert.equal(UF.urlFindEligibility([row({ AGG_LINK: 'no_candidates' }, '2026-11-10T06:00:00Z')], { nowMs: now }).reason, 'url_find_cooldown');
  assert.equal(UF.urlFindEligibility([row({ AGG_LINK: 'no_candidates' }, '2026-11-09T06:00:00Z')], { nowMs: now }).ok, true);
  assert.equal(UF.urlFindEligibility([row(all, '2026-11-09T06:00:00Z')], { nowMs: now }).reason, 'url_find_exhausted');
  // ship-check P1: a later night that FOUND a link undoes the method's earlier "nothing found"
  const later = row({ WAYBACK_CDX: 'found_unreadable' }, '2026-11-10T01:00:00Z', 'non_evidence');
  assert.deepEqual(UF.urlFindProgress([row(all, '2026-11-09T01:00:00Z'), later]).missing, ['WAYBACK_CDX']);
  // ...and an error on a later night undoes nothing
  assert.deepEqual(UF.urlFindProgress([row(all, '2026-11-09T01:00:00Z'), row({ WAYBACK_CDX: 'error' }, '2026-11-10T01:00:00Z')]).missing, []);
  // a found-but-unreadable link waits a week, not a night (0 = manual override)
  const unread = { ...row({ AGG_LINK: 'found_unreadable' }, '2026-11-07T06:00:00Z', 'non_evidence'), detail: { methods: { AGG_LINK: 'found_unreadable' }, foundUnreadable: [{ url: 'u', code: 'paywall' }] } };
  assert.equal(UF.urlFindEligibility([unread], { nowMs: now }).reason, 'url_find_unreadable_cooldown');
  assert.equal(UF.urlFindEligibility([unread], { nowMs: now, cooldownH: 0 }).ok, true);
  assert.equal(UF.urlFindEligibility([unread], { nowMs: now + 7 * 86400000 }).ok, true);
});
