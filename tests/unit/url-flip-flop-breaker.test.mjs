/**
 * BRO-2690: the BRO-121 flip-flop breaker pins whichever url the file holds
 * when it fires; it never fetches content. These tests pin the contract:
 *  - isUrlFlipFlop detects only a swap back to _urlChangedClear.from
 *  - _flipFlopShouldTakeIncoming lets independent evidence (aggregator url
 *    corroboration, named non-review page) beat the pin, same host only
 *  - end to end through safeWriteReview: no evidence => pinned (the known
 *    blind spot, documented); corroboration => the corrected url wins.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { isUrlFlipFlop } = require('../../scripts/lib/url-change-invariant.js');
const { _flipFlopShouldTakeIncoming, safeWriteReview } = require('../../scripts/lib/review-write-guard.js');

const WRONG = 'https://www.example-outlet.com/reviews/as-you-like-it-cherry-reds-25962';
const RIGHT = 'https://www.example-outlet.com/reviews/as-you-like-it-shakespeare-s-g-25910';

describe('isUrlFlipFlop', () => {
  const existing = { url: WRONG, _urlChangedClear: { from: RIGHT, to: WRONG } };
  test('swap back to the prior url is a flip-flop', () => {
    assert.equal(isUrlFlipFlop(existing, RIGHT), true);
  });
  test('a third url is not', () => {
    assert.equal(isUrlFlipFlop(existing, 'https://www.example-outlet.com/reviews/other'), false);
  });
  test('no breadcrumb => not a flip-flop', () => {
    assert.equal(isUrlFlipFlop({ url: WRONG }, RIGHT), false);
  });
});

describe('_flipFlopShouldTakeIncoming', () => {
  test('no corroboration on either side => keeps pin (breaker cannot judge)', () => {
    assert.equal(_flipFlopShouldTakeIncoming(WRONG, RIGHT, { url: WRONG }), false);
  });
  test('aggregator record naming the incoming side beats the pin', () => {
    assert.equal(_flipFlopShouldTakeIncoming(WRONG, RIGHT, { url: WRONG, playbillVerdictUrl: RIGHT }), true);
  });
  test('aggregator record naming the pinned side keeps the pin', () => {
    assert.equal(_flipFlopShouldTakeIncoming(WRONG, RIGHT, { url: WRONG, playbillVerdictUrl: WRONG }), false);
  });
  test('never hops to a different host', () => {
    const other = 'https://other-outlet.com/reviews/x';
    assert.equal(_flipFlopShouldTakeIncoming(WRONG, other, { url: WRONG, dtliUrl: other }), false);
  });
  test('named non-review page yields to a review url on the same host', () => {
    const news = 'https://www.thestage.co.uk/news/some-casting-news';
    const review = 'https://www.thestage.co.uk/reviews/some-show-review-theatre-london';
    assert.equal(_flipFlopShouldTakeIncoming(news, review, { url: news }), true);
  });
});

describe('safeWriteReview end to end', () => {
  function setup(extra) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bro2690-'));
    const show = path.join(dir, 'some-show-2026');
    fs.mkdirSync(show);
    const file = path.join(show, 'example-outlet--jane-doe.json');
    const rec = {
      showId: 'some-show-2026', outletId: 'example-outlet', outlet: 'Example Outlet',
      criticName: 'Jane Doe', url: WRONG, fullText: 'x'.repeat(1500),
      _urlChangedClear: { from: RIGHT, to: WRONG, at: '2026-08-01T00:00:00Z', cleared: [] },
      ...extra,
    };
    fs.writeFileSync(file, JSON.stringify(rec, null, 2));
    return { file, rec };
  }
  const attempt = (file, rec) => {
    safeWriteReview(file, { ...rec, url: RIGHT }, {});
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  };

  test('no evidence: swap-back is refused and the file is auto-pinned', () => {
    const { file, rec } = setup({});
    const out = attempt(file, rec);
    assert.equal(out.url, WRONG);
    assert.equal(out.urlVerifiedAuto, true);
  });
  test('corroborated incoming url is accepted, no pin written', () => {
    const { file, rec } = setup({ playbillVerdictUrl: RIGHT });
    const out = attempt(file, rec);
    assert.equal(out.url, RIGHT);
    assert.notEqual(out.urlVerifiedAuto, true);
  });
});

describe('malformed pinned url (BRO-2690)', () => {
  const garbage = 'https://So%20what?s%20needed?%20I?d%20say%20passion,%20or%20at%20least%20chemistry.';
  const real = 'https://deadline.com/2019/04/burn-this-review-adam-driver-1202595894/';
  test('well-formed incoming url beats a garbage pin', () => {
    assert.equal(_flipFlopShouldTakeIncoming(garbage, real, { url: garbage }), true);
  });
  test('garbage incoming never beats a real pin', () => {
    assert.equal(_flipFlopShouldTakeIncoming(real, garbage, { url: real }), false);
  });
  test('pinned real url with query string is still well-formed', () => {
    assert.equal(_flipFlopShouldTakeIncoming(real + '?x=1', real, { url: real }), false);
  });
});

test('a legit pinned url with %20 in the path is not treated as malformed', () => {
  const pinned = 'https://example.com/reviews/a%20b-review';
  const other = 'https://example.com/reviews/a-b-review';
  assert.equal(_flipFlopShouldTakeIncoming(pinned, other, { url: pinned }), false);
});
