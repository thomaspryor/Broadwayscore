/**
 * Tests for scripts/lib/score-input-validator.js
 *
 * Per CLAUDE.md §15: require() the real function — never copy logic here.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { validateScoreableText, detectHallucinatedScore } = require('../../scripts/lib/score-input-validator.js');

// ─── validateScoreableText ──────────────────────────────────────────────────

describe('validateScoreableText', () => {

  // ── Nav chrome case (the Proof / TheaterMania incident) ──────────────────

  it('fails on pure nav-chrome breadcrumb text', () => {
    const navText = 'BroadwayMania > Shows > Proof > Reviews';
    const result = validateScoreableText(navText, 'Proof');
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'nav_chrome_majority');
  });

  it('fails when majority of lines are nav chrome', () => {
    const navDominated = [
      'BroadwayMania > Shows > Proof > Reviews',
      'Home',
      'Menu',
      'Share',
      'Advertisement',
      'Tags: Broadway',
    ].join('\n');
    const result = validateScoreableText(navDominated, 'Proof');
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'nav_chrome_majority');
  });

  it('passes when nav chrome is a small fraction of the text', () => {
    // One breadcrumb line + lots of real content
    const showTitle = 'Proof';
    const realContent = `David Auburn's Proof is the kind of play that rewards patience, ` +
      `asking its audience to sit with uncertainty before delivering its emotional payload. ` +
      `At the Broadway Theatre, Anna Shapiro's revival brings out the delicate geometry ` +
      `of Auburn's argument — about inheritance, madness, genius, and trust — with a cast ` +
      `that gives the work genuine weight. The production transfers intact from the Goodman, ` +
      `and it shows: this is ensemble work, shaped by months of shared understanding.\n\n` +
      `The play's central question — who wrote a mathematical proof found in a deceased ` +
      `professor's desk? — is less a whodunit than an inquiry into epistemology. How do ` +
      `we know what we know? Can genius be inherited? Can we trust our own minds? Auburn ` +
      `poses these questions through Catherine, the professor's younger daughter, who has ` +
      `spent years caring for her father while surrendering her own mathematical ambitions.\n\n` +
      `The Proof production is meticulous and deeply felt. The performances ground the ` +
      `play's abstractions in recognizable grief and love. Proof earns every tear it draws.`;
    const text = 'BroadwayMania > Shows > Proof > Reviews\n\n' + realContent;
    const result = validateScoreableText(text, showTitle);
    assert.equal(result.ok, true, `Expected ok but got: ${result.reason}`);
  });

  // ── Keyword density case ──────────────────────────────────────────────────

  it('fails on body with no show keyword matches', () => {
    // Long text but mentions no show-identifying words
    const genericText = 'A ' + 'very interesting production opened last night. '.repeat(40) +
      'The cast was excellent and the direction was superb. ' +
      'The audience responded with enthusiasm. ' +
      'The staging was innovative. The lighting was beautiful. ' +
      'The costumes were period-appropriate.';
    const result = validateScoreableText(genericText, { title: 'Proof', cast: [{ name: 'Alexis Bledel' }] });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'insufficient_show_keywords');
  });

  it('passes when ≥2 show keywords appear in a long body', () => {
    const text = 'Proof is a compelling drama. ' +
      'The production at the Broadway Theatre is exceptional. ' +
      'Anna Shapiro directs with precision. ' +
      'This revival of Proof brings the mathematical mystery to life. ' +
      'Catherine, played brilliantly, anchors the entire production. ' +
      'Proof continues to resonate with contemporary audiences. '.repeat(15);
    const result = validateScoreableText(text, 'Proof');
    assert.equal(result.ok, true, `Expected ok but got: ${result.reason}`);
  });

  it('passes with show object containing title + cast', () => {
    const show = {
      title: 'Hamilton',
      cast: [{ name: 'Javier Muñoz' }, { name: 'Leslie Odom Jr' }],
      creativeTeam: [{ name: 'Lin-Manuel Miranda' }],
      venue: 'Richard Rodgers Theatre'
    };
    const text = 'Hamilton at the Richard Rodgers Theatre is a revelation. ' +
      'Lin-Manuel Miranda\'s score continues to dazzle. ' +
      'This production of Hamilton is the must-see event of the season. ' +
      'The staging, choreography, and performances make Hamilton essential viewing. '.repeat(15);
    const result = validateScoreableText(text, show);
    assert.equal(result.ok, true, `Expected ok but got: ${result.reason}`);
  });

  // ── Clean text case ───────────────────────────────────────────────────────

  it('passes a clean, full-length real review', () => {
    const reviewText = `
      Proof, the 2000 Pulitzer Prize winner by David Auburn, is back on Broadway in a
      revival that reminds us why the play endures. Auburn's drama about a mathematician's
      daughter who may have inherited both her father's genius and his mental illness is
      a finely crafted machine: every scene clicks into place with quiet efficiency.

      Directed with clarity and restraint, this production trusts the play's architecture.
      The central performance is extraordinary — watchful, brittle, and achingly real.
      The supporting cast is equally strong, and the design is modest in the best sense:
      nothing competes with the text.

      The Proof revival runs about two hours with one intermission. It is not the flashiest
      show of the season, but it is one of the most satisfying. For audiences who want
      theater that asks something of them — that rewards close attention with real feeling
      — Proof is essential.

      Auburn's play works because it operates on multiple levels simultaneously. On one
      hand it is a mystery: who wrote the proof? On another it is a study of grief and
      the difficulty of knowledge. And ultimately it is a love story — about a father and
      daughter, about mathematics and madness, about what it means to believe in someone
      you cannot fully see.

      This revival does justice to all of it. The Broadway Theatre feels exactly right for
      the production's scale: intimate but not claustrophobic, austere but not cold.
      The Proof production runs through the spring and should not be missed.
    `.trim();
    const result = validateScoreableText(reviewText, 'Proof');
    assert.equal(result.ok, true, `Expected ok but got: ${result.reason}`);
    assert.equal(result.reason, 'ok');
  });

  it('fails when text is null', () => {
    const result = validateScoreableText(null, 'Proof');
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'no_text');
  });

  it('fails when text is empty string', () => {
    const result = validateScoreableText('', 'Proof');
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'no_text');
  });

  it('body_too_short: fails when stripped body is under 1000 chars and not excerpt', () => {
    // Short text without enough nav chrome to trigger that gate
    const shortText = 'Proof is a great play. The performances are exceptional. ' +
      'Proof deserves to be seen by everyone.';
    const result = validateScoreableText(shortText, 'Proof');
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'body_too_short');
  });

  it('body_too_short: passes if isExcerpt is true even for short text', () => {
    const excerptText = 'Proof is a great play. The performances are exceptional. ' +
      'Proof deserves to be seen by everyone. The production at Broadway Theatre shines.';
    const result = validateScoreableText(excerptText, 'Proof', { isExcerpt: true });
    assert.equal(result.ok, true, `Expected ok but got: ${result.reason}`);
  });

  it('returns the stripped body in result', () => {
    const text = 'BroadwayMania > Shows > Proof > Reviews\n\nProof is excellent.';
    const result = validateScoreableText(text, 'Proof');
    // The body should NOT contain the breadcrumb
    assert.ok(!result.body.includes('BroadwayMania >'), 'Body should not include nav chrome');
  });
});

// ─── detectHallucinatedScore ─────────────────────────────────────────────────

describe('detectHallucinatedScore', () => {

  it('detects "no actual review content" pattern', () => {
    const reasoning = 'There is no actual review content in this text. I am assuming a hypothetical positive review.';
    const result = detectHallucinatedScore(reasoning);
    assert.equal(result.refused, true);
    assert.equal(result.reason, 'hallucinated_score');
  });

  it('detects "no review content" pattern', () => {
    const result = detectHallucinatedScore('This page has no review content, only navigation.');
    assert.equal(result.refused, true);
  });

  it('detects "cannot accurately score" pattern', () => {
    const result = detectHallucinatedScore('I cannot accurately score this since it is not a review.');
    assert.equal(result.refused, true);
  });

  it('detects "cannot score" pattern', () => {
    const result = detectHallucinatedScore('I cannot score this text as it is navigation chrome.');
    assert.equal(result.refused, true);
  });

  it('detects "hypothetical positive review" pattern', () => {
    const result = detectHallucinatedScore('Assigning rave based on hypothetical positive review context.');
    assert.equal(result.refused, true);
  });

  it('detects "assuming hypothetical rating" pattern', () => {
    const result = detectHallucinatedScore('Assuming hypothetical rating of 95 given the positive tone.');
    assert.equal(result.refused, true);
  });

  it('does NOT refuse a normal reasoning', () => {
    const normal = 'The production of Proof is praised for its tight direction and strong performances. ' +
      'Auburn\'s writing is precise and emotionally resonant. Score: 85/Positive.';
    const result = detectHallucinatedScore(normal);
    assert.equal(result.refused, false);
  });

  it('does NOT refuse when reasoning is null', () => {
    const result = detectHallucinatedScore(null);
    assert.equal(result.refused, false);
  });

  it('does NOT refuse when reasoning is empty string', () => {
    const result = detectHallucinatedScore('');
    assert.equal(result.refused, false);
  });

  it('is case-insensitive', () => {
    const result = detectHallucinatedScore('NO REVIEW CONTENT found — ASSUMING HYPOTHETICAL RAVE RATING');
    assert.equal(result.refused, true);
  });
});
