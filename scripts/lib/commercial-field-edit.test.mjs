// Tests for scripts/lib/commercial-field-edit.js (BRO-4657).
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const { applyCommercialFieldEdit } = require('./commercial-field-edit');
const { mergeCommercialJson } = require('./merge-commercial-data');
const { commercialRecordErrors, commercialRecordWarnings } = require('./commercial-record-checks');
const basisIssues = (id, rec) => [...commercialRecordErrors(id, rec), ...commercialRecordWarnings(id, rec)]
  .filter(m => /basis/i.test(String(m)));

const NOW = '2026-10-05T03:00:00.000Z';
const fresh = () => ({ shows: { 'lucky-guy-2013': { designation: 'Flop', recouped: false, lastUpdated: '2026-09-01T00:00:00.000Z' } } });

describe('applyCommercialFieldEdit', () => {
  it('writes the field and stamps lastUpdated', () => {
    const c = fresh();
    const r = applyCommercialFieldEdit(c, 'lucky-guy-2013', 'designation', 'Flop', 'Easy Winner', NOW);
    assert.equal(r.ok, true);
    assert.equal(c.shows['lucky-guy-2013'].designation, 'Easy Winner');
    assert.equal(c.shows['lucky-guy-2013'].lastUpdated, NOW);
  });

  it('drops designationBasis when the designation leaves Flop/Fizzle', () => {
    const c = { shows: { 'torch-song-2018': { designation: 'Fizzle', designationBasis: 'reported-loss' } } };
    const r = applyCommercialFieldEdit(c, 'torch-song-2018', 'designation', 'Fizzle', 'Nonprofit', NOW);
    assert.equal(r.ok, true);
    assert.equal('designationBasis' in c.shows['torch-song-2018'], false);
  });

  it('keeps designationBasis on a loss-to-loss relabel', () => {
    const c = { shows: { 'grey-house': { designation: 'Fizzle', designationBasis: 'no-recoupment-announced' } } };
    applyCommercialFieldEdit(c, 'grey-house', 'designation', 'Fizzle', 'Flop', NOW);
    assert.equal(c.shows['grey-house'].designationBasis, 'no-recoupment-announced');
  });

  it('keeps a reported-loss basis when a Flop becomes Did Not Recoup (BRO-5636)', () => {
    const c = { shows: { 'leap-of-faith-2012': { designation: 'Flop', designationBasis: 'reported-loss', recouped: false } } };
    const r = applyCommercialFieldEdit(c, 'leap-of-faith-2012', 'designation', 'Flop', 'Did Not Recoup', NOW);
    assert.equal(r.ok, true);
    assert.equal(c.shows['leap-of-faith-2012'].designation, 'Did Not Recoup');
    assert.equal(c.shows['leap-of-faith-2012'].designationBasis, 'reported-loss');
  });

  it('settles the basis for a lowercase loss label, as the write guard will canonicalise it', () => {
    const c = { shows: { x: { designation: 'TBD' } } };
    applyCommercialFieldEdit(c, 'x', 'designation', 'TBD', 'flop', NOW);
    assert.equal(c.shows.x.designation, 'Flop');
    assert.equal(c.shows.x.designationBasis, 'no-recoupment-announced');
  });

  it('gives a relabel onto Flop/Fizzle the cautious default basis and settles needsLossEvidence', () => {
    const c = { shows: { x: { designation: 'Nonprofit', needsLossEvidence: true } } };
    applyCommercialFieldEdit(c, 'x', 'designation', 'Nonprofit', 'Fizzle', NOW);
    assert.equal(c.shows.x.designationBasis, 'no-recoupment-announced');
    assert.equal('needsLossEvidence' in c.shows.x, false);
  });

  it('leaves no basis complaint for the record checks after on or off loss relabels', () => {
    const c = { shows: {
      a: { designation: 'Fizzle', designationBasis: 'reported-loss' },
      b: { designation: 'TBD' },
    } };
    applyCommercialFieldEdit(c, 'a', 'designation', 'Fizzle', 'Nonprofit', NOW);
    applyCommercialFieldEdit(c, 'b', 'designation', 'TBD', 'Flop', NOW);
    assert.deepEqual(basisIssues('a', c.shows.a), []);
    assert.deepEqual(basisIssues('b', c.shows.b), []);
  });

  it('a planned basis drop listed after the designation edit counts as done', () => {
    const c = { shows: { x: { designation: 'Fizzle', designationBasis: 'reported-loss' } } };
    applyCommercialFieldEdit(c, 'x', 'designation', 'Fizzle', 'Nonprofit', NOW);
    const r = applyCommercialFieldEdit(c, 'x', 'designationBasis', 'reported-loss', null, NOW);
    assert.equal(r.ok, true);
  });

  it('refuses a stale oldValue and leaves the record untouched', () => {
    const c = fresh();
    const before = JSON.stringify(c);
    const r = applyCommercialFieldEdit(c, 'lucky-guy-2013', 'designation', 'Hit', 'Easy Winner', NOW);
    assert.equal(r.ok, false);
    assert.match(r.reason, /value changed since plan/);
    assert.equal(JSON.stringify(c), before);
  });

  it('treats a missing field as null for the oldValue check', () => {
    const c = fresh();
    const r = applyCommercialFieldEdit(c, 'lucky-guy-2013', 'recoupedDate', null, '2013-05', NOW);
    assert.equal(r.ok, true);
    assert.equal(c.shows['lucky-guy-2013'].recoupedDate, '2013-05');
  });

  it('refuses an unknown slug', () => {
    const r = applyCommercialFieldEdit(fresh(), 'nope', 'designation', null, 'Flop', NOW);
    assert.equal(r.ok, false);
    assert.match(r.reason, /No commercial entry/);
  });

  it('an edit to lastUpdated itself keeps the planned value', () => {
    const c = fresh();
    applyCommercialFieldEdit(c, 'lucky-guy-2013', 'lastUpdated', '2026-09-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', NOW);
    assert.equal(c.shows['lucky-guy-2013'].lastUpdated, '2026-01-01T00:00:00.000Z');
  });

  it('an edited record beats a stale concurrent copy in a no-base push merge', () => {
    // The 2026-10-05 failure: the fix left lastUpdated alone, the stale copy
    // tied and won. With the stamp, the fix is newer and survives.
    const remote = fresh();
    applyCommercialFieldEdit(remote, 'lucky-guy-2013', 'designation', 'Flop', 'Easy Winner', NOW);
    const stale = fresh();
    stale.shows['lucky-guy-2013'].modelLastRun = '2026-10-05T01:50:00.000Z';
    const { merged } = mergeCommercialJson(stale, remote);
    assert.equal(merged.shows['lucky-guy-2013'].designation, 'Easy Winner');
  });

  // BRO-5660: the basis belongs to the figure it was set for.
  describe('capitalizationBasis follows a capitalization edit', () => {
    const rec = () => ({ shows: { x: {
      capitalization: 18000000, capitalizationBasis: 'maximum',
      capitalizationSource: 'SEC Form D (X LLC, 2026): an offering of up to $18M', lastUpdated: '2026-09-01T00:00:00.000Z',
    } } });

    it('a source edit to a fully sold filing retags it sold', () => {
      const c = rec();
      applyCommercialFieldEdit(c, 'x', 'capitalizationSource', c.shows.x.capitalizationSource, 'SEC Form D/A (X LLC, 2026): $15M, fully sold', NOW);
      assert.equal(c.shows.x.capitalizationBasis, 'sold');
    });

    it('a figure edit under wording that says neither drops the stale basis', () => {
      const c = rec();
      c.shows.x.capitalizationSource = 'Variety';
      applyCommercialFieldEdit(c, 'x', 'capitalization', 18000000, 15000000, NOW);
      assert.equal(c.shows.x.capitalizationBasis, undefined);
    });

    it('a basis edit listed after counts the re-derived value as its oldValue', () => {
      const c = rec();
      applyCommercialFieldEdit(c, 'x', 'capitalizationSource', c.shows.x.capitalizationSource, 'THR', NOW);
      const r = applyCommercialFieldEdit(c, 'x', 'capitalizationBasis', 'maximum', 'reported', NOW);
      assert.equal(r.ok, true);
      assert.equal(c.shows.x.capitalizationBasis, 'reported');
    });

    it('a basis edit still refuses a value someone else set since the plan', () => {
      const c = rec();
      c.shows.x.capitalizationBasis = 'reported';
      const r = applyCommercialFieldEdit(c, 'x', 'capitalizationBasis', null, 'sold', NOW);
      assert.equal(r.ok, false);
    });
  });
});

