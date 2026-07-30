/**
 * Unit tests for scripts/lib/content-verifier.js
 *
 * Offline schema tests — the real LLM behavior is exercised by
 * scripts/evals/content-verifier-eval.js which hits the API.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { heuristicVerify, quickValidityCheck, contentHash, resolveCvMarket } = require('../../scripts/lib/content-verifier.js');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(__dirname, '..', 'fixtures', 'content-verifier-golden', 'real-world-fixtures.json');

describe('prompt language ship-check (Schmigadoon 2026 Bug #7)', () => {
  // The LLM call sends the prompt built inside verifyContent; we read the function
  // source to prove the "Reviews OF vs mentions OF" language is still present.
  // This is a ship-check, not a behavior check — behavior lives in the eval harness.
  const srcPath = path.join(__dirname, '..', '..', 'scripts', 'lib', 'content-verifier.js');
  const source = fs.readFileSync(srcPath, 'utf8');

  test('prompt contains the Kennedy-Center-mention FP guardrail', () => {
    assert.ok(
      source.includes('"Reviews OF" vs "mentions OF"'),
      'CV prompt must include the "Reviews OF vs mentions OF" nuance'
    );
    assert.ok(
      source.includes('Schmigadoon 2026 FP class'),
      'CV prompt must cite the Schmigadoon 2026 FP class so future editors know why'
    );
  });

  test('prompt tells the LLM not to flag on mention alone', () => {
    assert.ok(
      /Do not flag on mention alone/.test(source),
      'CV prompt must explicitly say "Do not flag on mention alone"'
    );
  });

  test('prompt demands high confidence when flagging wrongProduction', () => {
    assert.ok(
      /set wrongProduction=true with confidence="high"/.test(source),
      'CV prompt must require confidence=high for wrongProduction=true'
    );
  });
});

describe('heuristicVerify fallback', () => {
  test('short content -> invalid', () => {
    const r = heuristicVerify({ scrapedText: 'tiny', showTitle: 'Wicked' });
    assert.strictEqual(r.isValid, false);
    assert.strictEqual(r.verifiedBy, 'heuristic');
  });

  test('missing showTitle mention flags wrongArticle', () => {
    const r = heuristicVerify({
      scrapedText: 'Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris nisi ut aliquip ex ea commodo consequat.',
      showTitle: 'Wicked',
    });
    assert.strictEqual(r.wrongArticle, true);
    assert.ok(r.issues.some(i => /not found/i.test(i)));
  });

  test('paywall signal flags truncation', () => {
    const r = heuristicVerify({
      scrapedText: 'This is a Wicked review. Subscribe to continue reading the rest of this review and access all content on our site.',
      showTitle: 'Wicked',
    });
    assert.strictEqual(r.truncated, true);
  });

  test('mid-sentence cutoff flags truncation', () => {
    const r = heuristicVerify({
      scrapedText: 'This Wicked review discusses the show and the cast and the direction and',
      showTitle: 'Wicked',
    });
    assert.strictEqual(r.truncated, true);
  });

  test('clean review content -> valid', () => {
    const r = heuristicVerify({
      scrapedText: 'Wicked is a Broadway musical that opened at the Gershwin Theatre. The production features talented performers and excellent direction. The show received strong reviews and is a must-see for theater fans.',
      showTitle: 'Wicked',
    });
    assert.strictEqual(r.isValid, true);
    assert.strictEqual(r.wrongArticle, false);
  });
});

describe('quickValidityCheck', () => {
  test('too-short text fails', () => {
    assert.strictEqual(quickValidityCheck('tiny', 'Wicked'), false);
  });

  test('clean theater text passes', () => {
    // quickValidityCheck requires ≥300 chars of genuine theater content.
    const text = 'The Broadway musical Wicked features an excellent cast and strong direction at the Gershwin Theatre. The production has been running for years and continues to draw audiences every week. Actors and performers bring the show to life on stage with choreography, lighting, and orchestration that make every performance memorable.';
    assert.strictEqual(quickValidityCheck(text, 'Wicked'), true);
  });

  test('junk-only content fails', () => {
    assert.strictEqual(
      quickValidityCheck(
        'Privacy policy terms cookie subscribe sign in privacy policy terms cookie subscribe sign in'.repeat(3),
        'Wicked'
      ),
      false
    );
  });
});

describe('contentHash', () => {
  test('same content -> same hash', () => {
    assert.strictEqual(contentHash('hello world'), contentHash('hello world'));
  });

  test('different content -> different hash', () => {
    assert.notStrictEqual(contentHash('hello world'), contentHash('goodbye world'));
  });
});

describe('golden fixture integrity', () => {
  test('fixture exists and is well-formed', () => {
    const f = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
    assert.ok(Array.isArray(f.cases));
    assert.ok(f.cases.length >= 20);
    for (const c of f.cases) {
      assert.ok(typeof c.id === 'string');
      assert.ok(c.input && typeof c.input.scrapedText === 'string');
      assert.ok(c.input.scrapedText.length >= 300, `${c.id} text too short`);
      assert.ok(typeof c.expected.isValid === 'boolean');
    }
  });

  test('fixture has both clean and garbage cases', () => {
    const f = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
    const clean = f.cases.filter(c => c.expected.isValid).length;
    const garbage = f.cases.filter(c => !c.expected.isValid).length;
    assert.ok(clean >= 10, `need ≥10 clean cases, have ${clean}`);
    assert.ok(garbage >= 10, `need ≥10 garbage cases, have ${garbage}`);
  });

  test('garbage cases each have at least one ground-truth flag', () => {
    const f = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
    for (const c of f.cases) {
      if (c.expected.isValid) continue;
      const flags = c.garbage_flags || {};
      const anyFlag = flags.wrongProduction || flags.wrongShow || flags.wrongArticle || flags.isRoundupArticle;
      assert.ok(anyFlag, `${c.id} has no garbage flag — weakens the ground-truth signal`);
    }
  });
});

describe('resolveCvMarket (special-venue carve-out, Les Mis Arena Concert @ Radio City, 2026-07-30)', () => {
  test('opera type wins regardless of venue', () => {
    assert.equal(resolveCvMarket({ type: 'opera', category: 'off-broadway', venue: 'Metropolitan Opera House' }), 'opera');
  });

  test('off-broadway show at Radio City Music Hall gets special-venue market', () => {
    assert.equal(
      resolveCvMarket({ type: 'special', category: 'off-broadway', venue: 'Radio City Music Hall' }),
      'special-venue'
    );
  });

  test('off-broadway show at Park Avenue Armory / Carnegie Hall / NYU Skirball / NYC Center get special-venue', () => {
    for (const venue of ['Park Avenue Armory', 'Stern Auditorium / Perelman Stage at Carnegie Hall', 'NYU Skirball', 'New York City Center - Stage II']) {
      assert.equal(resolveCvMarket({ category: 'off-broadway', venue }), 'special-venue', venue);
    }
  });

  test('ordinary off-broadway venue is unaffected', () => {
    assert.equal(resolveCvMarket({ category: 'off-broadway', venue: "Joe's Pub at The Public Theatre" }), 'off-broadway');
  });

  test('falls back to category, then broadway, when no special signal', () => {
    assert.equal(resolveCvMarket({ category: 'west-end', venue: 'Sondheim Theatre' }), 'west-end');
    assert.equal(resolveCvMarket(null), 'broadway');
    assert.equal(resolveCvMarket({}), 'broadway');
  });
});
