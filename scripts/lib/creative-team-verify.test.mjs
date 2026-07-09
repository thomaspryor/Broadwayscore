import { test } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { ROLE_CANON, roleVerb, roleVerbVariants, serpTextConfirms } = require('./creative-team-verify.js');

test('roleVerb matches the write-path guard exactly', () => {
  assert.equal(roleVerb('director'), 'directed by');
  assert.equal(roleVerb('Director'), 'directed by'); // case-insensitive
  assert.equal(roleVerb('playwright'), 'written by');
  assert.equal(roleVerb('choreographer'), 'choreographed by');
  assert.equal(roleVerb('book writer'), 'book by');
  assert.equal(roleVerb('book'), 'book by');
  assert.equal(roleVerb('composer'), 'music by');
  assert.equal(roleVerb('lyricist'), 'lyrics by');
  assert.equal(roleVerb('Scenic Design'), null); // unverifiable roles reject
  assert.equal(roleVerb(undefined), null);
});

test('ROLE_CANON preserves exact-case labels for data-creative.ts routing', () => {
  assert.equal(ROLE_CANON['book writer'], 'Book Writer');
  assert.equal(ROLE_CANON['playwright'], 'Playwright');
});

test('roleVerbVariants covers audit-only roles and rejects design roles', () => {
  assert.ok(roleVerbVariants('Music & Lyrics').includes('music and lyrics by'));
  assert.ok(roleVerbVariants('composer').includes('composed by'));
  assert.equal(roleVerbVariants('Sound Design'), null);
});

test('serpTextConfirms rejects Google snippet-stitching (Einaudi/Giulia 2026-07-09)', () => {
  // Real SERP result that falsely "confirmed" the hallucinated Giulia composer:
  // a 1991 NYT dance review whose page also carried a sitewide events module.
  const stitched = [{
    title: 'Review/Dance; Comic Work Has Four Act as One',
    snippet: 'Aug 10, 1991 — Roland to music by Ludovico Einaudi, was performed by Mr. ... Giulia: The Poison Queen of Palermo.” Little Island: The artist',
  }];
  const opts = { title: 'Giulia: The Poison Queen of Palermo' };
  assert.equal(serpTextConfirms(stitched, ['music by'], 'Ludovico Einaudi', opts), false);

  // Same-segment attribution DOES confirm
  const legit = [{
    title: 'PAC NYC events',
    snippet: 'Giulia: The Poison Queen of Palermo, directed by Mary Zimmerman, opens July 10.',
  }];
  assert.equal(serpTextConfirms(legit, ['directed by'], 'Mary Zimmerman', opts), true);

  // Page title naming the show anchors a titleless snippet segment
  const pageTitled = [{
    title: 'Giulia: The Poison Queen of Palermo Review',
    snippet: 'The world premiere musical directed by Mary Zimmerman is a triumph.',
  }];
  assert.equal(serpTextConfirms(pageTitled, ['directed by'], 'Mary Zimmerman', opts), true);

  // Pre-colon short title works as an anchor
  const shortAnchor = [{
    title: 'Theatre roundup',
    snippet: 'Giulia, directed by Mary Zimmerman, begins previews.',
  }];
  assert.equal(serpTextConfirms(shortAnchor, ['directed by'], 'Mary Zimmerman', opts), true);
});

test('serpTextConfirms requires full attribution phrase, not just the name', () => {
  const results = [
    { title: 'Giulia review', snippet: 'The new musical written by and starring Jennifer Nettles dazzles.' },
  ];
  // "written by jennifer nettles" is not literally present ("written by and starring")
  assert.equal(serpTextConfirms(results, ['written by'], 'Jennifer Nettles'), false);
  const results2 = [
    { title: 'PAC NYC', snippet: 'Giulia, directed by Mary Zimmerman, opens July 10.' },
  ];
  assert.equal(serpTextConfirms(results2, ['directed by'], 'Mary Zimmerman'), true);
  // name in unrelated context must NOT confirm
  const results3 = [
    { title: 'Lehman Trilogy', snippet: 'Stefano Massini also wrote other plays.' },
  ];
  assert.equal(serpTextConfirms(results3, ['book by'], 'Stefano Massini'), false);
  // any variant hitting is enough
  assert.equal(serpTextConfirms(results2, ['directed by', 'direction by'], 'mary zimmerman'), true);
  assert.equal(serpTextConfirms([], ['directed by'], 'X'), false);
  assert.equal(serpTextConfirms(null, ['directed by'], 'X'), false);
});
