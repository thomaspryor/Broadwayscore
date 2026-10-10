// BRO-3482: the six reviews that pointed at unrelated articles must stay fixed.
// Reads the private data repos (skips when they are not checked out, e.g. CI without them).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TEXTS = process.env.REVIEW_TEXTS_DIR || path.join(os.homedir(), 'broadway-review-texts');
const REVIEWS = process.env.REVIEWS_JSON || path.join(os.homedir(), 'broadway-scorecard-data', 'reviews.json');
const have = fs.existsSync(TEXTS) && fs.existsSync(REVIEWS);

const BAD = [
  { show: 'fences-2010', outlet: 'timeout', re: /timeout\.com\/movies\/fences/ },
  { show: 'kiss-of-the-spider-woman-1993', outlet: 'thestage', re: /revived-at-curve/ },
  { show: 'les-miserables-1987', outlet: 'whatsonstage', re: /stage-by-stage-how-les-miserables/ },
  { show: 'moulin-rouge-2019', outlet: 'billboard', re: /listen-original-broadway-cast-recording/ },
  { show: 'the-mousetrap-west-end-2021', outlet: 'thestage', re: /70th-anniversary-tour/ },
  { show: 'black-is-the-color-of-my-voice-west-end-2026', outlet: 'london-theatre', re: /boys-from-the-blackstuff/ },
];
const EXCLUDED = (d) => d.isNonReview === true || d.wrongShow === true || d.wrongProduction === true;

test('no live reviews.json record points at a known-wrong URL', { skip: !have }, () => {
  const reviews = JSON.parse(fs.readFileSync(REVIEWS, 'utf8')).reviews;
  for (const b of BAD) {
    const hits = reviews.filter((r) => r.showId === b.show && r.outletId === b.outlet && b.re.test(r.url || ''));
    assert.equal(hits.length, 0, `${b.show}/${b.outlet} still carries a wrong url`);
  }
});

test('source review-text files with a known-wrong URL are excluded or cleared', { skip: !have }, () => {
  for (const b of BAD) {
    const dir = path.join(TEXTS, b.show);
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir).filter((x) => x.startsWith(b.outlet + '--') && x.endsWith('.json'))) {
      const d = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
      if (b.re.test(d.url || '')) assert.ok(EXCLUDED(d), `${b.show}/${f} has wrong url and is not excluded`);
    }
  }
});

test('fixed records no longer carry the stolen score/url', { skip: !have }, () => {
  const rd = (p) => JSON.parse(fs.readFileSync(path.join(TEXTS, p), 'utf8'));
  const fences = rd('fences-2010/timeout--adam-feldman.json');
  assert.equal(fences.url, null);
  assert.equal(fences.originalScoreNormalized, null);
  const lm = rd('les-miserables-1987/whatsonstage--unknown.json');
  assert.equal(lm.url, null);
  assert.equal(lm.serpDiscoveryAbandoned, true, 'recover-explicit-ratings Phase 0 would re-discover the url');
  for (const f of ['london-theatre--olivia-rook', 'london-theatre--unknown']) {
    const d = rd(`black-is-the-color-of-my-voice-west-end-2026/${f}.json`);
    assert.equal(d.url, null);
    assert.ok(EXCLUDED(d));
  }
  assert.equal(rd('moulin-rouge-2019/billboard--mary-j-dimeglio.json').isNonReview, true);
});
