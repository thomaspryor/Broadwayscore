/**
 * BRO-7121 class guard. A multi-show capsule post has one URL and one show's
 * slug; Show Score files it under each show it reviews with a per-show blurb.
 * That listing vouches for the attribution; an identical blurb under two shows
 * (a copy) and a URL Show Score does not list for this show do not.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const check = require('../../scripts/lib/opening-night-checks/slug-mismatch.check.js');

const MOTHER = { id: 'conversations-with-mother-off-broadway-2025', title: 'Conversations with Mother', slug: 'conversations-with-mother' };
const URL = 'https://www.interestedbystander.com/2025/03/theater-reviews-ambitious-sumo.html';

function run(showScoreShows, url = URL, extra = {}, show = MOTHER) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'slug-ss-'));
  try {
    const ssPath = path.join(root, 'show-score.json');
    fs.writeFileSync(ssPath, JSON.stringify({ shows: showScoreShows }));
    return check.run(show, {
      reviewTextsRoot: path.join(root, 'none'),
      showScorePath: ssPath,
      reviewsDoc: { [MOTHER.id]: [{ outletId: 'the-interested-bystander', criticName: 'c', url, ...extra }] },
    });
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}
const row = (excerpt, url = URL + '?m=0') => ({ criticReviews: [{ outlet: 'x', url, excerpt }] });

describe('slug-mismatch: Show Score provenance', () => {
  it('clears when this show lists the URL with its own blurb', () => {
    const r = run({ [MOTHER.id]: row('Come for the acting'), 'sumo-off-broadway-2025': row('One of the more entertaining shows') });
    assert.strictEqual(r.ok, true);
  });
  it('flags when another show carries the identical blurb (a copy)', () => {
    const r = run({ [MOTHER.id]: row('Same blurb'), 'sumo-off-broadway-2025': row('Same blurb') });
    assert.strictEqual(r.ok, false);
  });
  it('flags when Show Score lists the URL only under a different show', () => {
    const r = run({ 'sumo-off-broadway-2025': row('One of the more entertaining shows') });
    assert.strictEqual(r.ok, false);
  });
  it('flags a URL Show Score lists under this show alone (a column, not a capsule)', () => {
    const r = run({ [MOTHER.id]: row('Only here') });
    assert.strictEqual(r.ok, false);
  });
  it('keeps distinct query-string pages distinct (record=1 is not record=2)', () => {
    const u1 = 'https://w.example/viewpage.aspx?record=1&cat=theater';
    const u2 = 'https://w.example/viewpage.aspx?record=2&cat=theater';
    const r = run({ [MOTHER.id]: row('a', u1), 'other-show': row('b', u2) }, u1);
    assert.strictEqual(r.ok, false);
  });
  it('treats a smart-quote/case variant of the same blurb as a copy', () => {
    const r = run({ [MOTHER.id]: row('"Come for the acting"'), 'sumo-off-broadway-2025': row('\u201cCome for the Acting\u201d') });
    assert.strictEqual(r.ok, false);
  });
  it('never vouches for a landing page', () => {
    const u = 'https://www.talkinbroadway.com/page/world/index.html';
    const r = run({ [MOTHER.id]: row('a', u), 'other-show': row('b', u) }, u);
    assert.strictEqual(r.ok, false);
  });
  it('flags a review published years from the show opening (other production)', () => {
    const r = run({ [MOTHER.id]: row('a'), 'x': row('b') }, URL, { publishDate: '2019-01-01' }, { ...MOTHER, openingDate: '2025-02-23' });
    assert.strictEqual(r.ok, false);
    const ok = run({ [MOTHER.id]: row('a'), 'x': row('b') }, URL, { publishDate: '2025-03-09' }, { ...MOTHER, openingDate: '2025-02-23' });
    assert.strictEqual(ok.ok, true);
  });
  it('never overrides saved review text that does not name the show', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'slug-ss-txt-'));
    try {
      fs.mkdirSync(path.join(root, MOTHER.id));
      fs.writeFileSync(path.join(root, MOTHER.id, 'r.json'), JSON.stringify({ url: URL, fullText: 'About a sumo wrestling play only.' }));
      const ssPath = path.join(root, 'ss.json');
      fs.writeFileSync(ssPath, JSON.stringify({ shows: { [MOTHER.id]: row('a'), x: row('b') } }));
      const r = check.run(MOTHER, { reviewTextsRoot: root, showScorePath: ssPath, reviewsDoc: { [MOTHER.id]: [{ outletId: 'o', criticName: 'c', url: URL }] } });
      assert.strictEqual(r.ok, false);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
  it('flags a category page even when listed under two shows', () => {
    const u = 'https://w.example/news/category/theater.html';
    const r = run({ [MOTHER.id]: row('a', u), x: row('b', u) }, u);
    assert.strictEqual(r.ok, false);
  });
  it('flags when no Show Score file exists', () => {
    const r = check.run(MOTHER, { reviewTextsRoot: '/nonexistent', showScorePath: '/nonexistent/ss.json',
      reviewsDoc: { [MOTHER.id]: [{ outletId: 'o', criticName: 'c', url: URL }] } });
    assert.strictEqual(r.ok, false);
  });
});
