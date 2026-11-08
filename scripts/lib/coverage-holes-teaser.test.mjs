// BRO-7131: class G. A short post that only points to the critic's full review elsewhere, counted beside that full
// review under another outlet, gave one critic two scores (Tosca ENO, Nantucket Sleigh Ride). Synthetic text only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { isTeaserPointer, sameCritic, teaserTwin } = require('./coverage-holes.js');

const teaser = { outletId: 'critic-blog', criticName: 'Jane Critic', fullText: 'A bold staging with a thrilling second act. Read my full Example Outlet review here. Share this: X Facebook Email' };
const full = { file: 'example-outlet--jane-critic.json', outletId: 'example-outlet', criticName: 'Jane Critic' };

test('a teaser beside the same critic\'s counted full review is a G row', () => {
  assert.deepEqual(teaserTwin(teaser, [full]), { twin: full.file, twinOutlet: 'example-outlet' });
});

test('a blog handle and the byline pair as one critic', () => {
  assert.equal(sameCritic('Cheryl Markosky', 'Cherylmarkosky'), true);
  assert.deepEqual(teaserTwin({ ...teaser, criticName: 'Janecritic' }, [full]), { twin: full.file, twinOutlet: 'example-outlet' });
});

test('a teaser whose full review is not counted stands in for it (not a G row)', () => {
  assert.equal(teaserTwin(teaser, []), null);
  assert.equal(teaserTwin(teaser, [{ ...full, criticName: 'Other Person' }]), null);
});

test('different critics sharing a surname, staff bylines and short names never pair', () => {
  assert.equal(sameCritic('Sarah Downs', 'Sam Downs'), false);
  assert.equal(sameCritic('Theatre Weekly Staff', 'Theatre Weekly Staff'), false);
  assert.equal(sameCritic('Ben', 'Ben'), false);
});

test('a full-length review that links elsewhere is not a teaser', () => {
  const long = { ...teaser, fullText: `${'The production is vivid and the cast strong. '.repeat(60)}Full review on Example Outlet.` };
  assert.equal(isTeaserPointer(long), false);
  assert.equal(teaserTwin(long, [full]), null);
});

test('the same outlet is never its own twin', () => {
  assert.equal(teaserTwin(teaser, [{ ...full, outletId: 'critic-blog' }]), null);
});

test('"complete review" wording is a pointer too', () => {
  assert.equal(isTeaserPointer({ fullText: 'A fine evening. Read the complete review here.' }), true);
});
