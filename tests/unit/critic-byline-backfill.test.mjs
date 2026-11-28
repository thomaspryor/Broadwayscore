// BRO-7165: critic byline read from stored fullText. Requires the real functions.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  extractCriticFromFullText: ex, isJunkBylineValue, needsCriticBackfill,
} = require('../../scripts/lib/critic-byline-backfill.js');
const { extractPlaysInternationalByline } = require('../../scripts/lib/byline-from-text.js');
const { orderCriticCandidates } = require('../../scripts/backfill-unknown-critics.js');

test('Plays International: place phrase outside London (speculations-off-west-end-2026)', () => {
  const t = '“Speculations” at Marylebone Theatre Jeremy Malies in central London ★★☆☆☆ 8 November 2026 This new play by Torben Betts';
  assert.equal(ex('plays-international', t).name, 'Jeremy Malies');
  assert.deepEqual(extractPlaysInternationalByline('Jeremy Malies in the West End ★★★★★ 25 November 2025 Playing Joe'), { name: 'Jeremy Malies', known: true });
  assert.equal(ex('plays-international', 'A Midsummer Night\'s Dream, Chichester Festival Theatre Jeremy Malies in West Sussex ★★☆☆☆ 30 September 2026 It').name, 'Jeremy Malies');
  assert.equal(ex('plays-international', '"Black Hole Sign", Tron Theatre, Glasgow Mark Brown on Clydeside 24 September 2025 ★★★★ Uma').name, 'Mark Brown');
});

test('Plays International: prose mentioning "in" without stars/date is not a byline', () => {
  assert.equal(ex('plays-international', 'Jeremy Malies in a rather long review of nothing in particular, said the company'), null);
});

test('markaspen: Review by <Name> runs into the first sentence', () => {
  const t = 'Tosca Posted by markaspen Warmth With Steel Tosca b y Giacomo Puccini, libretto by Luigi Illica English National Opera at The London Coliseum until 11 th December Review by Claire Alexander Puccini’s Tosca has never lacked for drama. Claire Alexander, October 2026 Photography by Ellie Kurttz';
  assert.equal(ex('markaspen', t).name, 'Claire Alexander');
});

test('firstnightmagazine: closing credit', () => {
  const t = 'Review of \'Girls\': ... Listings and ticket information are available on the following link . By Guillermo Nazara Share this: Share on X (Opens in new window) X Like this: Like Loading…';
  assert.equal(ex('firstnightmagazine', t).name, 'Guillermo Nazara');
});

test('a-youngish-perspective: author before post date; usernames and first-name-plus-initial refused', () => {
  assert.equal(ex('a-youngish-perspective', 'REVIEW: Fences Reading Time: 3 minutes Fences is a play. Antonia Constantin May 3, 2026 ★★★☆☆ , Review').name, 'Antonia Constantin');
  assert.equal(ex('a-youngish-perspective', 'REVIEW: A Man for All Seasons Reading Time: 1 minute a triumph. jessicafrancis08 February 20, 2025'), null);
  assert.equal(ex('a-youngish-perspective', 'REVIEW: Abigail’s Party Reading Time: 3 minutes a slow burn. Lucy C April 12, 2025 ★★★☆☆'), null);
});

test('never invents a name: no credit in the text gives null', () => {
  // elling-2010 hollywood-reporter: the stored text never names the critic.
  const t = 'Jacking up the comic volume on intimate material, this stage treatment smothers the off-kilter appeal.\n\nEthel Barrymore Theatre, New York (through March 20)\n\nBrendan Fraser, Denis O\'Hare';
  assert.equal(ex('hollywood-reporter', t), null);
  assert.equal(ex('unmissabletheatre', 'With the true crime genre continuing to trend, Speculations - written by Torben Betts and directed by Trevor Nunn - should be an intriguing offering.'), null);
  assert.equal(ex('plays-international', ''), null);
});

test('junk values are rejected and treated as needing backfill', () => {
  for (const v of ['Written by', 'Staff Writer', 'Unknown', 'Plays International Staff', 'Ri-admin', '', null, undefined]) {
    assert.equal(isJunkBylineValue(v), true, String(v));
    assert.equal(needsCriticBackfill(v), true, String(v));
  }
  for (const v of ['Jeremy Malies', 'Claire Alexander', "Brian O'Neill"]) assert.equal(isJunkBylineValue(v), false, v);
});

test('a no-author cooldown does not hide a file whose text now yields a name', () => {
  const now = Date.parse('2026-11-09T00:00:00Z');
  const stamp = { at: '2026-11-08T20:46:01.008Z', result: 'no-author' };
  const mk = (fullText) => ({ dir: 'x', file: 'f', outletId: 'plays-international', data: { outletId: 'plays-international', criticName: 'Unknown', criticBackfillAttempt: stamp, fullText } });
  const named = mk('“Speculations” at Marylebone Theatre Jeremy Malies in central London ★★☆☆☆ 8 November 2026 This new play');
  const bare = mk('No credit anywhere in this text.');
  const out = orderCriticCandidates([named, bare], { now });
  assert.deepEqual(out, [named]);
});

test('BRO-7165 review: refuses sentence words, photo credits', async () => {
  const { extractMarkAspenByline, extractFirstNightByline } = (await import('node:module')).createRequire(import.meta.url)('../../scripts/lib/critic-byline-backfill.js');
  assert.equal(extractMarkAspenByline('Tosca Review by Claire This production was superb'), null);
  assert.equal(extractFirstNightByline('Great show. Photos By Marc Brenner Share this: x'), null);
  assert.equal((extractFirstNightByline('Great show. By Guillermo Nazara Share this: x') || {}), 'Guillermo Nazara');
});

test('BRO-7165 ship-check: negative cases stay unnamed', async () => {
  const { extractCriticFromFullText: x } = (await import('node:module')).createRequire(import.meta.url)('../../scripts/lib/critic-byline-backfill.js');
  assert.equal(x('firstnightmagazine', 'Cast list. Written By Torben Betts Share this:'), null);
  assert.equal(x('firstnightmagazine', 'Cast list. Directed By Trevor Nunn Share this:'), null);
  assert.equal(x('a-youngish-perspective', 'at the Young Vic June 1, 2026 review'), null);
  assert.equal(x('a-youngish-perspective', 'Opening Night March 5, 2026 review'), null);
  assert.equal(x('markaspen', 'Tosca Review by Claire Tosca has been staged'), null);
  assert.equal(x('plays-international', 'Waiting for Godot Mark Brown in Waiting for Godot 3 March 2026 great'), null);
  assert.equal(x('plays-international', 'Speculations at Marylebone Theatre Jeremy Malies in central London ★★☆☆☆ 8 November 2026 text').name, 'Jeremy Malies');
  assert.equal(x('plays-international', 'X at Y Mark Brown on Clydeside ★★★★☆ 3 May 2026 text').name, 'Mark Brown');
});
