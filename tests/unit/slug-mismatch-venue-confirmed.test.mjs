/**
 * BRO-5693: the slug-mismatch lifetime sweep warned every day because each
 * regional backfill added correct reviews whose headline URL and extracted
 * body never repeat the exact title (Chicago Theatre Review keeps the title in
 * the page header). These cover the four precision fixes, plus the guard that
 * an article about a different show at the same venue still flags.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const check = require('../../scripts/lib/opening-night-checks/slug-mismatch.check.js');
const { normalizeArticleUrl, shouldClearUnjoinedCombinedFlag } = require('../../scripts/lib/combined-review-utils.js');

const filler = 'The cast is strong and the design is handsome throughout the evening. '.repeat(25);
const LOCUSTS = { id: 'the-locusts-regional-2022', title: 'The Locusts', slug: 'the-locusts-regional-2022', venue: 'Theater Wit, Chicago, IL' };
const SPONGE = { id: 'the-spongebob-musical-regional-2023', title: 'The Spongebob Musical', slug: 'the-spongebob-musical-regional-2023', venue: 'Chopin Theatre, Chicago, IL' };
const PARTY = { id: 'encores-the-wild-party-off-broadway-2026', title: 'Encores! The Wild Party', slug: 'encores-the-wild-party-off-broadway', venue: 'New York City Center' };
const CENSORED = { id: 'hatef-ck-regional-2023', title: 'Hatef*ck', slug: 'hatef-ck-regional-2023', venue: 'The Den Theatre, Chicago, IL' };
const SLASHVENUE = { id: 'someone-spectacular-off-broadway-2024', title: 'Someone Spectacular', slug: 'someone-spectacular', venue: 'The Pershing Square Signature Center/Romulus Linney Courtyard Theatre' };
const BIRDS = { id: 'birds-of-north-america-regional-2026', title: 'Birds Of North America', slug: 'birds-of-north-america-regional-2026', venue: 'A Red Orchid Theatre, Chicago, IL' };
const ROAD = { id: 'london-road-regional-2023', title: 'Gentle Road', slug: 'gentle-road-regional-2023', venue: 'Theater Wit, Chicago, IL' };
const COMPANY = { id: 'company-regional-2024', title: 'Company', slug: 'company-regional-2024', venue: 'Writers Theatre, Glencoe, IL' };
const WILD = { id: 'the-wild-party-regional-2024', title: 'The Wild Party', slug: 'the-wild-party-regional-2024', venue: 'Theater Wit, Chicago, IL' };
const TOSCA = { id: 'tosca-off-broadway-2026', title: 'Tosca', slug: 'tosca-off-broadway', venue: 'Metropolitan Opera House' };

const U = {
  locusts: 'https://www.chicagotheatrereview.com/2022/10/after-the-plague-theres-darkness/',
  birds: 'https://www.chicagotheatrereview.com/2026/02/bonded-over-birding/',
  road: 'https://www.chicagotheatrereview.com/2023/04/a-bakery-comedy/',
  company: 'https://www.chicagotheatrereview.com/2024/03/a-night-out/',
  wild: 'https://www.chicagotheatrereview.com/2024/05/a-night-to-remember/',
  otherShow: 'https://www.chicagotheatrereview.com/2022/11/a-different-evening/',
  oneWord: 'https://www.chicagotheatrereview.com/2022/12/a-single-mention/',
  sponge: 'https://www.chicagotheatrereview.com/2023/07/hero-is-my-middle-name/',
  party: 'https://www.interestedbystander.com/2026/03/theater-reviews-jesa-uniquely-focuses.html',
  censored: 'https://www.chicagoonstage.com/hatefuck/',
  slash: 'https://www.newyorker.com/culture/goings-on/nick-caves-transfixing-chants',
  tosca: 'https://www.huffingtonpost.com/entry/met-opera-yoncheva-grigolo-lucic-mcvicar-save_us_5a4a99c1e4b0d86c803c78cd',
};

let root;
before(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'slug-venue-'));
  const put = (showId, name, obj) => {
    fs.mkdirSync(path.join(root, showId), { recursive: true });
    fs.writeFileSync(path.join(root, showId, name), JSON.stringify(obj));
  };
  put(LOCUSTS.id, 'a.json', { url: U.locusts, fullText: `${filler} The seventh plague was locusts. ${filler} At Theater Wit the locusts arrive in act two.` });
  // Same venue, different play, one stray title word: must still flag.
  put(LOCUSTS.id, 'b.json', { url: U.otherShow, fullText: `${filler} Theater Wit presents a comedy about a bakery. ${filler} A swarm of locusts is mentioned once.` });
  put(LOCUSTS.id, 'c.json', { url: U.oneWord, fullText: `${filler} A play about locusts. ${filler} It closes Sunday.` });
  put(BIRDS.id, 'a.json', { url: U.birds, fullText: `${filler} At A Red Orchid Theatre two strangers bond over birds in the north woods. ${filler}` });
  // Finding 1: venue + one passing whole-title mention must not clear.
  put(ROAD.id, 'a.json', { url: U.road, fullText: `${filler} A bakery comedy opens at Theater Wit, which staged Gentle Road last fall. ${filler}` });
  // Finding 2: a one-word title used as prose, or one title word repeated.
  put(COMPANY.id, 'a.json', { url: U.company, fullText: `${filler} At Writers Theatre the company sings, the company dances and the company bows.` });
  put(WILD.id, 'a.json', { url: U.wild, fullText: `${filler} At Theater Wit a wild, wild, wild night about a bank heist. ${filler}` });
  put(SPONGE.id, 'a.json', { url: U.sponge, fullText: `An optimistic little guy named SpongeBob SquarePants saves the day. ${filler}` });
  put(PARTY.id, 'a.json', { url: U.party, fullText: `Theater: The Wild Party at New York City Center. ${filler}` });
  put(CENSORED.id, 'a.json', { url: U.censored, fullText: `${filler} You don't go to a play called Hatefuck expecting it to be subtle.` });
  put(SLASHVENUE.id, 'a.json', { url: U.slash, fullText: `${filler} Doménica Feraud's "Someone Spectacular," a play about grief. (Pershing Square Signature Center; through Sept. 7.) ${filler}` });
  // Inherited prior-run review: its text sits in the earlier run's folder.
  put('tosca-off-broadway-2017', 'a.json', { url: U.tosca, fullText: `Tosca at the Met opens the new year. ${filler}` });
});
after(() => fs.rmSync(root, { recursive: true, force: true }));

const runOne = (show, url, extra = {}) => check.run(show, {
  reviewTextsRoot: root,
  reviewsDoc: { [show.id]: [{ outletId: 'o', criticName: 'c', url, ...extra }] },
});

describe('venue plus title words confirm a headline URL', () => {
  it('clears a review naming the venue and two distinct title words', () => {
    assert.strictEqual(runOne(BIRDS, U.birds).ok, true);
  });
  it('a one-significant-word title never clears through the venue rule', () => {
    assert.strictEqual(runOne(LOCUSTS, U.locusts).ok, false);
    assert.strictEqual(runOne(COMPANY, U.company).ok, false);
  });
  it('venue plus one passing whole-title mention still flags', () => {
    assert.strictEqual(runOne(ROAD, U.road).ok, false);
  });
  it('one title word repeated still flags', () => {
    assert.strictEqual(runOne(WILD, U.wild).ok, false);
  });
  it('still flags a same-venue article that uses a title word once', () => {
    assert.strictEqual(runOne(LOCUSTS, U.otherShow).ok, false);
  });
  it('still flags title words without the venue', () => {
    assert.strictEqual(runOne(LOCUSTS, U.oneWord).ok, false);
  });
  it('either half of a slash venue name is read', () => {
    const re = check.buildVenueRegex(SLASHVENUE);
    assert.ok(re.test('(Pershing Square Signature Center; through Sept. 7.)'));
    assert.ok(re.test('at the Romulus Linney Courtyard Theater'));
  });
  it('buildVenueRegex refuses generic and market-word venues', () => {
    assert.strictEqual(check.buildVenueRegex({ venue: 'The Theatre, Chicago, IL' }), null);
    assert.strictEqual(check.buildVenueRegex({ venue: 'Broadway Theatre' }), null);
    assert.strictEqual(check.buildVenueRegex({ venue: 'West End Theatre' }), null);
  });
});

describe('title variants critics actually write', () => {
  it('drops a bare "Musical" tail (SpongeBob)', () => {
    assert.ok(check.buildAcceptSlugs(SPONGE).includes('spongebob'));
    assert.strictEqual(runOne(SPONGE, U.sponge).ok, true);
  });
  it('drops a presenter prefix only when two words remain', () => {
    assert.ok(check.buildAcceptSlugs(PARTY).includes('the-wild-party'));
    assert.ok(!check.buildAcceptSlugs({ id: 'x-2024', title: 'Encores! Pippin' }, { titleWords: false }).includes('pippin'));
    assert.strictEqual(runOne(PARTY, U.party).ok, true);
  });
  it('reads a censor star as letters, in the URL and the text', () => {
    const slugs = check.buildAcceptSlugs(CENSORED);
    assert.strictEqual(check.urlMentionsAnySlug(check.urlSearchSlug(U.censored), slugs), true);
    assert.strictEqual(check.urlMentionsAnySlug(check.urlSearchSlug('https://example.com/hate-review/'), slugs), false);
  });
});

describe('inherited prior-run reviews', () => {
  it('reads the text from the earlier run folder', () => {
    assert.strictEqual(runOne(TOSCA, U.tosca).ok, false);
    assert.strictEqual(runOne(TOSCA, U.tosca, { inheritedFromShowId: 'tosca-off-broadway-2017' }).ok, true);
  });
});

describe('router URLs keep their article id (combined-review key)', () => {
  it('Bloomberg sid, Wolf record and YouTube v stay distinct', () => {
    const a = normalizeArticleUrl('http://www.bloomberg.com/apps/news?pid=20601098&sid=aGLATMJ8rNfc&refer=movie');
    const b = normalizeArticleUrl('http://www.bloomberg.com/apps/news?pid=20601098&sid=aucncfQtSIGI&refer=movie');
    assert.notStrictEqual(a, b);
    assert.notStrictEqual(
      normalizeArticleUrl('https://www.wolfentertainmentguide.com/viewpage.aspx?cat=theater&record=7112'),
      normalizeArticleUrl('https://www.wolfentertainmentguide.com/viewpage.aspx?cat=theater&record=6671'));
    assert.strictEqual(normalizeArticleUrl('https://www.youtube.com/watch?v=abc&feature=youtu.be'), 'youtube.com/watch?v=abc');
  });
  it('a share param on a slugged article is still dropped', () => {
    assert.strictEqual(normalizeArticleUrl('https://x.com/2020/a-review-slug?s=20&t=abc'), 'x.com/2020/a-review-slug');
  });
});

describe('stale isCombinedReview flags clear once the key joins no other show', () => {
  const flagged = (n) => ({ isCombinedReview: true, combinedWith: Array.from({ length: n }, (_, i) => `show-${i}`) });
  it('clears a short combinedWith list when the key reaches one folder', () => {
    assert.strictEqual(shouldClearUnjoinedCombinedFlag(flagged(3), 1), true);
  });
  it('keeps a real joint review (the key still reaches 2+ folders, skipped copies counted)', () => {
    assert.strictEqual(shouldClearUnjoinedCombinedFlag(flagged(1), 2), false);
  });
  it('still clears a bogus >10 list, and ignores unflagged files', () => {
    assert.strictEqual(shouldClearUnjoinedCombinedFlag(flagged(60), 5), true);
    assert.strictEqual(shouldClearUnjoinedCombinedFlag({ isCombinedReview: false }, 1), false);
  });
});
