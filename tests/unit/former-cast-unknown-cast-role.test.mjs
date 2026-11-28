/**
 * BRO-6479: roles 'Unknown'/'Cast' (scraper defaults, 107 rows / 25 shows) must
 * not be role cues for the former-cast guard, while staying stored and safe.
 * Run: node --test tests/unit/former-cast-unknown-cast-role.test.mjs
 */
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { isNoInfoRole } = require('../../scripts/lib/cast-role');
const { buildRoleTerms, buildSafeNameTokens, excerptMentionsFormerCast } = require('../../scripts/lib/excerpt-validation');

const show = () => ({
  id: 't', title: 'T', venue: 'V',
  priorRuns: [{ venue: 'Old', openingDate: '2020-01-01', closingDate: '2020-06-01' }],
  cast: [
    { name: 'Ann Lee', role: 'Unknown' }, { name: 'Bo Kim', role: 'cast' },
    { name: 'Di Fay', role: 'Ensemble' }, { name: 'Cy Roe', role: 'Hamlet Prince' },
  ],
});
const check = (excerpt, full) => excerptMentionsFormerCast(excerpt, {
  show: show(), reviewDate: '2020-02-01', reviewData: { publishDate: '2020-02-01', fullText: full || excerpt },
});

describe('Unknown/Cast roles are not role cues', () => {
  it('isNoInfoRole', () => {
    for (const r of ['Unknown', 'unknown', 'Cast', 'cast', ' Cast ', 'role not specified']) assert.equal(isNoInfoRole(r), true, r);
    for (const r of ['Ensemble', 'Cast Member Jones', 'Unknown Male', 'Hamlet', '', null, undefined]) assert.equal(isNoInfoRole(r), false, String(r));
  });
  it('buildRoleTerms drops unknown/cast and generic theatre words, keeps character words', () => {
    const t = buildRoleTerms(show());
    for (const w of ['unknown', 'cast', 'ensemble']) assert.equal(t.has(w), false, w);
    assert.equal(t.has('hamlet'), true);
  });
  it('the stored words stay in the safe set ("the Broadway Cast" is not a former actor)', () => {
    assert.equal(buildSafeNameTokens(show()).has('cast'), true);
    assert.equal(check('A Broadway smash', 'Unlike the Broadway Cast, here Prince Hamlet is grand.').mentionsFormerCast, false);
  });
  it('a name beside the word "cast" is not a former actor, but one beside a real role still is', () => {
    assert.equal(check('Jon Smith joined the cast and it works.').mentionsFormerCast, false);
    assert.equal(check('Jon Smith as Prince Hamlet is superb.').mentionsFormerCast, true);
  });
});
