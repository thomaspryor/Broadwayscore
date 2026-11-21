// BRO-7932 class guard: London reviews at the record's OWN theatre must not be
// flagged "wrong production" by the collector verdict path; reviews of other
// theatres / runs must stay flagged. Fixtures are real stored verdict shapes
// (review text itself is copyrighted and lives in the private repo).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { applyOwnVenueTourCarveout } = require('./tour-stop-carveout.js');
const { buildVerificationPrompt } = require('./content-verifier.js');

const show = (venue, category, openingDate, closingDate) => ({ venue, category, openingDate, closingDate });
const RC = show('Royal Court', 'west-end', '2025-11-12', '2025-12-20');
const DORF = show('Dorfman Theatre', 'west-end', '2026-08-20', '2026-10-31');
const LYT = show('Lyttelton Theatre', 'west-end', '2024-11-28', '2025-01-25');
const GARRICK = show('Garrick Theatre', 'west-end', '2025-05-01', '2025-09-30');
const HP = show('Harold Pinter Theatre', 'west-end', '2026-06-01', '2026-09-30');

// Must be accepted: the critic attended this record's own theatre, inside the run.
const KNOWN_GOOD = [
  ['Porn Play at the Royal Court (taxonomy: "not a West End theatre")', RC, 'Royal Court Theatre', '2025-11-24', 'reviews the Royal Court Theatre production, not the West End production. The Royal Court is a pre-West End venue, not a West End theatre.'],
  ['Porn Play, Jerwood Theatre Upstairs (stage of the same house)', RC, 'Royal Court', '2025-11-15', 'reviews the Royal Court Upstairs production, which is not a West End theater.'],
  ['Pride at the Dorfman, reviewer names the National Theatre building', DORF, 'National Theatre', '2026-08-29', 'reviews the National Theatre production, a pre-West End tryout venue, not a West End theatre.'],
  ['Earnest at the Lyttelton, "National Theatre" (one building)', LYT, 'Lyttelton Theatre, National Theatre', '2024-11-29', 'reviews the National Theatre production, not a West End production.'],
  ['Mrs Warren at the Garrick, touring-company wording', GARRICK, 'The Garrick Theatre', '2025-05-30', 'a touring production at the Garrick Theatre, not the West End production.'],
];
// Must stay flagged: another theatre, another run, or no venue evidence.
const KNOWN_BAD = [
  ['R&J at Greenwich Theatre on a Harold Pinter record', HP, 'Greenwich Theatre', '2026-07-08', 'running at Greenwich Theatre, which is not a West End venue.'],
  ['Sheffield tour on a Garrick record', GARRICK, "Sheffield's Lyceum Theatre", '2025-06-01', 'reviews the Sheffield Lyceum touring production, not the West End run.'],
  ['no reported venue', RC, null, '2025-11-24', 'reviews a pre-West End production.'],
  ['own venue but years outside the run', RC, 'Royal Court Theatre', '2019-03-02', 'reviews the Royal Court production, not a West End theatre.'],
  ['Pride-record review placed at the Bridge', DORF, 'Bridge Theatre', '2026-09-05', 'reviews the production at the Bridge Theatre, not the Dorfman.'],
];

for (const [name, s, rv, date, reasoning] of KNOWN_GOOD) {
  test(`accepted: ${name}`, () => {
    const out = applyOwnVenueTourCarveout({ wrongProduction: true, reasoning, issues: [], reviewedVenue: rv }, s, { publishDate: date });
    assert.equal(out.wrongProduction, false);
    assert.equal(out.tourStopCarveoutApplied, true);
  });
}
for (const [name, s, rv, date, reasoning] of KNOWN_BAD) {
  test(`stays flagged: ${name}`, () => {
    const out = applyOwnVenueTourCarveout({ wrongProduction: true, reasoning, issues: [], reviewedVenue: rv }, s, { publishDate: date });
    assert.equal(out.wrongProduction, true);
  });
}

test('the prompt hands the model the record venue and market for London records', () => {
  for (const market of ['west-end', 'off-west-end']) {
    const { prompt } = buildVerificationPrompt({ scrapedText: 'x'.repeat(300), showTitle: 'Porn Play', outletName: 'Guardian', criticName: 'A', openingDate: '2025-11-12', venue: 'Royal Court', market, publishDate: '2025-11-24' });
    assert.match(prompt, /Royal Court/);
    assert.match(prompt, market === 'west-end' ? /West End venue/ : /Off-West End venue/);
  }
});

// Real-data guard (skipped when the private review-texts corpus is absent, e.g. CI
// checkouts without it): no London collector flag the own-venue carve-out would
// clear from its stored verdict may stay un-overridden.
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..');
const haveData = fs.existsSync(path.join(root, 'data', 'review-texts')) && fs.existsSync(path.join(root, 'data', 'shows.json'));
test('no unhealed own-venue London wrongProduction flags in the corpus', { skip: !haveData && 'review-texts not present' }, () => {
  const out = execFileSync('node', [path.join(root, 'scripts', 'recheck-london-wrongprod.js'), '--stored-audit', '--strict'], { encoding: 'utf8' });
  assert.match(out, /"unhealedOwnVenueFlags":0/);
});
