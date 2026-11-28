// BRO-8449 (a)(b): included reviews whose url names another place. require()s the real
// selector, alert builder and the reverify flag's selector; fixtures are synthetic (no review text).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
process.on('exit', require('./shows-json-fixture.js').useShowsFixture([]));
const { classifyUrlPlaceFile, collectUrlPlaceHits, unjudged, contradicted, selectUrlPlaceUnjudged, urlPlaceMayStoreExclusion, loadAcks, ACK_FILE } = require('./url-place-included.js');
const { decideUrlPlaceAlerts, UNJUDGED_KEY, CONTRADICTED_KEY } = require('./url-place-included-alert.js');

const SHOW = { id: 'peter-pan-off-west-end-2026', title: 'Peter Pan', category: 'off-west-end', venue: 'Polka Theatre', previewsStartDate: '2026-11-14', openingDate: '2026-11-14' };
const URL_BRUM = 'https://www.thereviewshub.com/peter-pan-birmingham-rep/';
const base = { url: URL_BRUM, outletId: 'thereviewshub', publishDate: '2026-11-25', fullText: 'x'.repeat(300) };

test('classify: no verdict and a stale verdict are unjudged; fresh right-production is contradicted; fresh wrong is flagged', () => {
  assert.deepEqual(classifyUrlPlaceFile(base, SHOW), { place: 'birmingham-rep', state: 'unjudged' });
  const stale = { ...base, textFetchedAt: '2026-11-27T10:00:00Z', contentVerification: { wrongProduction: false, verifiedAt: '2026-11-26T10:00:00Z' } };
  assert.equal(classifyUrlPlaceFile(stale, SHOW).state, 'unjudged');
  const right = { ...base, contentVerification: { wrongProduction: false, verifiedAt: '2026-11-26T10:00:00Z' } };
  assert.equal(classifyUrlPlaceFile(right, SHOW).state, 'contradicted');
  const wrong = { ...base, contentVerification: { wrongProduction: true, verifiedAt: '2026-11-26T10:00:00Z' } };
  assert.equal(classifyUrlPlaceFile(wrong, SHOW).state, 'flagged');
  assert.equal(classifyUrlPlaceFile({ ...base, wrongProduction: true }, SHOW).state, 'flagged');
});

test('classify: a url naming the venue or home market, a show with no home market, or no url is not a hit', () => {
  assert.equal(classifyUrlPlaceFile({ ...base, url: 'https://x.com/peter-pan-polka-theatre-review/' }, SHOW), null);
  assert.equal(classifyUrlPlaceFile({ ...base, url: undefined }, SHOW), null);
  assert.equal(classifyUrlPlaceFile(base, { ...SHOW, category: 'tour' }), null);
});

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'urlplace-'));
  fs.mkdirSync(path.join(dir, SHOW.id));
  const w = (f, o) => fs.writeFileSync(path.join(dir, SHOW.id, f), JSON.stringify(o));
  w('a--one.json', base);
  w('b--two.json', { ...base, url: URL_BRUM + '2/', contentVerification: { wrongProduction: false, verifiedAt: '2026-11-26T10:00:00Z' } });
  w('c--three.json', { ...base, url: 'https://x.com/peter-pan-polka-theatre-review/' });
  w('d--four.json', { ...base, url: URL_BRUM + '4/' }); // not in reviews.json: excluded, never a hit
  const reviews = [URL_BRUM, URL_BRUM + '2/', 'https://x.com/peter-pan-polka-theatre-review/'].map((url) => ({ showId: SHOW.id, url }));
  return { dir, reviews };
}

test('collect: joins included reviews to files; acks remove a hit from both lists; unjudged feeds the reverify queue', () => {
  const { dir, reviews } = fixture();
  const hits = collectUrlPlaceHits({ reviews, shows: [SHOW], reviewTextsDir: dir });
  assert.deepEqual(hits.map((h) => `${h.file}:${h.state}`).sort(), ['a--one.json:unjudged', 'b--two.json:contradicted']);
  assert.deepEqual(selectUrlPlaceUnjudged({ reviews, shows: [SHOW], reviewTextsDir: dir }), [{ showId: SHOW.id, file: 'a--one.json' }]);
  const acked = collectUrlPlaceHits({ reviews, shows: [SHOW], reviewTextsDir: dir, acks: { [`${SHOW.id}/a--one.json`]: 'transfer', [`${SHOW.id}/b--two.json`]: 'roundup' } });
  assert.equal(unjudged(acked).length, 0);
  assert.equal(contradicted(acked).length, 0);
});

test('alert: rows route under their own keys; empty lists resolve; rows carry no text', () => {
  const { dir, reviews } = fixture();
  const hits = collectUrlPlaceHits({ reviews, shows: [SHOW], reviewTextsDir: dir });
  const d = decideUrlPlaceAlerts({ unjudged: unjudged(hits), contradicted: contradicted(hits) });
  assert.deepEqual(d.map((x) => [x.action, x.alert ? x.alert.conditionKey : x.conditionKey]), [['route', UNJUDGED_KEY], ['route', CONTRADICTED_KEY]]);
  assert.match(d[0].alert.description, /peter-pan-off-west-end-2026\/a--one\.json: url names birmingham rep/);
  assert.deepEqual(decideUrlPlaceAlerts({ unjudged: [], contradicted: [] }).map((x) => x.action), ['resolve', 'resolve']);
});

test('loadAcks reads the judged map and fails soft on a missing or broken file', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'acks-'));
  const good = path.join(dir, 'ok.json');
  fs.writeFileSync(good, JSON.stringify({ judged: { 'show-a/outlet--x.json': 'transfer, same production' } }));
  assert.deepEqual(loadAcks(good), { 'show-a/outlet--x.json': 'transfer, same production' });
  fs.writeFileSync(path.join(dir, 'bad.json'), '{not json');
  assert.deepEqual(loadAcks(path.join(dir, 'bad.json')), {});
  assert.deepEqual(loadAcks(path.join(dir, 'missing.json')), {});
  assert.ok(typeof ACK_FILE === 'string' && ACK_FILE.endsWith('url-place-judged.json'));
});

test('urlPlaceMayStoreExclusion: high-confidence wrongProduction stores even though isValid is false; others are held', () => {
  assert.equal(urlPlaceMayStoreExclusion({ isValid: false, wrongProduction: true, confidence: 'high' }), true);
  assert.equal(urlPlaceMayStoreExclusion({ isValid: false, wrongProduction: true, confidence: 'low' }), false);
  assert.equal(urlPlaceMayStoreExclusion({ isValid: false, wrongProduction: true, confidence: 'high', wrongArticle: true }), false);
  assert.equal(urlPlaceMayStoreExclusion({ isValid: false, wrongProduction: true, confidence: 'high', isFilmTv: true }), false);
  assert.equal(urlPlaceMayStoreExclusion({ isValid: true, wrongProduction: false, confidence: 'high' }), false);
  assert.equal(urlPlaceMayStoreExclusion(null), false);
});
