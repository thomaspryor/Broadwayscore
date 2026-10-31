// BRO-4406: same-outlet cloned aggregator excerpt classification + write-time strip.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const g = require('./cloned-excerpt-guard.js');

const EXCERPT = 'This revival of Ntozake Shange groundbreaking choreopoem feels both timeless and urgently contemporary, with a cast that brings fresh fire';
const words = (n, seed) => Array.from({ length: n }, (_, i) => `${seed}w${i % 97}x${(i * 7) % 13}`).join(' ');
const REAL_TEXT = `${words(120, 'real')} ${EXCERPT} ${words(120, 'tail')}`;

const rec = (file, data) => ({ file, data: { outletId: file.split('--')[0], ...data } });

test('web-search phantom that copied the excerpt into its own fullText (for colored girls / Time Out)', () => {
  const real = rec('timeout--melissa-rose-bernardo.json', { criticName: 'Melissa Rose Bernardo', url: 'https://timeout.com/real', source: 'playbill-verdict', fullText: words(300, 'bernardo'), bwwExcerpt: EXCERPT, contentTier: 'complete' });
  const phantom = rec('timeout--adam-feldman.json', { criticName: 'Adam Feldman', url: 'https://timeout.com/guessed-enuf-review', source: 'web-search', fullText: EXCERPT, dtliExcerpt: EXCERPT, contentTier: 'truncated', incompleteReason: 'url_content_mismatch', fetchDiscoveryAbandoned: true });
  const c = g.classifyPair(phantom, real);
  assert.equal(c.cls, 'phantom');
  assert.equal(c.phantom, 'timeout--adam-feldman.json');
});

test('typo-twin bylines with the same article are one review', () => {
  const a = rec('ew--isabella-biedenharn.json', { criticName: 'Isabella Biedenharn', url: 'https://ew.com/x', source: 'playbill-verdict', fullText: REAL_TEXT, dtliExcerpt: EXCERPT });
  const b = rec('ew--isabella-biedenahrn.json', { criticName: 'Isabella Biedenahrn', url: 'https://www.ew.com/x?utm=1', source: 'dtli', fullText: REAL_TEXT + ' extra', dtliExcerpt: EXCERPT });
  assert.equal(g.classifyPair(a, b).cls, 'same-review');
});

test('unknown-byline twin with near-identical text is one review', () => {
  const a = rec('variety--steven-suskin.json', { criticName: 'Steven Suskin', url: 'https://variety.com/a', fullText: REAL_TEXT, dtliExcerpt: EXCERPT });
  const b = rec('variety--unknown.json', { criticName: 'Unknown', url: 'http://variety.com/b', fullText: REAL_TEXT, dtliExcerpt: EXCERPT });
  assert.equal(g.classifyPair(a, b).cls, 'same-review');
});

test('two real critics at one outlet: excerpt stays with the file whose text contains it', () => {
  const owner = rec('nysr--roma-torre.json', { criticName: 'Roma Torre', url: 'https://nysr/a', fullText: REAL_TEXT, bwwExcerpt: EXCERPT });
  const other = rec('nysr--frank-scheck.json', { criticName: 'Frank Scheck', url: 'https://nysr/b', fullText: `${words(300, 'scheck')}`, bwwExcerpt: EXCERPT });
  const c = g.classifyPair(other, owner);
  assert.equal(c.cls, 'excerpt-copy');
  assert.equal(c.owner, 'nysr--roma-torre.json');
  assert.equal(c.stripFrom, 'nysr--frank-scheck.json');
});

test('same critic on two DIFFERENT articles is not merged (coast-of-utopia Voyage vs Shipwreck)', () => {
  const voyage = rec('about-entertainment--ben-brantley.json', { criticName: 'Ben Brantley', url: 'http://t.nytimes.com/voyage', fullText: REAL_TEXT, dtliExcerpt: EXCERPT });
  const ship = rec('nytimes--ben-brantley.json', { criticName: 'Ben Brantley', url: 'https://nytimes.com/ship', fullText: words(300, 'ship'), dtliExcerpt: EXCERPT });
  const c = g.classifyPair(voyage, ship);
  assert.equal(c.cls, 'excerpt-copy');
  assert.equal(c.stripFrom, 'nytimes--ben-brantley.json');
});

test('ownership that evidence cannot decide is reported, never guessed', () => {
  const a = rec('x--a.json', { criticName: 'A Person', url: 'https://x/1', fullText: words(300, 'aa'), dtliExcerpt: EXCERPT });
  const b = rec('x--b.json', { criticName: 'B Other', url: 'https://x/2', fullText: words(300, 'bb'), dtliExcerpt: EXCERPT });
  assert.equal(g.classifyPair(a, b).cls, 'unresolved');
});

test('excerpts of 40 chars or fewer never pair up', () => {
  const short = 'This is popular entertainment at its';
  const a = rec('x--a.json', { criticName: 'A', dtliExcerpt: short });
  const b = rec('x--b.json', { criticName: 'B', dtliExcerpt: short });
  assert.equal(g.findClonedPairs([a, b]).length, 0);
});

test('findClonedPairs stays inside one outlet', () => {
  const a = rec('nytimes--a.json', { dtliExcerpt: EXCERPT });
  const b = rec('variety--b.json', { dtliExcerpt: EXCERPT });
  assert.equal(g.findClonedPairs([a, b]).length, 0);
  assert.equal(g.findClonedPairs([a, rec('nytimes--c.json', { dtliExcerpt: EXCERPT })]).length, 1);
});

test('write guard: strips the excerpt from an incoming non-owner, keeps it on the owner', () => {
  const owner = rec('nysr--roma-torre.json', { criticName: 'Roma Torre', url: 'https://nysr/a', fullText: REAL_TEXT, bwwExcerpt: EXCERPT });
  const incoming = { outletId: 'nysr', criticName: 'Frank Scheck', url: 'https://nysr/b', fullText: words(300, 'scheck'), bwwExcerpt: EXCERPT, showScoreExcerpt: EXCERPT };
  const r = g.excerptFieldsToStrip('nysr--frank-scheck.json', incoming, [owner]);
  assert.deepEqual(r.fields.sort(), ['bwwExcerpt', 'showScoreExcerpt']);
  const own = g.excerptFieldsToStrip('nysr--roma-torre.json', owner.data, [rec('nysr--frank-scheck.json', { ...incoming })]);
  assert.deepEqual(own.fields, []);
});

test('write guard leaves same-review twins to the duplicate machinery and ignores excluded siblings', () => {
  const sib = rec('variety--steven-suskin.json', { criticName: 'Steven Suskin', url: 'https://variety.com/a', fullText: REAL_TEXT, dtliExcerpt: EXCERPT });
  const twin = { outletId: 'variety', criticName: 'Unknown', url: 'https://variety.com/a', fullText: REAL_TEXT, dtliExcerpt: EXCERPT };
  assert.deepEqual(g.excerptFieldsToStrip('variety--unknown.json', twin, [sib]).fields, []);
  const dead = rec('nysr--roma-torre.json', { criticName: 'Roma Torre', fullText: REAL_TEXT, bwwExcerpt: EXCERPT, duplicateOf: 'x.json' });
  const inc = { outletId: 'nysr', criticName: 'Frank Scheck', fullText: words(300, 'scheck'), bwwExcerpt: EXCERPT };
  assert.deepEqual(g.excerptFieldsToStrip('nysr--frank-scheck.json', inc, [dead]).fields, []);
});

test('isFileExcluded: duplicateOf and rejection flags take a file out of the live count', () => {
  assert.equal(g.isFileExcluded({ duplicateOf: 'a.json' }), true);
  assert.equal(g.isFileExcluded({ wrongShow: true }), true);
  assert.equal(g.isFileExcluded({ criticName: 'X' }), false);
});

test('safeWriteReview (the real write choke point) strips the cloned excerpt on the non-owner', () => {
  const { safeWriteReview } = require('./review-write-guard.js');
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cloned-excerpt-')), 'some-show-2020');
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, 'nysr--roma-torre.json'), JSON.stringify({
    showId: 'some-show-2020', outletId: 'nysr', criticName: 'Roma Torre', url: 'https://nysr/a', fullText: REAL_TEXT, bwwExcerpt: EXCERPT,
  }));
  const r = safeWriteReview(path.join(dir, 'nysr--frank-scheck.json'), {
    showId: 'some-show-2020', outletId: 'nysr', criticName: 'Frank Scheck', url: 'https://nysr/b', fullText: words(300, 'scheck'), bwwExcerpt: EXCERPT,
  });
  assert.equal(r.wrote, true);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'nysr--frank-scheck.json'), 'utf8')).bwwExcerpt, null);
  assert.ok(JSON.parse(fs.readFileSync(path.join(dir, 'nysr--roma-torre.json'), 'utf8')).bwwExcerpt);
});

// ---- BRO-4412: identical-article phantoms and unverifiable guesses -------------
const ARTICLE = words(400, 'variety');
const noisy = `${ARTICLE} subscribe now`;

test('BRO-4412: three Variety bylines on one article are one review; attested byline is kept', () => {
  const guess1 = rec('variety--charles-isherwood.json', { criticName: 'Charles Isherwood', url: 'https://variety.com/a-1', source: 'web-search', fullText: ARTICLE });
  const guess2 = rec('variety--aramide-tinubu.json', { criticName: 'Aramide Tinubu', url: 'https://variety.com/a-2', source: 'web-search', fullText: noisy });
  const real = rec('variety--trish-deitch.json', { criticName: 'Trish Deitch', url: 'https://variety.com/a-3', source: 'playbill-verdict', fullText: noisy });
  const pairs = g.findClonedPairs([guess1, guess2, real]);
  assert.equal(pairs.length, 3);
  for (const p of pairs) assert.equal(g.classifyPair(p.a, p.b).cls, 'same-review');
});

test('BRO-4412: identical fullText with different URLs pairs even with no aggregator excerpt', () => {
  const a = rec('variety--a.json', { criticName: 'A One', url: 'https://variety.com/x', fullText: ARTICLE });
  const b = rec('variety--b.json', { criticName: 'B Two', url: 'https://variety.com/y', fullText: ARTICLE });
  assert.equal(g.findClonedPairs([a, b]).length, 1);
  assert.equal(g.isSameArticle(a.data, b.data).same, true);
});

test('BRO-4412: Feldman-style phantom (160 chars, dead url, own excerpt) is paired and classified phantom', () => {
  const real = rec('timeout--melissa-rose-bernardo.json', { criticName: 'Melissa Rose Bernardo', url: 'https://timeout.com/real', source: 'playbill-verdict', fullText: words(300, 'bernardo'), bwwExcerpt: 'Real excerpt from the Bernardo review, long enough to count as one.' });
  const phantom = rec('timeout--adam-feldman.json', { criticName: 'Adam Feldman', url: 'https://timeout.com/guessed-review', source: 'web-search', fullText: 'x'.repeat(160), dtliExcerpt: 'A different invented excerpt about the revival that no source published.', contentTier: 'truncated', incompleteReason: 'url_content_mismatch', fetchDiscoveryAbandoned: true });
  const pairs = g.findClonedPairs([real, phantom]);
  assert.equal(pairs.length, 1);
  const c = g.classifyPair(pairs[0].a, pairs[0].b);
  assert.equal(c.cls, 'phantom');
  assert.equal(c.phantom, 'timeout--adam-feldman.json');
});

test('BRO-4412: a fetched web-search review by a second critic is NOT a phantom', () => {
  const real = rec('nytimes--jesse-green.json', { criticName: 'Jesse Green', url: 'https://nyt/a', source: 'playbill-verdict', fullText: words(300, 'green') });
  const second = rec('nytimes--laura-collins-hughes.json', { criticName: 'Laura Collins-Hughes', url: 'https://nyt/b', source: 'web-search', fullText: words(400, 'lch'), contentTier: 'complete' });
  assert.equal(g.findClonedPairs([real, second]).length, 0);
});

test('BRO-4412: two different real articles from one outlet are not paired', () => {
  const a = rec('nytimes--x.json', { criticName: 'X Y', url: 'https://nyt/a', fullText: words(300, 'one') });
  const b = rec('nytimes--z.json', { criticName: 'Z W', url: 'https://nyt/b', fullText: words(300, 'two') });
  assert.equal(g.findClonedPairs([a, b]).length, 0);
});

test('BRO-4412: phantomOfSibling refuses a new web-search twin, never an attested or same-byline write', () => {
  const real = rec('variety--trish-deitch.json', { criticName: 'Trish Deitch', url: 'https://variety.com/a-3', source: 'playbill-verdict', fullText: ARTICLE });
  const guess = { outletId: 'variety', criticName: 'Charles Isherwood', url: 'https://variety.com/a-1', source: 'web-search', fullText: noisy };
  assert.equal(g.phantomOfSibling('variety--charles-isherwood.json', guess, [real]), 'variety--trish-deitch.json');
  assert.equal(g.phantomOfSibling('variety--charles-isherwood.json', { ...guess, source: 'playbill-verdict' }, [real]), null);
  assert.equal(g.phantomOfSibling('variety--trish-deitch.json', { ...guess, criticName: 'Trish Deitch' }, [real]), null);
});

test('BRO-4412: safeWriteReview refuses a brand-new web-search phantom byline', () => {
  const { safeWriteReview } = require('./review-write-guard.js');
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'phantom-')), 'some-show-2021');
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, 'variety--trish-deitch.json'), JSON.stringify({
    showId: 'some-show-2021', outletId: 'variety', criticName: 'Trish Deitch', url: 'https://variety.com/a-3', source: 'playbill-verdict', fullText: ARTICLE,
  }));
  const r = safeWriteReview(path.join(dir, 'variety--charles-isherwood.json'), {
    showId: 'some-show-2021', outletId: 'variety', criticName: 'Charles Isherwood', url: 'https://variety.com/a-1', source: 'web-search', fullText: noisy,
  });
  assert.equal(r.wrote, false);
  assert.equal(r.skipped, 'phantom_of_sibling');
  assert.equal(fs.existsSync(path.join(dir, 'variety--charles-isherwood.json')), false);
});
