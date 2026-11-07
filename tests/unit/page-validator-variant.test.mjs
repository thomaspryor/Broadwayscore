/**
 * BRO-6910: billed-title variant layer in page-validator.
 * Playbill Verdict and BWW titled the Lefty roundups "Waiting for Lefty at
 * Classic Stage Company"; the billed title is "Clifford Odets' Waiting for
 * Lefty", so 2/4 words matched and the LLM tiebreaker rejected both pages.
 *
 * Run with: node --test tests/unit/page-validator-variant.test.mjs
 */
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { validatePageMatchesShow, matchDerivedTitleVariant } = require('../../scripts/lib/page-validator');

const LEFTY = 'Clifford Odets’ Waiting for Lefty';
const OPTS = { openingYear: 2026, category: 'off-broadway', skipLlm: true };
const h = (t) => `<title>${t}</title><h1>${t}</h1>`;

describe('page-validator billed-title variant (BRO-6910)', () => {
  it('accepts the Playbill Verdict heading via the variant with venue proof', async () => {
    const r = await validatePageMatchesShow(h('What Do Reviews Think of Waiting for Lefty at Classic Stage Company?'), LEFTY, OPTS);
    assert.strictEqual(r.valid, true);
    assert.match(r.reason, /billed-title variant "Waiting for Lefty".*classic/i);
  });

  it('accepts the BWW roundup heading via the variant', async () => {
    const r = await validatePageMatchesShow(h('Review Roundup: WAITING FOR LEFTY Opens at Classic Stage Company'), LEFTY, OPTS);
    assert.strictEqual(r.valid, true);
    assert.match(r.reason, /billed-title variant/);
  });

  it('refuses the variant without venue proof when another show shares it', () => {
    // waiting-for-lefty-regional-2024 clashes; no venue word means no proof.
    assert.strictEqual(matchDerivedTitleVariant(LEFTY, 'Review Roundup: Waiting for Lefty'), null);
  });

  it('rejects an unrelated show heading', async () => {
    const r = await validatePageMatchesShow(h('Review Roundup: The Executrix'), LEFTY, OPTS);
    assert.strictEqual(r.valid, false);
    assert.strictEqual(matchDerivedTitleVariant(LEFTY, 'Review Roundup: The Executrix'), null);
  });

  it('ignores label-head variants (School of Rock vs its West End twin)', () => {
    assert.strictEqual(matchDerivedTitleVariant('School of Rock – The Musical', 'School of Rock review roundup'), null);
  });

  it('never validates the Met Tosca page for the ENO Tosca (label-head variant)', async () => {
    const met = 'Review Roundup: Tosca Returns to the Metropolitan Opera';
    assert.strictEqual(matchDerivedTitleVariant('Tosca - English National Opera', met), null);
    const r = await validatePageMatchesShow(h(met), 'Tosca - English National Opera', { openingYear: 2026, category: 'west-end', skipLlm: true });
    assert.doesNotMatch(r.reason, /billed-title variant/);
  });

  it('leaves the billed exact title on the normal path', async () => {
    const r = await validatePageMatchesShow(h(`Review Roundup: ${LEFTY}`), LEFTY, OPTS);
    assert.strictEqual(r.valid, true);
    assert.doesNotMatch(r.reason, /billed-title variant/);
  });
});

describe('variant proof needs the whole venue name (BRO-6910 review)', () => {
  it('refuses a no-clash two-word variant without the venue', () => {
    assert.strictEqual(matchDerivedTitleVariant("Rosie O'Donnell: Common Knowledge", 'Common Knowledge Review Roundup'), null);
  });
  it('refuses a single venue word used as prose ("a classic revival")', () => {
    assert.strictEqual(matchDerivedTitleVariant(LEFTY, 'Waiting for Lefty, a classic revival'), null);
  });
  it('still lets the year layer reject a far-off year with the venue present', async () => {
    const r = await validatePageMatchesShow(h('Review Roundup: Waiting for Lefty at Classic Stage Company (2009)'), LEFTY, OPTS);
    assert.strictEqual(r.valid, false);
  });
});
