// Unit tests for the shared recoupment classifier.
// Per feedback_test_extraction_pattern.md — tests the real module via require(),
// not a re-implemented copy. LLM call is injected via opts.openaiFn so the tests
// run offline + deterministically.

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const { classifyArticle, extractArticleText, buildPrompt } = require('../../scripts/lib/recoupment-classify');

// Inject a fake openaiFn that returns whatever JSON the test stages.
function fakeOpenAI(verdict) {
  return async (_prompt) => JSON.stringify(verdict);
}

// Body must be >=200 chars AFTER extractArticleText collapses whitespace, so
// pad with letters (spaces would collapse). Wrap in <p> so the tag-stripper runs.
const longBody = (text) => `<p>${text} ${'x'.repeat(Math.max(0, 250 - text.length))}</p>`;

describe('extractArticleText', () => {
  it('returns empty string for null/empty input', () => {
    assert.equal(extractArticleText(null), '');
    assert.equal(extractArticleText(''), '');
  });

  it('strips scripts, styles, comments, and HTML tags', () => {
    const html = `<html><script>alert(1)</script><style>x{}</style>
      <!-- comment --><p>Hello <b>world</b></p></html>`;
    const text = extractArticleText(html);
    assert.equal(text.includes('alert'), false);
    assert.equal(text.includes('<'), false);
    assert.ok(text.includes('Hello world'));
  });

  it('decodes a few common entities', () => {
    const text = extractArticleText('<p>Tom &amp; Jerry&#39;s &quot;hi&quot;</p>');
    assert.ok(text.includes('Tom & Jerry'));
    assert.ok(text.includes("'"));
    assert.ok(text.includes('"'));
  });

  it('caps at 6000 chars', () => {
    const big = '<p>' + 'a'.repeat(10000) + '</p>';
    assert.equal(extractArticleText(big).length, 6000);
  });
});

describe('classifyArticle', () => {
  it('short-circuits with low-confidence when body <200 chars', async () => {
    const v = await classifyArticle('Show', 'http://x', '<p>tiny</p>');
    assert.equal(v.recouped, false);
    assert.equal(v.confidence, 'low');
    assert.match(v.reason, /too short/);
  });

  // Fixture 1: Hamilton — clear recoup announcement, exact production match, high conf.
  it('fixture: Hamilton recoupment announcement → exact / high', async () => {
    const verdict = {
      recouped: true, recoupedDate: '2026-05-01', articleDate: '2026-05-02',
      productionMatch: 'exact', confidence: 'high',
      evidence: 'Hamilton has recouped its $12.5 million capitalization',
    };
    const v = await classifyArticle('Hamilton', 'http://variety.com/x',
      longBody('Hamilton recoupment story'),
      { openaiFn: fakeOpenAI(verdict) });
    assert.equal(v.recouped, true);
    assert.equal(v.productionMatch, 'exact');
    assert.equal(v.confidence, 'high');
  });

  // Fixture 2: Hadestown extension — no recoupment claim.
  it('fixture: Hadestown extension (no recoup) → recouped:false', async () => {
    const verdict = {
      recouped: false, recoupedDate: null, articleDate: '2026-05-10',
      productionMatch: 'exact', confidence: 'high',
      evidence: 'Hadestown extends booking through 2027',
    };
    const v = await classifyArticle('Hadestown', 'http://playbill.com/x',
      longBody('Hadestown extension announcement'),
      { openaiFn: fakeOpenAI(verdict) });
    assert.equal(v.recouped, false);
  });

  // Fixture 3: Unrelated theater news.
  it('fixture: unrelated industry roundup → different-show / low', async () => {
    const verdict = {
      recouped: false, productionMatch: 'different-show', confidence: 'low',
      evidence: 'Tony nominees discuss budget priorities',
    };
    const v = await classifyArticle('Phantom of the Opera', 'http://variety.com/x',
      longBody('Tony nominees roundtable'),
      { openaiFn: fakeOpenAI(verdict) });
    assert.equal(v.productionMatch, 'different-show');
  });

  // Fixture 4: False-positive trap — "profit margin tightens".
  // Pre-filter regex would not match (no "recoup"/"earned back"), but if it
  // did, the classifier returns recouped:false.
  it('fixture: "profit margin tightens" puff piece → recouped:false', async () => {
    const verdict = {
      recouped: false, productionMatch: 'exact', confidence: 'high',
      evidence: 'Phantom margin tightens but not recouped',
    };
    const v = await classifyArticle('The Phantom of the Opera', 'http://nypost.com/x',
      longBody('Phantom profit margin tightens'),
      { openaiFn: fakeOpenAI(verdict) });
    assert.equal(v.recouped, false);
  });

  // Fixture 5: Same-title-different-year (2009 revival when we're tracking 2026).
  // Must produce same-title-different-year so caller's gate excludes it.
  it('fixture: pre-2020 historical mention → same-title-different-year', async () => {
    const verdict = {
      recouped: true, recoupedDate: '2009-08-15', articleDate: '2009-09-01',
      productionMatch: 'same-title-different-year', confidence: 'high',
      evidence: '2009 revival recouped in 14 weeks',
    };
    const v = await classifyArticle('Hair', 'http://nytimes.com/2009/x',
      longBody('2009 Hair revival history piece'),
      { openaiFn: fakeOpenAI(verdict) });
    assert.equal(v.recouped, true);
    assert.equal(v.productionMatch, 'same-title-different-year');
    // Caller (poll-trade-press-rss.js) requires productionMatch === 'exact', so
    // this verdict will be correctly rejected at the gate.
  });

  it('returns low-confidence on LLM error (malformed JSON)', async () => {
    const v = await classifyArticle('Show', 'http://x',
      longBody('body'), { openaiFn: async () => '{not-json' });
    assert.equal(v.recouped, false);
    assert.equal(v.confidence, 'low');
    assert.match(v.reason, /LLM error/);
  });

  it('returns low-confidence when openaiFn throws', async () => {
    const v = await classifyArticle('Show', 'http://x',
      longBody('body'), { openaiFn: async () => { throw new Error('boom'); } });
    assert.equal(v.recouped, false);
    assert.equal(v.confidence, 'low');
    assert.match(v.reason, /boom/);
  });
});

describe('buildPrompt', () => {
  it('includes show title, URL, and article text', () => {
    const p = buildPrompt('Hamilton', 'http://x/y', 'body content here');
    assert.ok(p.includes('Hamilton'));
    assert.ok(p.includes('http://x/y'));
    assert.ok(p.includes('body content here'));
  });

  it('mentions production-match constraint', () => {
    const p = buildPrompt('Show', 'http://x', 'body');
    assert.ok(p.includes('productionMatch'));
    assert.ok(p.includes('PRIOR production'));
  });

  it('with a show, names this production and the tour / pre-preview rules (BRO-4623)', () => {
    const p = buildPrompt('Death of a Salesman', 'http://x', 'body', {
      venue: 'Winter Garden Theatre', previewsStartDate: '2026-03-06', openingDate: '2026-04-09', status: 'closed', closingDate: '2026-08-09',
    });
    assert.ok(p.includes('This production: Broadway, at the Winter Garden Theatre, first preview 2026-03-06, opened 2026-04-09, closed 2026-08-09'));
    assert.ok(p.includes("BEFORE this production's first preview"));
    assert.ok(p.includes('national tour'));
    assert.ok(p.includes('productionType'));
  });
});

// BRO-4623: classifyArticle with opts.show runs the wrong-production guard,
// so the Friday scanner, the RSS poller and the reconciler all reject these.
describe('classifyArticle with opts.show (production guard)', () => {
  const DEATH_OF_A_SALESMAN = { id: 'death-of-a-salesman-2026', slug: 'death-of-a-salesman', previewsStartDate: '2026-03-06', openingDate: '2026-04-09' };
  const BEETLEJUICE_2025 = { id: 'beetlejuice-2025', slug: 'beetlejuice-2025', previewsStartDate: null, openingDate: '2025-10-08' };
  const THE_OUTSIDERS = { id: 'the-outsiders-2024', slug: 'the-outsiders', previewsStartDate: '2024-03-16', openingDate: '2024-04-11' };
  const GIANT = { id: 'giant-2026', slug: 'giant', openingDate: '2026-03-23' };
  const exact = (extra) => ({ recouped: true, productionMatch: 'exact', confidence: 'high', evidence: 'recouped', ...extra });

  it('death-of-a-salesman: 2012 recoupedDate (Friday run 37083591866) -> wrong-production', async () => {
    const v = await classifyArticle('Death of a Salesman', 'https://www.theatermania.com/broadway/news/broadways-death-of-a-salesman-recoups-capitalizati_56835.html/',
      longBody('Death of a Salesman has recouped'), { show: DEATH_OF_A_SALESMAN, openaiFn: fakeOpenAI(exact({ recoupedDate: '2012-05-16' })) });
    assert.equal(v.recouped, false);
    assert.equal(v.productionMatch, 'wrong-production');
    assert.match(v.guardReason, /2012-05-16/);
  });

  it('beetlejuice-2025: national-tour article -> wrong-production', async () => {
    const v = await classifyArticle('Beetlejuice', 'https://playbill.com/article/beetlejuice-national-tour-recoups',
      longBody('The national tour of Beetlejuice has recouped after just 11 months'), { show: BEETLEJUICE_2025, openaiFn: fakeOpenAI(exact({ recoupedDate: '2023-10-30' })) });
    assert.equal(v.productionMatch, 'wrong-production');
  });

  it("the-outsiders: the article's own og:title says North American Tour -> wrong-production", async () => {
    const html = `<html><head><meta property="og:title" content="'The Outsiders' Recoups $11 Million North American Tour"></head><body>${longBody('The Outsiders recouped')}</body></html>`;
    const v = await classifyArticle('The Outsiders (2024 Broadway production)', 'https://deadline.com/2026/05/the-outsiders-broadway-recoup-1236698348/',
      html, { show: THE_OUTSIDERS, openaiFn: fakeOpenAI(exact({ recoupedDate: '2026-05-20' })) });
    assert.equal(v.productionMatch, 'wrong-production');
    assert.match(v.guardReason, /tour/);
  });

  it('a genuine post-opening recoupment passes untouched (Giant, 2026-05)', async () => {
    const verdict = exact({ recoupedDate: '2026-05-19', productionType: 'broadway' });
    const v = await classifyArticle('Giant', 'https://www.nytimes.com/2026/05/19/theater/giant.html',
      longBody("Broadway's Giant turns a profit in 10 weeks"), { show: GIANT, openaiFn: fakeOpenAI(verdict) });
    assert.deepEqual(v, verdict);
  });
});
