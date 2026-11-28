// Class guard for the wanted-2022 bug (reader report #1186): the Wanted page listed a 1928
// play's cast because ibdbUrl pointed at wanted-10398, and the Bug Fix Plan email printed
// "[object Object]" for the cast. Tests require() the real modules (CLAUDE.md §15).

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const { ibdbProductionId, ibdbUrlRejectReason, ibdbWrongProduction, IBDB_ID_FLOOR } = require('../../scripts/lib/ibdb-year-guard');
const { castFileMismatchReason, parseIbdbOpeningYear, shouldPurgeWrongProduction, shouldTombstone, MAX_WRONG_PRODUCTION_PURGES } = require('../../scripts/lib/cast-tombstone');
const { castDisjointFromBilling } = require('../../scripts/lib/cast-billing-overlap');
const { formatFieldValue, buildFixApprovalEmail } = require('../../scripts/lib/email-templates');

const WANTED = { id: 'wanted-2022', openingDate: '2026-11-08', status: 'open' };
const OLD_URL = 'https://www.ibdb.com/broadway-production/wanted-10398';
const NEW_URL = 'https://www.ibdb.com/broadway-production/wanted-543210';

describe('ibdb production-id guard', () => {
  it('reads the trailing numeric id', () => {
    assert.equal(ibdbProductionId(OLD_URL), 10398);
    assert.equal(ibdbProductionId(`${NEW_URL}?tab=cast`), 543210);
    assert.equal(ibdbProductionId('https://www.ibdb.com/broadway-production/no-id-here'), null);
  });

  it('rejects an old production id for a show opening 2006+ (the Wanted case)', () => {
    assert.equal(ibdbUrlRejectReason(WANTED, OLD_URL), 'predates-show');
    assert.equal(ibdbUrlRejectReason(2026, OLD_URL), 'predates-show');
  });

  it('rejects a url with no production id', () => {
    assert.equal(ibdbUrlRejectReason(WANTED, 'https://www.ibdb.com/broadway-production/private-lives-x'), 'no-production-id');
  });

  it('accepts a current production id and a missing url', () => {
    assert.equal(ibdbUrlRejectReason(WANTED, NEW_URL), null);
    assert.equal(ibdbUrlRejectReason(WANTED, null), null);
  });

  it('does not reject a pre-2006 show with a low id (floor only applies from 2006)', () => {
    assert.equal(ibdbUrlRejectReason({ id: 'wicked-2003', openingDate: '2003-10-30' }, 'https://www.ibdb.com/broadway-production/wicked-9999'), null);
    assert.ok(IBDB_ID_FLOOR < 378059, 'floor must sit below the lowest 2005 id seen in shows.json');
  });

  it('ibdbWrongProduction catches an old url even when the IBDB date never parsed', () => {
    assert.equal(ibdbWrongProduction(WANTED, { openingDate: null, ibdbUrl: OLD_URL }), true);
    assert.equal(ibdbWrongProduction(WANTED, { openingDate: '1928-04-30', ibdbUrl: NEW_URL }), true);
    assert.equal(ibdbWrongProduction(WANTED, { openingDate: '2026-11-08', ibdbUrl: NEW_URL }), false);
  });
});

describe('cast file import refuses a same-title older production', () => {
  // This is the exact shape of data/cast/wanted-2022.json: IBDB url, productionYear null.
  const castFile = { showId: 'wanted-2022', ibdbUrl: OLD_URL, productionYear: null, openingNightCast: [{ name: 'Alney Alba' }] };

  it('rejects by production id although productionYear is null', () => {
    assert.equal(castFileMismatchReason(castFile, WANTED), 'old-production-id');
  });

  it('still imports a current-production file', () => {
    assert.equal(castFileMismatchReason({ ...castFile, ibdbUrl: NEW_URL, productionYear: 2026 }, WANTED), null);
  });

  it('parses the page opening year when the <title> has none', () => {
    assert.equal(parseIbdbOpeningYear('Production Details Opening Date Apr 30, 1928 Closing Date Jun 02, 1928'), 1928);
    assert.equal(parseIbdbOpeningYear('no dates here'), null);
  });
});

describe('backfill-cast removes wrong-production data it already stores', () => {
  const idMismatch = { found: false, openingNightCast: [], productionMismatch: true, titleMismatch: true, rejectReason: 'predates-show', rejectedUrl: OLD_URL };
  const yearMismatch = { found: false, openingNightCast: [], productionMismatch: true, titleMismatch: true };

  it('purges when the id-rejected url is the one the show stores (url or cast file)', () => {
    assert.equal(shouldPurgeWrongProduction(idMismatch, { ibdbUrl: OLD_URL }, false), true);
    assert.equal(shouldPurgeWrongProduction(idMismatch, { ibdbUrl: null }, true, 0, OLD_URL), true);
    assert.equal(shouldPurgeWrongProduction({ ...idMismatch, rejectReason: 'no-production-id' }, { ibdbUrl: OLD_URL }, true), true);
  });

  it('never purges on the softer year check, which can be wrong about a correct stored url', () => {
    assert.equal(shouldPurgeWrongProduction(yearMismatch, { ibdbUrl: NEW_URL }, true, 0, NEW_URL), false);
  });

  it('never purges when the rejected url is not the stored one (a search found an old run)', () => {
    assert.equal(shouldPurgeWrongProduction(idMismatch, { ibdbUrl: NEW_URL }, true, 0, NEW_URL), false);
    assert.equal(shouldPurgeWrongProduction(idMismatch, { ibdbUrl: null }, true, 0, null), false);
  });

  it('does nothing when nothing wrong is stored, or the result is not a production mismatch', () => {
    assert.equal(shouldPurgeWrongProduction(idMismatch, { ibdbUrl: null }, false), false);
    assert.equal(shouldPurgeWrongProduction({ found: false, fetchFailed: true }, { ibdbUrl: OLD_URL }, true), false);
    assert.equal(shouldPurgeWrongProduction(null, { ibdbUrl: OLD_URL }, true), false);
  });

  it('stops purging past the per-run cap so a guard regression cannot empty the library', () => {
    assert.equal(shouldPurgeWrongProduction(idMismatch, { ibdbUrl: OLD_URL }, true, MAX_WRONG_PRODUCTION_PURGES - 1), true);
    assert.equal(shouldPurgeWrongProduction(idMismatch, { ibdbUrl: OLD_URL }, true, MAX_WRONG_PRODUCTION_PURGES), false);
  });

  it('a mismatch is still never tombstoned', () => {
    assert.equal(shouldTombstone(idMismatch), false);
  });
});

describe('cast vs Playbill billing overlap', () => {
  it('flags a cast with zero names in common with the billing', () => {
    const show = {
      cast: [{ name: 'Alney Alba' }, { name: 'Frank Andrews' }, { name: 'Charles Angelo' }],
      castBilling: ['Solea Pfeiffer', 'Liisi LaFontaine', 'Ledisi'],
    };
    assert.equal(castDisjointFromBilling(show), true);
  });

  it('does not flag a cast that shares anyone with the billing, accents ignored', () => {
    const show = {
      cast: [{ name: 'Solea Pfeiffer' }, { name: 'Frank Andrews' }, { name: 'José Luis' }],
      castBilling: ['Jose Luis', 'Ledisi', 'Luke James'],
    };
    assert.equal(castDisjointFromBilling(show), false);
  });

  it('does not flag when either list is too short to judge', () => {
    assert.equal(castDisjointFromBilling({ cast: [{ name: 'A B' }], castBilling: ['C D', 'E F', 'G H'] }), false);
    assert.equal(castDisjointFromBilling({ cast: [{ name: 'A B' }, { name: 'C D' }, { name: 'E F' }] }), false);
  });
});

describe('Bug Fix Plan email prints readable values', () => {
  const cast = [{ name: 'Alney Alba', role: 'Penelope Merton' }, { name: 'Frank Andrews', role: 'Major Longstreet' }];

  it('formatFieldValue renders object arrays as names with roles', () => {
    assert.equal(formatFieldValue(cast), 'Alney Alba (Penelope Merton), Frank Andrews (Major Longstreet)');
    assert.equal(formatFieldValue([]), 'empty');
    assert.equal(formatFieldValue(null), 'not set');
    assert.equal(formatFieldValue('2026-11-08'), '2026-11-08');
    assert.equal(formatFieldValue(Array.from({ length: 15 }, (_, i) => ({ name: `P${i}` }))).endsWith('and 3 more'), true);
  });

  it('the email never contains "[object Object]", and links the stored IBDB url', () => {
    const { html } = buildFixApprovalEmail({
      submitterName: 'Wes', showTitle: 'Wanted', originalMessage: 'cast looks wrong',
      planSummary: 'Clear the cast.', planSteps: ['Clear cast'], riskLevel: 'Low',
      currentState: [{ showTitle: 'Wanted', field: 'cast', currentValue: cast, proposedChange: 'Clear it', ibdbUrl: OLD_URL }],
      approveUrl: 'https://x/a', rejectUrl: 'https://x/r', issueNumber: 1186,
    });
    assert.equal(html.includes('[object Object]'), false);
    assert.ok(html.includes('Alney Alba (Penelope Merton)'));
    assert.ok(html.includes(OLD_URL));
  });
});
