// BRO-7942: priority bands, retry backoff, URL_FIND slice, identical-refetch proof, tier-gain.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const PO = require('./gap-plan-order.js');
const UF = require('./gap-url-find.js');
const L = require('./gap-recovery-ledger.js');
const T = require('./gap-strategy-table.js');

const H = 3600e3;
const NOW = Date.parse('2026-11-21T06:00:00Z');
const cand = (o) => ({ showDate: '2026-01-01', strategy: 'REFETCH_FREE', attempts: 0, lastTryMs: 0, tier: 3, ...o });

test('band order: floor+recent, other recent, floor+historic, rest', () => {
  const c = [
    cand({ reviewKey: 'old-2019/blog--a.json', showId: 'old-2019', outletId: 'someblog', recency: 'historic', tier: 4 }),
    cand({ reviewKey: 'old-2019/nytimes--a.json', showId: 'old-2019', outletId: 'nytimes', recency: 'historic', tier: 1 }),
    cand({ reviewKey: 'new-2026/blog--a.json', showId: 'new-2026', outletId: 'someblog', recency: 'recent', tier: 4 }),
    cand({ reviewKey: 'new-2026/nytimes--a.json', showId: 'new-2026', outletId: 'nytimes', recency: 'recent', tier: 1 }),
  ];
  c.sort(PO.compareByBand());
  assert.deepEqual(c.map((x) => PO.bandOf(x)), [1, 2, 3, 4]);
  assert.deepEqual(c.map((x) => x.reviewKey), ['new-2026/nytimes--a.json', 'new-2026/blog--a.json', 'old-2019/nytimes--a.json', 'old-2019/blog--a.json']);
});

test('inside a band never-attempted goes before retries; band 4 sorts by outlet tier', () => {
  const c = [
    cand({ reviewKey: 'x-2026/nytimes--retry.json', showId: 'x-2026', outletId: 'nytimes', recency: 'recent', attempts: 3, lastTryMs: NOW - H }),
    cand({ reviewKey: 'y-2026/nytimes--fresh.json', showId: 'y-2026', outletId: 'nytimes', recency: 'recent', showDate: '2025-01-01' }),
  ];
  c.sort(PO.compareByBand());
  assert.equal(c[0].reviewKey, 'y-2026/nytimes--fresh.json');
  const rest = [
    cand({ reviewKey: 'o-2019/t3.json', showId: 'o-2019', outletId: 'b3', recency: 'historic', tier: 3 }),
    cand({ reviewKey: 'o-2019/t1.json', showId: 'o-2019', outletId: 'b1', recency: 'historic', tier: 1 }),
    cand({ reviewKey: 'o-2019/t4.json', showId: 'o-2019', outletId: 'b4', recency: 'historic', tier: 4 }),
  ].sort(PO.compareByBand());
  assert.deepEqual(rest.map((x) => x.tier), [1, 3, 4]);
});

test('driver sort and gap-strategy-table share the one comparator (no second order)', () => {
  const a = cand({ reviewKey: 'a-2026/nytimes--a.json', showId: 'a-2026', outletId: 'nytimes', recency: 'recent' });
  const b = cand({ reviewKey: 'b-2026/blog--a.json', showId: 'b-2026', outletId: 'someblog', recency: 'recent' });
  assert.equal(T.compareCandidates(a, b), PO.compareByBand({ costOf: () => 0 })(a, b));
  assert.ok(T.compareCandidates(a, b) < 0);
});

test('a never-attempted floor gap lands in the first URL_FIND slots, even beyond the paid cap (free slots keep their place)', () => {
  const retried = Array.from({ length: 14 }, (_, i) => cand({
    reviewKey: `r${i}-2026/times-uk--a.json`, showId: `r${i}-2026`, outletId: 'times-uk', recency: 'recent', strategy: 'URL_FIND',
    attempts: 5, lastTryMs: NOW - 30 * H, urlFindLastTryMs: NOW - 30 * H, showDate: `2026-06-${10 + i}`,
  }));
  const fresh = cand({ reviewKey: 'fresh-2026/times-uk--clive.json', showId: 'fresh-2026', outletId: 'times-uk', recency: 'recent', strategy: 'URL_FIND', showDate: '2026-01-01' });
  const work = [...retried, fresh].sort(PO.compareByBand());
  const plan = UF.planUrlFindWork(work, { paidSlots: 12, freeSlots: 24, tierOf: () => 1, freeInPlace: true });
  assert.equal(plan[0].reviewKey, 'fresh-2026/times-uk--clive.json', 'never-tried floor gap is first');
  assert.equal(plan.length, 15, 'every URL_FIND inside the slot caps stays in the run');
  assert.ok(plan.slice(0, 12).every((c) => c.urlFindFreeOnly === false));
  assert.equal(plan[13].urlFindFreeOnly, true);
  // legacy layout (free at the end) still available
  const legacy = UF.planUrlFindWork(work, { paidSlots: 1, freeSlots: 1, tierOf: () => 1 });
  assert.equal(legacy.length, 2);
});

test('backoff: no_evidence waits 36h, then 72h, then 144h; never two nights running', () => {
  const row = (hoursAgo, outcome = 'no_evidence') => ({ strategy: 'URL_FIND', outcome, reason: 'url_not_found', ts: new Date(NOW - hoursAgo * H).toISOString(), url: null });
  assert.equal(PO.backoffGate([row(24)], 'URL_FIND', { nowMs: NOW }).ok, false, 'last night: blocked');
  assert.equal(PO.backoffGate([row(40)], 'URL_FIND', { nowMs: NOW }).ok, true, 'after 36h: open');
  const two = [row(100), row(40)];
  assert.equal(PO.backoffGate(two, 'URL_FIND', { nowMs: NOW }).ok, false, 'second failure waits 72h');
  assert.equal(PO.backoffGate([row(100), row(80)], 'URL_FIND', { nowMs: NOW }).ok, true);
  assert.equal(PO.backoffHours(30), PO.BACKOFF_CAP_H, 'capped');
  // another strategy is unaffected; non-evidence rows neither count nor reset
  assert.equal(PO.backoffGate([row(24)], 'ARCHIVE', { nowMs: NOW }).ok, true);
  assert.equal(PO.backoffGate([row(24), { ...row(2), outcome: 'non_evidence', reason: 'file_vanished' }], 'URL_FIND', { nowMs: NOW }).ok, false);
});

test('backoff: new evidence (stored url changed) or a recovery resets it', () => {
  const r = { strategy: 'REFETCH_FREE', outcome: 'rejected', reason: 'not_longer', ts: new Date(NOW - 2 * H).toISOString(), url: 'https://a.example/old' };
  assert.equal(PO.backoffGate([r], 'REFETCH_FREE', { nowMs: NOW, reviewUrl: 'https://a.example/old' }).ok, false);
  assert.equal(PO.backoffGate([r], 'REFETCH_FREE', { nowMs: NOW, reviewUrl: 'https://a.example/new' }).ok, true);
  const ok = { ...r, outcome: 'recovered', reason: 'landed_on_origin_main', detail: { tierImproved: true } };
  assert.equal(PO.noGainStreak([r, { ...r, outcome: 'pending_push' }, ok], 'REFETCH_FREE').n, 0);
  // a recovery that did not raise the tier counts as a no-gain try
  assert.equal(PO.noGainStreak([{ ...ok, detail: { tierImproved: false } }], 'REFETCH_FREE').n, 1);
});

test('slot split: retries vs new items', () => {
  assert.deepEqual(PO.slotSplit([{ attempts: 0 }, { attempts: 2 }, {}, { attempts: 1 }]), { retry: 2, new: 2 });
});

test('URL_FIND time slice: 15 min default, env override, 0 disables URL_FIND', () => {
  assert.equal(PO.urlFindSliceMs({}), 15 * 60000);
  assert.equal(PO.urlFindSliceExhausted(14 * 60000, {}), false);
  assert.equal(PO.urlFindSliceExhausted(15 * 60000, {}), true);
  assert.equal(PO.urlFindSliceMs({ GAP_URL_FIND_SLICE_MIN: '30' }), 30 * 60000);
});

test('the driver wires the slice, backoff and band comparator (guards against unwiring)', async () => {
  const fs = await import('node:fs');
  const src = fs.readFileSync(new URL('../gap-recovery-driver.js', import.meta.url), 'utf8');
  for (const needle of ['PO.urlFindSliceExhausted(urlFindSpentMs)', 'PO.backoffGate(', 'PO.identicalRefetchProof(', 'PO.slotSplit(', 'freeInPlace: true', 'landedImproved']) {
    assert.ok(src.includes(needle), `driver lost ${needle}`);
  }
});

test('identical refetch proof: two not_longer refusals with one text hash; a hashless or differing pair is no proof', () => {
  const r = (h) => ({ strategy: 'REFETCH_FREE', outcome: 'rejected', reason: 'not_longer', detail: h ? { fetchedHash: h } : {} });
  assert.equal(PO.identicalRefetchProof([r('aa'), r('aa')]).ok, true);
  assert.equal(PO.identicalRefetchProof([r('aa'), r('bb')]).ok, false);
  assert.equal(PO.identicalRefetchProof([r(null), r(null)]).ok, false);
});

test('tier gain: recovered only when the tier rises', () => {
  assert.equal(L.tierImproved('truncated', 'complete'), true);
  assert.equal(L.tierImproved('truncated', 'truncated'), false);
  assert.equal(L.tierImproved('complete', 'truncated'), false);
  assert.equal(L.tierImproved(null, 'stub'), true);
  const row = L.recoveredRowFromLanding({ path: '/x/show-2026/nytimes--a.json', commit: 'abc' }, { strategy: 'REFETCH_FREE', priorTier: 'truncated', newTier: 'truncated' });
  assert.equal(row.detail.tierImproved, false);
  assert.equal(L.recoveredRowFromLanding({ path: '/x/show-2026/nytimes--a.json' }, { strategy: 'ARCHIVE' }).detail, undefined);
});

test('ship-check: browser_unavailable rows are not attempts; URL_FIND found-link urls do not reset backoff; permanent reasons are not hidden', async () => {
  assert.equal(PO.attemptFacts([{ strategy: 'BROWSER_SESSION', outcome: 'browser_unavailable', ts: new Date(NOW).toISOString() }]).attempts, 0);
  const rej = { strategy: 'URL_FIND', outcome: 'rejected', reason: 'x', ts: new Date(NOW - 2 * H).toISOString(), url: 'https://found.example/a' };
  assert.equal(PO.backoffGate([rej], 'URL_FIND', { nowMs: NOW, reviewUrl: null }).ok, false);
  assert.equal(PO.backoffGate([{ ...rej, strategy: 'URL_FIND' }], 'URL_FIND', { nowMs: NOW, reviewUrl: 'https://stored.example/z' }).ok, false, 'found link != stored url is not new evidence');
  const fs = await import('node:fs');
  const src = fs.readFileSync(new URL('../gap-recovery-driver.js', import.meta.url), 'utf8');
  assert.ok(src.indexOf('const e = baseEligible(strategy)') < src.indexOf('PO.backoffGate('), 'base eligibility is checked before backoff');
});

test('codex review: regex does not backtrack on long name tokens; proof is per url; pending_push is neutral in the streak; code tail never eats prose', async () => {
  const T = require('./trailer-signatures.js');
  const prose = 'The staging is confident and the second act lands every beat it reaches for. '.repeat(10);
  const t0 = Date.now();
  T.stripKnownTrailers(`${prose} Photo credit: ChristopherMitchellPhotographyAllRightsReservedChristopherMitchellPhotography (c) 2026`, 'x');
  assert.ok(Date.now() - t0 < 500, 'no catastrophic backtracking');
  const cut = `${prose} window.dataLayer = window.dataLayer || []; The actors stumble. Hamlet stranded, and the`;
  assert.equal(T.stripFurnitureTail(cut), cut, 'prose after script residue is kept (stays truncated)');
  const rf = (url) => ({ strategy: 'REFETCH_FREE', outcome: 'rejected', reason: 'not_longer', url, detail: { fetchedHash: 'h' } });
  assert.equal(PO.identicalRefetchProof([rf('https://a.example/old'), rf('https://a.example/old')], { reviewUrl: 'https://a.example/new' }).ok, false);
  assert.equal(PO.identicalRefetchProof([rf('https://a.example/old'), rf('https://a.example/old')], { reviewUrl: 'https://a.example/old' }).ok, true);
  const rec = { strategy: 'ARCHIVE', outcome: 'recovered', detail: { tierImproved: false } };
  const pend = { strategy: 'ARCHIVE', outcome: 'pending_push' };
  assert.equal(PO.noGainStreak([pend, rec, pend, rec], 'ARCHIVE').n, 2);
});
