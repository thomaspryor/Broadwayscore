/**
 * BRO-4485: backfill-unknown-critics Phase B was stuck. It took
 * unknownCritics.slice(0, limit) in directory order with no memory of
 * attempts, so every 4x-daily run re-fetched the same head of the list and
 * ~1,155 Unknown reviews were never reached. Its writes also skipped the
 * writer's guards and deleted the --unknown file when a named one existed.
 *
 * orderCriticCandidates: open shows first, flagged files out, a stamped
 * attempt cools down. applyPageByline: the only write path, guarded.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { orderCriticCandidates, CRITIC_RETRY_DAYS, FETCH_ERROR_RETRY_DAYS } = require('../../scripts/backfill-unknown-critics');
const { applyPageByline, pageBylineRefusal } = require('../../scripts/lib/review-file-writer');

const NOW = Date.parse('2026-10-01T12:00:00Z');
const daysAgo = d => new Date(NOW - d * 86400000).toISOString();
const e = (dir, file, data = {}) => ({ dir, file, data: { criticName: 'Unknown', url: `https://x.com/${file}`, ...data } });

describe('orderCriticCandidates', () => {
  test('open shows first, then never-attempted, then oldest attempt', () => {
    const list = [
      e('closed-a', 'a--unknown.json', { criticBackfillAttempt: { at: daysAgo(40), result: 'no-author' } }),
      e('closed-b', 'b--unknown.json'),
      e('open-c', 'c--unknown.json', { criticBackfillAttempt: { at: daysAgo(30), result: 'no-author' } }),
      e('open-d', 'd--unknown.json'),
    ];
    const out = orderCriticCandidates(list, { openShowIds: new Set(['open-c', 'open-d']), now: NOW });
    assert.deepEqual(out.map(x => x.dir), ['open-d', 'open-c', 'closed-b', 'closed-a']);
  });

  test(`an attempt inside ${CRITIC_RETRY_DAYS} days is not retried`, () => {
    const list = [
      e('s', 'recent--unknown.json', { criticBackfillAttempt: { at: daysAgo(3), result: 'no-author' } }),
      e('s', 'old--unknown.json', { criticBackfillAttempt: { at: daysAgo(CRITIC_RETRY_DAYS + 1), result: 'no-author' } }),
    ];
    assert.deepEqual(orderCriticCandidates(list, { now: NOW }).map(x => x.file), ['old--unknown.json']);
  });

  test(`a fetch error cools down for ${FETCH_ERROR_RETRY_DAYS} day, not ${CRITIC_RETRY_DAYS} (scraper outage must not park the backlog)`, () => {
    const list = [
      e('s', 'fetch--unknown.json', { criticBackfillAttempt: { at: daysAgo(FETCH_ERROR_RETRY_DAYS + 0.5), result: 'fetch-error' } }),
      e('s', 'noauthor--unknown.json', { criticBackfillAttempt: { at: daysAgo(FETCH_ERROR_RETRY_DAYS + 0.5), result: 'no-author' } }),
    ];
    assert.deepEqual(orderCriticCandidates(list, { now: NOW }).map(x => x.file), ['fetch--unknown.json']);
  });

  test('flagged, locked and hand-set files are never candidates', () => {
    const list = [
      e('s', 'a--unknown.json', { wrongProduction: true }),
      e('s', 'b--unknown.json', { duplicateOf: 'b--x.json' }),
      e('s', 'c--unknown.json', { _locked: true }),
      e('s', 'd--unknown.json', { criticNameManual: true }),
      e('s', 'ok--unknown.json'),
    ];
    assert.deepEqual(orderCriticCandidates(list, { now: NOW }).map(x => x.file), ['ok--unknown.json']);
  });
});

function setup(files, show = 'bro-4485-backfill-show') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bro-4485-bf-'));
  const showDir = path.join(dir, show);
  fs.mkdirSync(showDir, { recursive: true });
  for (const [name, data] of Object.entries(files)) {
    fs.writeFileSync(path.join(showDir, name), JSON.stringify({ showId: show, ...data }, null, 2));
  }
  return { show, showDir, fp: name => path.join(showDir, name), read: name => JSON.parse(fs.readFileSync(path.join(showDir, name), 'utf8')), list: () => fs.readdirSync(showDir).sort() };
}

describe('applyPageByline', () => {
  const GUARDIAN = 'https://www.theguardian.com/stage/2026/sep/17/thelma-and-louise-review-young-vic-london-musical';

  test('names and renames a Guardian --unknown file (Arifa Akbar, read off the live page)', () => {
    const t = setup({ 'guardian--unknown.json': { outletId: 'guardian', outlet: 'The Guardian', criticName: 'Unknown', url: GUARDIAN, assignedScore: 60 } });
    const data = t.read('guardian--unknown.json');
    const r = applyPageByline(t.fp('guardian--unknown.json'), data, { showId: t.show, criticName: 'Arifa Akbar', source: 'http-fetch' });
    assert.equal(r.applied, true);
    assert.deepEqual(t.list(), ['guardian--arifa-akbar.json']);
    const d = t.read('guardian--arifa-akbar.json');
    assert.equal(d.criticName, 'Arifa Akbar');
    assert.equal(d.assignedScore, 60, 'score and other fields survive the rename');
    assert.equal(d.criticEnrichedFrom, 'page-byline:http-fetch');
  });

  test('dryRun changes nothing', () => {
    const t = setup({ 'guardian--unknown.json': { outletId: 'guardian', criticName: 'Unknown', url: GUARDIAN } });
    const r = applyPageByline(t.fp('guardian--unknown.json'), t.read('guardian--unknown.json'), { showId: t.show, criticName: 'Arifa Akbar', dryRun: true });
    assert.equal(r.applied, true);
    assert.deepEqual(t.list(), ['guardian--unknown.json']);
  });

  test('an aggregator round-up URL never names the outlet file', () => {
    const t = setup({ 'nytimes--unknown.json': { outletId: 'nytimes', criticName: 'Unknown', url: 'https://www.broadwayworld.com/article/Review-Roundup-DEGENERATES-World-Premiere-Off-Broadway-20260929' } });
    const r = applyPageByline(t.fp('nytimes--unknown.json'), t.read('nytimes--unknown.json'), { showId: t.show, criticName: 'Helen Shaw' });
    assert.equal(r.applied, false);
    assert.equal(r.reason, 'aggregator-url');
    assert.deepEqual(t.list(), ['nytimes--unknown.json']);
  });

  test("a URL on another outlet's domain is refused", () => {
    const t = setup({ 'nytimes--unknown.json': { outletId: 'nytimes', criticName: 'Unknown', url: GUARDIAN } });
    assert.equal(pageBylineRefusal(t.fp('nytimes--unknown.json'), t.read('nytimes--unknown.json'), { showId: t.show, criticName: 'Arifa Akbar' }), 'url-other-outlet');
  });

  test('WhatsOnStage: the name must appear in the stored review text', () => {
    const url = 'https://www.whatsonstage.com/news/tartuffe-remixed-with-mark-rylance-at-marylebone-theatre-review_1731492/';
    const t = setup({ 'whatsonstage--unknown.json': { outletId: 'whatsonstage', criticName: 'Unknown', url, fullText: 'Mark Rylance leads a lively Tartuffe.' } });
    assert.equal(pageBylineRefusal(t.fp('whatsonstage--unknown.json'), t.read('whatsonstage--unknown.json'), { showId: t.show, criticName: 'Alun Hood' }), 'rotating-byline-unconfirmed');
    const t2 = setup({ 'whatsonstage--unknown.json': { outletId: 'whatsonstage', criticName: 'Unknown', url, fullText: 'Alun Hood. Mark Rylance leads a lively Tartuffe.' } });
    assert.equal(pageBylineRefusal(t2.fp('whatsonstage--unknown.json'), t2.read('whatsonstage--unknown.json'), { showId: t2.show, criticName: 'Alun Hood' }), null);
    // ...or the article text extracted on this same fetch.
    assert.equal(pageBylineRefusal(t.fp('whatsonstage--unknown.json'), t.read('whatsonstage--unknown.json'), { showId: t.show, criticName: 'Alun Hood', pageText: 'By Alun Hood. Rylance is superb.' }), null);
  });

  test('a flagged file is never named and nothing is deleted when a named file exists', () => {
    const t = setup({
      'guardian--unknown.json': { outletId: 'guardian', criticName: 'Unknown', url: GUARDIAN, assignedScore: 60 },
      'guardian--arifa-akbar.json': { outletId: 'guardian', criticName: 'Arifa Akbar', url: GUARDIAN + '?x=1', wrongProduction: true },
    });
    const r = applyPageByline(t.fp('guardian--unknown.json'), t.read('guardian--unknown.json'), { showId: t.show, criticName: 'Arifa Akbar' });
    assert.equal(r.applied, false);
    assert.deepEqual(t.list(), ['guardian--arifa-akbar.json', 'guardian--unknown.json']);
    const t2 = setup({ 'guardian--unknown.json': { outletId: 'guardian', criticName: 'Unknown', url: GUARDIAN, wrongProduction: true } });
    assert.equal(applyPageByline(t2.fp('guardian--unknown.json'), t2.read('guardian--unknown.json'), { showId: t2.show, criticName: 'Arifa Akbar' }).reason, 'flagged');
  });
});
