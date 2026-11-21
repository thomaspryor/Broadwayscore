/**
 * BRO-7945 (follow-up to BRO-7930). Part B: the _pending drain fetched the same article once per
 * same-title production and re-judged every copy forever. Part A: scored, includable files that
 * rebuild drops with no recorded reason. These tests drive the REAL processShow(), the real
 * siblingForArticle/makeFetchCache and the real findScoredAbsent; no network.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const replay = require('../replay-pending-bylines.js');
const { makeFetchCache, siblingForArticle } = require('./pending-sibling-productions.js');
const { findScoredAbsent, summarizeScoredAbsent } = require('./scored-absent.js');
const { explainRecoveryExclusion } = require('./recovery-exclusions.js');

const NOW = new Date('2026-11-21T12:00:00Z');
const mk = (id, open, close) => ({ id, title: 'A Streetcar Named Desire', venue: 'V', openingDate: open, previewsStartDate: open, closingDate: close, category: 'broadway', market: 'broadway', status: 'closed' });
const S1992 = mk('a-streetcar-named-desire-1992', '1992-04-12', '1992-08-30');
const S2005 = mk('a-streetcar-named-desire-2005', '2005-04-26', '2005-07-24');
const S2025 = mk('a-streetcar-named-desire-2025', '2025-03-01', '2025-06-01');
const ALL = [S1992, S2005, S2025];
const URL_ = 'https://ew.com/theater/a-streetcar-named-desire-review-2025-03-11/';
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

test('siblingForArticle: same title+market, in window, has a copy', () => {
  assert.equal(siblingForArticle(S1992, ALL, '2025-03-11').id, S2025.id);
  assert.equal(siblingForArticle(S1992, ALL, '2025-03-11', { hasCopy: () => false }), null);
  assert.equal(siblingForArticle(S1992, ALL, '1999-01-01'), null);
  assert.equal(siblingForArticle(S1992, [{ ...S2025, market: 'west-end' }], '2025-03-11'), null);
});

test('makeFetchCache caches a thrown error too (no second paid try)', async () => {
  let n = 0; const f = makeFetchCache(async () => { n++; throw new Error('boom'); });
  await assert.rejects(f('u')); await assert.rejects(f('u'));
  assert.equal(n, 1);
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
