// enrich-dtli-thumbs must not copy an earlier production's DTLI verdicts onto
// a revival. Other Desert Cities 2026: the title slug `other-desert-cities` is
// the 2011 page; amNY's Matt Windman reviewed both and his 2011 thumbs-up
// landed on his 2026 pan. Requires the real module.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { enrichDtliThumbsForShow, buildDtliUrlCandidates } = require('../../scripts/enrich-dtli-thumbs.js');
const ROOT = path.join(path.dirname(new URL(import.meta.url).pathname), '..', '..');

test('a slug the map assigns to an earlier production is swapped for revival suffixes', () => {
  const c = buildDtliUrlCandidates('other-desert-cities-2026');
  assert.ok(!c.includes('https://didtheylikeit.com/shows/other-desert-cities/'), c.join(' '));
  assert.ok(c.includes('https://didtheylikeit.com/shows/other-desert-cities-2/'));
  assert.deepEqual(buildDtliUrlCandidates('other-desert-cities-2011'), ['https://didtheylikeit.com/shows/other-desert-cities/']);
});

test('rows dated before the production are never applied', async () => {
  const showId = '__enrich-dtli-wrong-production-test__';
  const dir = path.join(ROOT, 'data', 'review-texts', showId);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'amny--matt-windman.json');
  try {
    fs.writeFileSync(file, JSON.stringify({ showId, outletId: 'amny', outlet: 'amNewYork', criticName: 'Matt Windman', url: 'https://www.amny.com/x/', dtliThumb: 'Down' }));
    const block = (date, thumb) => `<div class="review-item"><div class="review_image"><div>AM New York</div></div>`
      + `<h2 class="review-item-critic-name"><a href="https://didtheylikeit.com/?s=Matt+Windman">Matt<br/>Windman</a></h2>`
      + `<h3 class="review-item-date">${date}</h3><img alt="BigThumbs_${thumb}" src="x.png">`
      + `<div class="entry-content">But a revival needs more than an impressive guest list to justify itself.</div></div>`;
    const show = { id: showId, title: 'Test Revival', openingDate: '2026-10-18', previewsStartDate: '2026-09-20' };
    const run = (html) => enrichDtliThumbsForShow(showId, { url: 'https://didtheylikeit.com/shows/x/', show, fetchPage: async () => ({ content: html }) });
    const old = await run(block('December 15, 2011', 'UP'));
    assert.equal(old.extracted, 0);
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).dtliThumb, 'Down');
    // An undated row on an old production's page is not trusted either.
    const undated = block('December 15, 2011', 'UP').replace('<h3 class="review-item-date">December 15, 2011</h3>', '');
    assert.equal((await run(block('December 15, 2011', 'DOWN') + undated)).extracted, 0);
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).dtliThumb, 'Down');
    const cur = await run(block('October 19, 2026', 'MEH'));
    assert.equal(cur.extracted, 1);
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).dtliThumb, 'Meh');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
