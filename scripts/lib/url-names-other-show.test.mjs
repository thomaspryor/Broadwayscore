import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const { urlNamesOtherShow } = createRequire(import.meta.url)('./url-names-other-show.js');

const own = { id: 'a-month-in-the-country-west-end-2026', title: 'A Month in the Country' };
const care = { id: 'care-west-end-2026', title: 'Care Home Stories' };
const zeldin = { id: 'zeldin-care-west-end-2026', title: 'Care' };

test('BRO-2746 fixture: Stage CARE URL filed under A Month in the Country is caught', () => {
  const care2 = { id: 'care-west-end-2026', title: 'Care Review Young Vic' };
  const hit = urlNamesOtherShow('https://www.thestage.co.uk/reviews/care-review-young-vic-london-alexander-zeldin', own, [care2]);
  assert.equal(hit.showId, 'care-west-end-2026');
});
test('URL naming its own show is clean', () => {
  assert.equal(urlNamesOtherShow('https://www.thestage.co.uk/reviews/a-month-in-the-country-review-donmar-warehouse', own, [care]), null);
});
test('one-word titles never fire (generic-word rubber stamp)', () => {
  assert.equal(urlNamesOtherShow('https://x.com/reviews/care-review-young-vic', own, [zeldin]), null);
});
test('own title present wins even if another show is also named', () => {
  const both = 'https://x.com/a-month-in-the-country-vs-care-home-stories';
  assert.equal(urlNamesOtherShow(both, own, [care]), null);
});
test('bad url / empty candidates are safe', () => {
  assert.equal(urlNamesOtherShow('not a url', own, [care]), null);
  assert.equal(urlNamesOtherShow('https://x.com/care-home-stories', own, []), null);
});

test('BRO-5724: "4.48 Psychosis" reviews with a 448-psychosis URL are not another show', () => {
  const psy = { id: '4-48-psychosis-west-end-2025', title: '4.48 Psychosis' };
  const stub = { id: '448-psychosis-off-west-end-2026', title: '448 Psychosis' };
  const url = 'https://www.theguardian.com/stage/2025/jun/19/448-psychosis-review-royal-court-theatre-london-sarah-kane-play';
  assert.equal(urlNamesOtherShow(url, psy, [stub]), null);
});

// BRO-7068: the contamination audit passes every show as a candidate for each of ~60k
// review files. Slugifying each candidate title per call made the audit 3+ minutes and
// timed the live-data lane out; a candidate's title must be read once per list.
test('BRO-7068: a candidate list is prepared once, not re-slugified on every call', () => {
  let reads = 0;
  const counted = (id, title) => ({ id, get title() { reads++; return title; } });
  const candidates = [counted('care-west-end-2026', 'Care Review Young Vic'), counted('other-west-end-2026', 'Some Other Long Title')];
  const url = 'https://www.thestage.co.uk/reviews/care-review-young-vic-london';
  for (let i = 0; i < 50; i++) assert.equal(urlNamesOtherShow(url, own, candidates)?.showId, 'care-west-end-2026');
  assert.ok(reads <= candidates.length * 2, `candidate titles read ${reads} times over 50 calls; expected them prepared once`);
});

test('BRO-7068: candidate order and the own-id / short-title skips are unchanged', () => {
  const first = { id: 'first-west-end-2026', title: 'Care Review Young Vic' };
  const second = { id: 'second-west-end-2026', title: 'Young Vic London Show' };
  const url = 'https://x.com/reviews/care-review-young-vic-london-show';
  assert.equal(urlNamesOtherShow(url, own, [first, second]).showId, 'first-west-end-2026');
  assert.equal(urlNamesOtherShow(url, own, [second, first]).showId, 'second-west-end-2026');
  assert.equal(urlNamesOtherShow(url, { ...own, id: first.id }, [null, first]), null);
  assert.equal(urlNamesOtherShow(url, own, [{ id: 'short', title: 'Care Review' }]), null); // < 12 chars
});
