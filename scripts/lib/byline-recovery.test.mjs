import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { isPlausiblePersonName, pickRecoveredName, recoverBylineForEntry, recoverBylinesForShow } = require('./byline-recovery.js');

test('isPlausiblePersonName accepts real two/three-token bylines', () => {
  for (const n of ['Charles Isherwood', 'Ben Brantley', 'Andrzej Lukowski', 'Alexis Soloski', 'J. Kelly Nestruck']) {
    assert.equal(isPlausiblePersonName(n), true, `${n} should be plausible`);
  }
});

test('isPlausiblePersonName rejects outlet names, chrome, date labels, truncations', () => {
  for (const n of ['The Standard', 'Reviewed by', 'Updated November', "Holly O'", 'LynGardner', 'Unknown', '', null, 'Staff Writer']) {
    assert.equal(isPlausiblePersonName(n), false, `${JSON.stringify(n)} should be rejected`);
  }
});

test('pickRecoveredName returns the sole plausible name', () => {
  assert.equal(pickRecoveredName(['Unknown', 'Charles Isherwood']), 'Charles Isherwood');
  assert.equal(pickRecoveredName(['The Standard', 'Nick Curtis']), 'Nick Curtis');
});

test('pickRecoveredName returns null when plausible names disagree (byline explosion)', () => {
  assert.equal(pickRecoveredName(['Ben Brantley', 'Jesse Green']), null);
});

test('pickRecoveredName returns null when no plausible name exists', () => {
  assert.equal(pickRecoveredName(['Unknown', 'The Standard', 'Reviewed by']), null);
});

test('recoverBylineForEntry copies a same-URL sibling name onto an Unknown entry', () => {
  const entry = { criticName: 'Unknown', url: 'https://www.wsj.com/articles/giant-review-42d226b9?gaa_at=x' };
  const siblings = [
    { criticName: 'Charles Isherwood', url: 'https://www.wsj.com/articles/giant-review-42d226b9' },
    { criticName: 'Someone Else', url: 'https://www.wsj.com/articles/a-different-article' },
  ];
  assert.equal(recoverBylineForEntry(entry, siblings), 'Charles Isherwood');
});

test('recoverBylineForEntry ignores siblings at a different URL', () => {
  const entry = { criticName: 'Unknown', url: 'https://x.com/a' };
  const siblings = [{ criticName: 'Jane Critic', url: 'https://x.com/b' }];
  assert.equal(recoverBylineForEntry(entry, siblings), null);
});

test('recoverBylineForEntry leaves an already-named entry alone', () => {
  const entry = { criticName: 'Real Name', url: 'https://x.com/a' };
  const siblings = [{ criticName: 'Other Name', url: 'https://x.com/a' }];
  assert.equal(recoverBylineForEntry(entry, siblings), null);
});

test('recoverBylineForEntry returns null when the entry has no URL', () => {
  assert.equal(recoverBylineForEntry({ criticName: 'Unknown', url: '' }, [{ criticName: 'X Y', url: '' }]), null);
});

test('recoverBylinesForShow recovers a clean same-URL pair', () => {
  const out = recoverBylinesForShow([
    { file: 'wsj--unknown.json', outletId: 'wsj', url: 'https://wsj.com/a?t=1', criticName: 'Unknown' },
    { file: 'wsj--charles-isherwood.json', outletId: 'wsj', url: 'https://wsj.com/a', criticName: 'Charles Isherwood' },
  ]);
  assert.deepEqual(out, [{ file: 'wsj--unknown.json', recoveredName: 'Charles Isherwood' }]);
});

test('recoverBylinesForShow blocks a name claimed by 2+ outlets (Glengarry Ben Brantley contamination)', () => {
  const recs = [];
  for (const o of ['amny', 'chicagotribune', 'washpost']) {
    recs.push({ file: `${o}--unknown.json`, outletId: o, url: `https://${o}.com/g`, criticName: 'Unknown' });
    recs.push({ file: `${o}--ben-brantley.json`, outletId: o, url: `https://${o}.com/g`, criticName: 'Ben Brantley' });
  }
  assert.deepEqual(recoverBylinesForShow(recs), [], 'cross-outlet name is not propagated');
});

test('recoverBylinesForShow does not touch a group with no named sibling', () => {
  const out = recoverBylinesForShow([
    { file: 'ap--unknown.json', outletId: 'ap', url: 'https://ap.com/a', criticName: 'Unknown' },
  ]);
  assert.deepEqual(out, []);
});
