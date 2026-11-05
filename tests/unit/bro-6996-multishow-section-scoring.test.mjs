/**
 * BRO-6996: a short section cut from a multi-show column (375 chars for In the
 * Heights, 846 for The Heart) was refused by the scorer's body_too_short gate.
 * Driven through the real functions (CLAUDE.md §15).
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
process.env.TS_NODE_PROJECT = new URL('../../scripts/tsconfig.json', import.meta.url).pathname;
require('ts-node/register');

const { isMultiShowSectionReview, isExemptFromBodyLengthGate } = require('../../scripts/lib/scorable-text');
const { isBlockedFromRescore } = require('../../scripts/lib/rescore-lifecycle');

const SECTION = 'In the Heights, a concert revival of the 2008 musical, is currently playing a three-week engagement at New York City Center. It has a book by Quiara Alegria Hudes, lyrics and music by Lin-Manuel Miranda, and direction by David Mendizabal, and it is a dull, dull, deeply unassured production of a mediocre property that borders on poor.';
const child = (o = {}) => ({ fullText: SECTION, contentTier: 'complete', multiShowSplitChild: true, ...o });

describe('multi-show section body-length exemption', () => {
  test('a split child and a trimmed split parent are exempt', () => {
    assert.equal(isMultiShowSectionReview(child()), true);
    assert.equal(isMultiShowSectionReview(child({ multiShowSplitChild: undefined, multiShowSplitParent: true })), true);
    assert.equal(isExemptFromBodyLengthGate(child()), true);
  });
  test('an ordinary short complete file keeps the gate', () => {
    assert.equal(isMultiShowSectionReview(child({ multiShowSplitChild: undefined })), false);
    assert.equal(isExemptFromBodyLengthGate(child({ multiShowSplitChild: undefined })), false);
  });
  test('length bounds, tier and exclusion flags still apply', () => {
    assert.equal(isMultiShowSectionReview(child({ fullText: SECTION.slice(0, 200) })), false);
    assert.equal(isMultiShowSectionReview(child({ fullText: SECTION.repeat(4) })), false);
    assert.equal(isMultiShowSectionReview(child({ contentTier: 'invalid' })), false);
    assert.equal(isMultiShowSectionReview(child({ wrongShow: true })), false);
    assert.equal(isMultiShowSectionReview(child({ rejectionReason: 'not_a_review' })), false);
  });
  test('a body_too_short stamp no longer blocks a split section', () => {
    const stamped = child({ rescoreBlockedReason: 'input_validation_failed:body_too_short', rescoreBlockedTextLength: SECTION.length, rescoreBlockedHadExcerpt: false });
    assert.equal(isBlockedFromRescore(stamped), false);
    assert.equal(isBlockedFromRescore({ ...stamped, multiShowSplitChild: undefined }), true);
  });
});
