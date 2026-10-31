/**
 * BRO-2023: opening-night-poller.js computed
 *   isRevival = !!(show.isRevival || (show.id && /\b(19|20)\d{2}\b/.test(show.id)))
 * Every show.id in this project ends in its opening year, so the id-regex
 * half of that OR was true for EVERY show — isRevival was always true here
 * regardless of show.isRevival, wrongly tightening the Talkin' Broadway date
 * window (1 day vs 7, see scripts/lib/tb-direct-url.js withinDateWindow) for
 * every non-revival. Locks the fix: the predicate must depend on
 * show.isRevival alone.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { join } from 'path';

const ROOT = join(import.meta.dirname, '..', '..');
const src = readFileSync(join(ROOT, 'scripts/opening-night-poller.js'), 'utf8');

test('the id-ends-in-a-year regex is gone from the TB isRevival predicate', () => {
  assert.doesNotMatch(src, /show\.isRevival \|\| \(show\.id/,
    'the id-year OR clause regressed — it matches every show.id and forces isRevival true unconditionally');
});

test('isRevival passed to tryTbDirectUrl depends only on show.isRevival', () => {
  const m = src.match(/const isRevival = ([^\n;]+);\s*\n\s*const tb = await tryTbDirectUrl/);
  assert.ok(m, 'expected an `const isRevival = ...` assignment directly above the tryTbDirectUrl call');
  assert.equal(m[1].trim(), '!!show.isRevival');
});
