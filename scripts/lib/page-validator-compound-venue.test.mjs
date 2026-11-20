/**
 * BRO-7381: matchDerivedTitleVariant demanded the WHOLE venue string in the headings, so a house
 * billed with its stage ("Playwrights Horizons/Judith O. Rubin Theater") never matched a page that
 * names the house, the same blind spot BRO-7372 fixed in outlet-listing-helpers. require()s the real
 * function, no data files.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { matchDerivedTitleVariant } = require('./page-validator.js');

const mk = (venue) => ({ id: 'mpm', title: "Tracy Letts' Mary Page Marlowe", venue, category: 'off-broadway', creativeTeam: [{ name: 'Tracy Letts' }] });
const rival = { id: 'mpm-regional', title: 'Mary Page Marlowe', venue: 'Steppenwolf Theatre Company', category: 'regional' };
const run = (venue, heading, clash = false) => {
  const show = mk(venue);
  const titles = new Map(clash ? [['mary page marlowe', new Set(['mpm-regional'])]] : []);
  return matchDerivedTitleVariant(show.title, heading, { show, shows: [show, rival], titles });
};

test('house/stage venue: heading naming the house confirms the derived variant', () => {
  for (const venue of [
    'Playwrights Horizons/Judith O. Rubin Theater',
    'The Public Theater/Newman Theater',
    'Atlantic Theater Company/Linda Gross Theater',
  ]) {
    const house = venue.split('/')[0].replace(/^The /, '');
    const r = run(venue, `Mary Page Marlowe review at ${house}`);
    assert.ok(r, `${venue}: expected a match`);
    assert.equal(r.title, 'Mary Page Marlowe');
  }
});

test('a stage name alone is too weak to confirm; a longer different venue is rejected', () => {
  assert.equal(run('Playwrights Horizons/Judith O. Rubin Theater', 'Mary Page Marlowe at Judith O. Rubin Theater'), null);
  assert.equal(run('The Public Theater/Newman Theater', 'Mary Page Marlowe at Newman Theater Chicago'), null);
  assert.equal(run('The Public Theater/Newman Theater', 'Mary Page Marlowe review: Pittsburgh Public Theater'), null);
});

test('a title another show shares needs the whole venue name, not just the house', () => {
  const v = 'The Public Theater/Newman Theater';
  assert.equal(run(v, 'Mary Page Marlowe review: Pittsburgh Public Theater', true), null);
  assert.equal(run(v, 'Mary Page Marlowe review at The Public Theater', true), null);
  assert.ok(run(v, 'Mary Page Marlowe review at The Public Theater/Newman Theater', true));
});

test('a heading that names a different house still does not confirm', () => {
  assert.equal(run('Playwrights Horizons/Judith O. Rubin Theater', 'Mary Page Marlowe review at Steppenwolf'), null);
  assert.equal(run('Playwrights Horizons/Judith O. Rubin Theater', 'Mary Page Marlowe review'), null);
});

test('plain single-name venue still works', () => {
  assert.ok(run('Playwrights Horizons', 'Mary Page Marlowe at Playwrights Horizons'));
});

test('BRO-7381: the aggregator audit never flags a zero-critics archive as a bare "wrong-page"', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../audit-aggregator-coverage.js', import.meta.url), 'utf8');
  assert.ok(!src.includes('${key}-wrong-page`'), 'zero archive critics is stale-or-wrong, not proof of a wrong page');
  assert.ok(src.includes('-zero-critics-listed-stale-or-wrong-page`'));
});

test('BRO-7381: backfill-cast-web.yml keeps a weekly schedule and a scheduled-run limit', async () => {
  const { readFileSync } = await import('node:fs');
  const y = readFileSync(new URL('../../.github/workflows/backfill-cast-web.yml', import.meta.url), 'utf8');
  assert.match(y, /\n {2}schedule:\n {4}- cron: '[^']+'/);
  assert.match(y, /github\.event_name \}\}" = "schedule"[\s\S]{0,80}INPUT_LIMIT=\d+/);
});
