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
});
