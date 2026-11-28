/**
 * BRO-4697 / BRO-3065: the slug-mismatch lifetime sweep grew every day because
 * it flagged any review whose URL never names the show, and most of the ~1,700
 * lifetime hits were headline-style URLs ("/david-greenspan-shines") on reviews
 * filed under the right show. These tests pin the four fixes in
 * scripts/lib/opening-night-checks/slug-mismatch.check.js:
 *   1. a URL is cleared when the review's own saved text names the show;
 *   2. whole UUIDs are opaque even when a hex group is all letters ("cafd");
 *   3. a letter->digit boundary splits ("Proof26" -> "proof 26");
 *   4. accented, slash and subtitled titles produce matchable slugs
 *      ("Amélie", "If/Then", "SIX the Musical" -> "six").
 * Real contamination (URL and text both about another show) must still flag.
 *
 * Pattern: require() the real check (§15).
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const check = require('../../scripts/lib/opening-night-checks/slug-mismatch.check.js');
const fulltext = require('../../scripts/lib/opening-night-checks/fulltext-mentions-show.check.js');
const { run, urlSearchSlug, isOpaqueUrlSlug, buildAcceptSlugs, urlMentionsAnySlug } = check;

const SHOW = { id: 'torera-off-broadway-2026', title: 'Torera', slug: 'torera' };
const HEADLINE = 'https://www.interestedbystander.com/2026/09/theater-reviews-david-greenspan-shines.html';
const OTHER_SHOW = 'https://www.interestedbystander.com/2025/10/theater-broadways-punch-argues-for.html';
const PASSING = 'https://www.interestedbystander.com/2026/09/fall-theater-roundup.html';

let root;
before(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'slug-mismatch-'));
  const dir = path.join(root, SHOW.id);
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, 'ib--a.json'), JSON.stringify({
    url: HEADLINE, fullText: 'Torera, the new play at the Public, gives David Greenspan his best role in years.',
  }));
  fs.writeFileSync(path.join(dir, 'ib--b.json'), JSON.stringify({
    url: OTHER_SHOW, fullText: 'Punch, the Broadway play about a fatal assault, argues for restorative justice.',
  }));
  fs.writeFileSync(path.join(dir, 'ib--c.json'), JSON.stringify({
    url: PASSING, fullText: 'Punch is a gripping play about a fatal assault. '.repeat(40) + 'Also opening this month: Torera.',
  }));
});
after(() => fs.rmSync(root, { recursive: true, force: true }));

const ctx = (urls) => ({
  reviewTextsRoot: root,
  reviewsDoc: { [SHOW.id]: urls.map((url, i) => ({ outletId: 'ib', criticName: `c${i}`, url })) },
});

describe('text-confirmed URLs', () => {
  it('a headline URL whose saved text names the show is not a mismatch', () => {
    const r = run(SHOW, ctx([HEADLINE]));
    assert.strictEqual(r.ok, true, r.message);
    assert.match(r.message, /1 without the slug confirmed by review text/);
  });

  it('a URL whose text is about another show still flags', () => {
    const r = run(SHOW, ctx([HEADLINE, OTHER_SHOW]));
    assert.strictEqual(r.ok, false);
    assert.deepStrictEqual(r.details.mismatches.map(m => m.url), [OTHER_SHOW]);
  });

  it('a show named only in passing deep in the body still flags', () => {
    const r = run(SHOW, ctx([PASSING]));
    assert.strictEqual(r.ok, false);
    assert.strictEqual(check.sourceTextNamesShow(['x'.repeat(2000) + ' Torera'], check.buildMentionRegex(SHOW)), false);
  });

  it('one common word of a title in the lede does not confirm', () => {
    const strict = (title, id) => check.buildMentionRegex({ id, title }, { titleWords: false });
    assert.strictEqual(check.sourceTextNamesShow(['Punch, the new play at the Booth, is a great evening.'],
      strict('The Great Gatsby', 'the-great-gatsby-2024')), false);
    assert.strictEqual(check.sourceTextNamesShow(['It is just the kind of revival that time forgot.'],
      strict('Just in Time', 'just-in-time-2025')), false);
    assert.strictEqual(check.sourceTextNamesShow(['The Great Gatsby lands at the Broadway Theatre.'],
      strict('The Great Gatsby', 'the-great-gatsby-2024')), true);
  });

  it('no saved text (missing dir) leaves the old behavior: flag', () => {
    const r = run(SHOW, { reviewTextsRoot: path.join(root, 'nope'), reviewsDoc: ctx([HEADLINE]).reviewsDoc });
    assert.strictEqual(r.ok, false);
  });
});

describe('opaque and glued URLs', () => {
  it('an FT UUID with an all-letter hex group is opaque', () => {
    assert.strictEqual(isOpaqueUrlSlug(urlSearchSlug('https://www.ft.com/content/214ad92c-cafd-4cda-85e1-cb1a9519df53')), true);
  });
  it('letter->digit boundary splits a glued production year', () => {
    assert.strictEqual(urlSearchSlug('https://www.talkinbroadway.com/page/world/Proof26.html'), 'page world proof 26');
    assert.ok(urlMentionsAnySlug(urlSearchSlug('https://www.talkinbroadway.com/page/world/OurTown24.html'),
      buildAcceptSlugs({ id: 'our-town-2024', title: 'Our Town' })));
  });
});

describe('accented and slash titles', () => {
  it('Amélie matches an /amelie- URL', () => {
    const slugs = buildAcceptSlugs({ id: 'amelie-a-new-musical-2017', title: 'Amélie, A New Musical' });
    assert.ok(slugs.includes('amelie'));
    assert.ok(urlMentionsAnySlug(urlSearchSlug('https://www.nytimes.com/2017/04/03/theater/amelie-musical-broadway-review.html'), slugs));
  });
  it('Bernhardt/Hamlet matches a /bernhardt-hamlet- URL', () => {
    const slugs = buildAcceptSlugs({ id: 'bernhardthamlet-2018', title: 'Bernhardt/Hamlet' });
    assert.ok(slugs.includes('bernhardt-hamlet'));
    assert.ok(urlMentionsAnySlug(urlSearchSlug('https://ew.com/theater/2018/09/25/bernhardt-hamlet-review/'), slugs));
  });
  it('core title drops the subtitle / "The Musical" tail', () => {
    assert.ok(buildAcceptSlugs({ id: 'six-the-musical-west-end-2021', title: 'SIX the Musical' }).includes('six'));
    assert.ok(buildAcceptSlugs({ id: 'dog-man-the-musical-west-end-2026', title: 'Dog Man - The Musical' }).includes('dog-man'));
    assert.ok(buildAcceptSlugs({ id: 'labelless-off-broadway-2026', title: 'Label•less' }).includes('label-less'));
  });
  it('fulltext-mentions-show shares the same mention regex', () => {
    assert.strictEqual(fulltext.buildMentionRegex, check.buildMentionRegex);
    assert.ok(check.buildMentionRegex({ id: 'les-miserables-west-end-2021', title: 'Les Misérables' }).test('a new Les Miserables at the Sondheim'));
  });
});
