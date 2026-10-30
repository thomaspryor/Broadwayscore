/**
 * Q1 conflict rule + quality floor contract tests (Sprint 3, task #142).
 * Runs in the tsx unit batch (test.yml) — imports src TS directly per the
 * gate-logic precedent.
 *
 * Owner sign-off 2026-07-13 (plan card 39c637c5-416f-8132):
 *  - Producer announcements are ground truth. recouped:true → render the
 *    announcement; NEVER quote the recoupment model on that show.
 *  - Quality floor: modelDataQuality:'low' and modelMethod:'ai-estimated'
 *    numbers stay off the card.
 *
 * BRO-4623 additions (bottom of file): closed shows with a final designation
 * show no model output (P0-4); closed TBD reads "Undisclosed" (P1-10);
 * neutral recoupment wording and source-gated confidence (P0-8); the Return
 * column only shows a reported, cited multiple (P0-1); one break-even (P1-3).
 */
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const {
  getRecoupmentDisplayMode,
  getDisplayableModelRange,
  meetsModelQualityFloor,
  isFinalClosedOutcome,
  isClosedWithoutRecouping,
  isUnannouncedRecoupment,
  formatRecoupedDate,
  getRecoupmentAttribution,
  getReportedInvestorMultiple,
  getEstimatedReturnRange,
  formatReturnRange,
  getDesignationDisplay,
  getBreakEven,
  getDisplayableAnalystRange,
  getDisplayableEstimateRange,
  toPublicShowCommercial,
  getRecoupedCellSummary,
  likelyOutcomeBasis,
} = await import('../../src/lib/commercial-display.ts');

const base = {
  designation: 'TBD',
  capitalization: 10_000_000,
  capitalizationSource: 'SEC',
  weeklyRunningCost: 600_000,
  recouped: null,
  recoupedDate: null,
  recoupedWeeks: null,
};

test('the public card retains the return snapshot date even when raw estimate fields are omitted', () => {
  const { returnSnapshotLabel } = createRequire(import.meta.url)('../../scripts/lib/commercial-return-snapshot');
  const row = { ...base, designation: 'Trickle', recouped: true, recoupedDate: '2024-04', estimatedRecoupmentPct: [110, 120], estimatedRecoupmentDate: '2025-06-01' };
  const publicRow = toPublicShowCommercial(row);
  assert.equal(publicRow.returnSnapshotAsOf, '2025-06-01');
  assert.equal(returnSnapshotLabel(publicRow, { status: 'open' }), 'as of Jun 2025');
  assert.equal(returnSnapshotLabel(publicRow, { status: 'closed' }), null);
});

test('Q1: announced recoupment always wins — model is never quoted', () => {
  // Real conflict shape (our-town): producers announced, model disagrees.
  const conflict = {
    ...base,
    recouped: true,
    recoupedDate: '2025-01',
    recoupedSource: 'Playbill grosses; Deadline (hints)',
    modelRecouped: false,
    modelRecoupmentPct: [27, 51.9, 75],
    modelDataQuality: 'medium',
    modelMethod: 'weekly-model',
  };
  assert.equal(getRecoupmentDisplayMode(conflict), 'announced');

  // Model AGREES (hamilton shape) — still announcement only, no model quote.
  const agree = { ...conflict, modelRecouped: true, modelRecoupmentPct: [14418, 15926, 17248] };
  assert.equal(getRecoupmentDisplayMode(agree), 'announced');

  // Even an uncited recouped:true must never fall through to a dual display.
  const uncited = { ...base, recouped: true, modelRecoupmentPct: [50, 60, 70] };
  assert.equal(getRecoupmentDisplayMode(uncited), 'announced');
});

test('model renders only without an announced state AND above the quality floor', () => {
  const model = {
    ...base,
    recouped: null,
    modelRecoupmentPct: [40, 55, 70],
    modelDataQuality: 'high',
    modelMethod: 'weekly-model',
  };
  assert.equal(getRecoupmentDisplayMode(model), 'model');

  // recouped:false is not an announced-recouped state — model still renders.
  assert.equal(getRecoupmentDisplayMode({ ...model, recouped: false }), 'model');
});

test('quality floor: low quality and ai-estimated model output are hidden', () => {
  const model = { ...base, modelRecoupmentPct: [40, 55, 70], modelMethod: 'weekly-model' };
  assert.equal(getRecoupmentDisplayMode({ ...model, modelDataQuality: 'low' }), 'none');
  assert.equal(
    getRecoupmentDisplayMode({ ...model, modelDataQuality: 'medium', modelMethod: 'ai-estimated' }),
    'none'
  );
  assert.equal(meetsModelQualityFloor({ ...base, modelDataQuality: 'low' }), false);
  assert.equal(meetsModelQualityFloor({ ...base, modelMethod: 'ai-estimated' }), false);
  assert.equal(meetsModelQualityFloor({ ...base, modelDataQuality: 'high', modelMethod: 'weekly-model' }), true);
  // Missing model metadata is not below the floor (nothing to hide).
  assert.equal(meetsModelQualityFloor(base), true);
});

test('legacy AI research estimate is NOT a fallback when the model is floored', () => {
  const floored = {
    ...base,
    modelRecoupmentPct: [10, 20, 30],
    modelDataQuality: 'low',
    modelMethod: 'ai-estimated',
    estimatedRecoupmentPct: [60, 80],
    estimatedRecoupmentSource: "GPT DR: 'Estimated 60-80% of cap recovered.'",
  };
  assert.equal(getRecoupmentDisplayMode(floored), 'none');
});

test('unannounced recoupments: the isEstimate.recouped flag or the source wording, never the hand-review flag', () => {
  // sweeney-todd-2023 shape: the source says so outright.
  const sweeney = {
    ...base,
    recouped: true,
    humanReviewedDesignation: true,
    recoupedSource:
      'No producer announcement; Broadway Journal (Aug 25 2023) projected recoupment ~fall 2023. Kept recouped:true per owner review 2026-07-13.',
  };
  assert.equal(isUnannouncedRecoupment(sweeney), true);
  assert.equal(getRecoupmentDisplayMode(sweeney), 'announced');

  // into-the-woods-2022 shape: a trade listing with no announcement phrase.
  // The plan flags it isEstimate.recouped, and the flag alone decides.
  const intoTheWoods = {
    ...base,
    recouped: true,
    humanReviewedDesignation: true,
    recoupedSource: 'Broadway Journal (Aug 25 2023) lists Into the Woods among 2022-23 commercial winners.',
  };
  assert.equal(isUnannouncedRecoupment({ ...intoTheWoods, isEstimate: { recouped: true } }), true);

  // purpose-2025 / gutenberg shape: announced AND hand-reviewed. The
  // hand-review flag marks any checked record, so it must not downgrade one
  // (BRO-4623: the old rule printed "Scorecard editorial assessment" here).
  assert.equal(isUnannouncedRecoupment(intoTheWoods), false);
  assert.equal(
    isUnannouncedRecoupment({ ...base, recouped: true, humanReviewedDesignation: true, recoupedSource: 'Deadline (Jun 2026)' }),
    false
  );

  // Plain announced show.
  assert.equal(isUnannouncedRecoupment({ ...base, recouped: true, recoupedSource: 'Variety (Mar 2016)' }), false);

  // Never without recouped:true (leopoldstadt-2022 designation lock shape).
  assert.equal(
    isUnannouncedRecoupment({ ...base, recouped: false, humanReviewedDesignation: true, isEstimate: { recouped: true } }),
    false
  );
});

test('formatRecoupedDate handles YYYY-MM, YYYY, and junk', () => {
  assert.equal(formatRecoupedDate('2025-01'), 'January 2025');
  assert.equal(formatRecoupedDate('2022-12'), 'December 2022');
  assert.equal(formatRecoupedDate('1999'), '1999');
  assert.equal(formatRecoupedDate('2025-13'), '2025'); // out-of-range month → year
  assert.equal(formatRecoupedDate(null), null);
  assert.equal(formatRecoupedDate(''), null);
  assert.equal(formatRecoupedDate('circa 2020'), null);
});

// ── BRO-4623 ────────────────────────────────────────────────────────────────

const modelFields = {
  modelRecoupmentPct: [60, 86, 110],
  modelDataQuality: 'high',
  modelMethod: 'weekly-model',
};

test('P0-4: a closed show with a final designation never shows an estimate that contradicts it', () => {
  // Back to the Future shape: "Flop" next to a model 86%.
  const flop = { ...base, ...modelFields, designation: 'Flop', status: 'closed', recouped: false };
  assert.equal(isFinalClosedOutcome(flop), true);
  assert.equal(getRecoupmentDisplayMode(flop), 'none');
  assert.equal(getDisplayableModelRange(flop), null);

  for (const designation of ['Easy Winner', 'Windfall', 'Miracle', 'Trickle', 'Nonprofit', 'Tour Stop']) {
    assert.equal(
      getRecoupmentDisplayMode({ ...flop, designation }),
      'none',
      `closed ${designation} must not quote the model`
    );
  }
  // BRO-5502: an estimate that agrees with a Fizzle (86% sits in 30-99) shows; one that agrees with a Flop too.
  assert.equal(getRecoupmentDisplayMode({ ...flop, designation: 'Fizzle' }), 'model');
  assert.equal(getRecoupmentDisplayMode({ ...flop, modelRecoupmentPct: [0, 12, 25] }), 'model');
});

test('P0-4: open shows keep the labelled estimate; a closed TBD is not a final outcome', () => {
  const open = { ...base, ...modelFields, status: 'open' };
  assert.equal(getRecoupmentDisplayMode(open), 'model');
  assert.deepEqual(getDisplayableModelRange(open), [60, 86, 110]);
  assert.equal(getRecoupmentDisplayMode({ ...open, status: 'previews' }), 'model');
  assert.equal(isFinalClosedOutcome({ designation: 'TBD', status: 'closed' }), false);
  // A wrongly-designated running show is not "final" either (the data rule
  // for that lives in validate-data, not here).
  assert.equal(isFinalClosedOutcome({ designation: 'Flop', status: 'open' }), false);
});

test('"Did not recoup" needs a closed Fizzle or Flop, not just recouped:false', () => {
  for (const designation of ['Fizzle', 'Flop']) {
    assert.equal(isClosedWithoutRecouping({ designation, status: 'closed', recouped: false }), true, designation);
  }
  // The stub enroller writes recouped:false on every new record, so a closed
  // TBD ("Undisclosed") has no outcome to state; nonprofits have no investors.
  const { makeStub } = createRequire(import.meta.url)('../../scripts/initialize-commercial-stub.js');
  const stub = makeStub();
  assert.equal(isClosedWithoutRecouping({ ...stub, status: 'closed' }), false);
  for (const designation of ['TBD', 'Nonprofit', 'Tour Stop', 'Easy Winner']) {
    assert.equal(isClosedWithoutRecouping({ designation, status: 'closed', recouped: false }), false, designation);
  }
  // Still running or recoupment unknown: no claim.
  assert.equal(isClosedWithoutRecouping({ designation: 'Flop', status: 'open', recouped: false }), false);
  assert.equal(isClosedWithoutRecouping({ designation: 'Flop', status: 'closed', recouped: null }), false);
});

test('P1-10: a closed TBD reads "Undisclosed", a running TBD stays TBD', () => {
  const closed = getDesignationDisplay('TBD', 'closed');
  assert.equal(closed.label, 'Undisclosed');
  assert.equal(closed.description, 'Closed; outcome not announced');
  assert.equal(closed.isUndisclosed, true);

  const running = getDesignationDisplay('TBD', 'open');
  assert.equal(running.label, 'TBD');
  assert.equal(running.isUndisclosed, false);
  assert.equal(running.description, 'Still running; too early to tell');

  assert.equal(getDesignationDisplay('Flop', 'closed').label, 'Flop');
});

test('BRO-5520: a TBD show that has not opened does not say "Still running"', async () => {
  const upcoming = getDesignationDisplay('TBD', 'upcoming');
  assert.equal(upcoming.label, 'TBD');
  assert.equal(upcoming.description, 'Not open yet; too early to tell');
  assert.equal(getDesignationDisplay('TBD', 'announced').description, 'Not open yet; too early to tell');
  assert.equal(getDesignationDisplay('TBD', 'previews').description, 'In previews; too early to tell');
  // Only TBD changes; other designations keep their own text.
  assert.equal(getDesignationDisplay('Windfall', 'previews').description, getDesignationDisplay('Windfall', 'open').description);
  // A status the map does not name (or an inherited key) gets TBD's neutral text.
  const neutral = 'Too early to tell: still running or not open yet';
  assert.equal(getDesignationDisplay('TBD', null).description, neutral);
  assert.equal(getDesignationDisplay('TBD', 'toString').description, neutral);
  // The legend (/biz guide, methodology) uses the neutral text, so it never contradicts a card.
  const { getLegendEntries } = await import('../../src/config/commercial.ts');
  assert.equal(getLegendEntries().find((e) => e.name === 'TBD').description, neutral);
  assert.ok(getLegendEntries().every((e) => !/still running;/i.test(e.description)));
});

test('BRO-5020: a closed TBD that announced recoupment does not say "outcome not announced"', async () => {
  const d = getDesignationDisplay('TBD', 'closed', true);
  assert.equal(d.label, 'Recouped · return undisclosed');
  assert.doesNotMatch(d.description, /outcome not announced/);
  // Recouped styling, not the grey unknown-outcome styling, and in the legend.
  assert.equal(d.isUndisclosed, false);
  assert.notEqual(d.textClass, getDesignationDisplay('TBD', 'closed', null).textClass);
  const { getLegendEntries } = await import('../../src/config/commercial.ts');
  assert.ok(getLegendEntries().some((e) => e.name === d.label && e.description === d.description));
  assert.equal(getDesignationDisplay('TBD', 'closed', false).label, 'Undisclosed');
  assert.equal(getDesignationDisplay('TBD', 'closed', null).label, 'Undisclosed');
  assert.equal(getDesignationDisplay('TBD', 'open', true).label, 'TBD');
  assert.equal(getDesignationDisplay('Windfall', 'closed', true).label, 'Windfall');
});

test('BRO-5502: a closed TBD ("Undisclosed") shows its final estimate, labelled (owner 2026-10-16, replacing BRO-5020)', () => {
  // Mrs. Doubtfire's shape: closed without an announced outcome, model 0-8%.
  const closedTbd = { designation: 'TBD', status: 'closed', recouped: null, modelRecoupmentPct: [0, 0, 8.2], modelDataQuality: 'medium', modelMethod: 'weekly-model' };
  assert.equal(getRecoupmentDisplayMode(closedTbd), 'model');
  assert.deepEqual(getDisplayableModelRange(closedTbd), [0, 0, 8.2]);
  // The quality floor still holds; a recouped closed TBD shows the announcement.
  assert.equal(getRecoupmentDisplayMode({ ...closedTbd, modelDataQuality: 'low' }), 'none');
  assert.equal(getRecoupmentDisplayMode({ ...closedTbd, recouped: true }), 'announced');
});

test('BRO-5502: the analyst figure leads wherever it shows', () => {
  const twoStrangers = { ...base, status: 'open', modelRecoupmentPct: null, analystRecoupPct: [0, 0], analystRecoupAsOf: '2026-10-13', analystRecoupUrl: 'https://www.reddit.com/r/Broadway/comments/x/' };
  assert.equal(getRecoupmentDisplayMode(twoStrangers), 'analyst');
  assert.deepEqual(getDisplayableAnalystRange(twoStrangers), [0, 0]);
  // Over a model too (the analyst covers musicals, where ours runs high).
  assert.equal(getRecoupmentDisplayMode({ ...twoStrangers, ...modelFields }), 'analyst');
  // Never over a recoupment record, and never on a nonprofit or a tour stop.
  assert.equal(getRecoupmentDisplayMode({ ...twoStrangers, recouped: true }), 'announced');
  assert.equal(getRecoupmentDisplayMode({ ...twoStrangers, designation: 'Nonprofit' }), 'none');
  assert.equal(getRecoupmentDisplayMode({ ...twoStrangers, designation: 'Tour Stop' }), 'none');
  // A nonprofit production with enhancement money has investors to repay (LCT's Ragtime, analyst 83).
  const ragtime = { ...twoStrangers, designation: 'Nonprofit', productionType: 'enhancement', status: 'closed', analystRecoupPct: [83, 83] };
  assert.equal(getRecoupmentDisplayMode(ragtime), 'analyst');
  assert.deepEqual(getRecoupedCellSummary(ragtime).kind, 'analyst');
  assert.deepEqual(getRecoupedCellSummary({ ...ragtime, analystRecoupPct: undefined, capitalization: null }), { kind: 'reason', text: 'Budget not disclosed' });
  // A range past 100 on an unrecouped show tops out at 99; a low end of 100+ stays (reads "not yet announced").
  assert.deepEqual(getDisplayableAnalystRange({ ...twoStrangers, analystRecoupPct: [80, 120] }), [80, 95]);
  assert.deepEqual(getDisplayableAnalystRange({ ...twoStrangers, analystRecoupPct: [100, 100] }), [100, 100]);
  // A closed Flop takes the analyst's figure only when it fits the label (Death Becomes Her: 10-30).
  const dbh = { ...twoStrangers, status: 'closed', designation: 'Flop', recouped: false, analystRecoupPct: [10, 30] };
  assert.equal(getRecoupmentDisplayMode(dbh), 'analyst');
  assert.equal(getRecoupmentDisplayMode({ ...dbh, analystRecoupPct: [50, 70] }), 'none');
});

test('BRO-5502: the % Recouped cell always says something', () => {
  const cell = (over) => getRecoupedCellSummary({ ...base, modelRecoupmentPct: null, status: 'open', ...over });
  assert.deepEqual(cell({ recouped: true }), { kind: 'recouped' });
  assert.deepEqual(cell({ analystRecoupPct: [10, 30], analystRecoupAsOf: '2026-10-13', analystRecoupUrl: 'https://r/x' }),
    { kind: 'analyst', range: [10, 30], withModel: false, asOf: '2026-10-13', url: 'https://r/x', ours: false });
  assert.deepEqual(cell({ ...modelFields }), { kind: 'model', pct: [60, 86, 110] });
  // A trade-reported return beats every estimate on a closed show (Hell's Kitchen).
  const hk = { status: 'closed', designation: 'Fizzle', recouped: false, analystRecoupPct: [60, 60], reportedReturn: { lo: 55, hi: 60, outlet: 'Broadway Journal', asOf: 'Oct 2026' } };
  assert.deepEqual(cell(hk), { kind: 'reported', lo: 55, hi: 60, outlet: 'Broadway Journal', asOf: 'Oct 2026' });
  assert.equal(cell({ ...hk, reportedReturn: undefined }).kind, 'analyst');
  assert.equal(cell({ ...hk, reportedReturn: undefined, analystRecoupPct: undefined }).kind, 'loss');
  assert.deepEqual(cell({ designation: 'Nonprofit' }), { kind: 'reason', text: 'Not applicable: nonprofit' });
  assert.deepEqual(cell({ designation: 'Tour Stop' }), { kind: 'reason', text: 'Not applicable: tour stop' });
  assert.deepEqual(cell({ status: 'closed', capitalization: null, modelMethod: 'ai-estimated', modelDataQuality: 'low' }), { kind: 'reason', text: 'Budget not disclosed' });
  assert.deepEqual(cell({ status: 'closed', modelDataQuality: 'low' }), { kind: 'reason', text: 'Running costs not reported' });
  assert.deepEqual(cell({ modelDisplayHold: 'awaiting-truth' }), { kind: 'reason', text: 'Not enough reported data yet' });
  assert.deepEqual(cell({}), { kind: 'reason', text: 'Not enough data to estimate' });
});

const tradeSource = { type: 'trade', url: 'https://variety.com/2014/legit/news/example', date: '2014-12-10' };
const secSource = { type: 'sec', url: 'https://www.sec.gov/Archives/edgar/data/0000000/example.htm', date: '2015-01-01' };

test('P0-8: neutral wording, high confidence only with a trade or SEC link', () => {
  const traded = getRecoupmentAttribution({
    ...base,
    recouped: true,
    recoupedDate: '2014-12',
    recoupedSource: 'Variety (Dec 2014)',
    sources: [tradeSource],
  });
  assert.equal(traded.headline, 'Recouped, December 2014');
  assert.equal(traded.qualifier, null);
  assert.equal(traded.sourceUrl, tradeSource.url);
  assert.equal(traded.sourceText, 'Variety (Dec 2014)');
  assert.equal(traded.confidence.level, 'high');
  assert.equal(traded.confidence.label, 'High confidence');
  assert.equal(traded.confidence.basis, 'Trade press report');

  const sec = getRecoupmentAttribution({ ...base, recouped: true, recoupedDate: '2015-01', sources: [secSource] });
  assert.equal(sec.confidence.level, 'high');
  assert.equal(sec.confidence.basis, 'SEC filing');
  assert.equal(sec.sourceText, 'SEC filing');

  const unlinked = getRecoupmentAttribution({
    ...base,
    recouped: true,
    recoupedDate: '2019',
    recoupedSource: 'Variety (2019)',
    sources: [{ type: 'manual', url: 'https://example.com', date: '2019-01-01' }],
  });
  assert.equal(unlinked.headline, 'Recouped, 2019'); // year-only date

  // BRO-5568: a date we estimated prints "~", a reported one stays plain.
  const estimated = getRecoupmentAttribution({ ...base, recouped: true, recoupedDate: '1997-03', isEstimate: { recoupedDate: true } });
  assert.equal(estimated.headline, 'Recouped, ~March 1997');
  // An estimated date is never "High confidence" even with a cited trade source (BRO-5568).
  assert.equal(getRecoupmentAttribution({ ...base, recouped: true, recoupedDate: '1997-03', isEstimate: { recoupedDate: true }, sources: [{ type: 'trade', url: 'https://example.com/a', date: '1997-04-01' }] }).confidence.level, 'medium');
  assert.equal(getRecoupmentAttribution({ ...base, recouped: true, recoupedDate: '1997-03', sources: [{ type: 'trade', url: 'https://example.com/a', date: '1997-04-01' }] }).confidence.level, 'high');
  // BRO-5779: a report month after closing reads "reported", never as the date it happened.
  const late = getRecoupmentAttribution({ ...base, recouped: true, recoupedDate: '2026-04' }, '2024-04-27');
  assert.equal(late.headline, 'Recouped, reported April 2026');
  assert.equal(getRecoupmentAttribution({ ...base, recouped: true, recoupedDate: '2026-04' }, null).headline, 'Recouped, April 2026');
  assert.equal(getRecoupmentAttribution({ ...base, recouped: true, recoupedDate: '2024-04' }, '2024-04-27').headline, 'Recouped, April 2024');
  assert.equal(getRecoupmentAttribution({ ...base, recouped: true, recoupedDate: '2026-04', isEstimate: { recoupedDate: true } }, '2024-04-27').headline, 'Recouped, ~April 2026');
  const reported = getRecoupmentAttribution({ ...base, recouped: true, recoupedDate: '1997-03', isEstimate: { recoupedDate: false } });
  assert.equal(reported.headline, 'Recouped, March 1997');
  assert.equal(unlinked.confidence.level, 'medium');
  assert.equal(unlinked.sourceUrl, null);

  const nonHttp = getRecoupmentAttribution({
    ...base,
    recouped: true,
    sources: [{ type: 'trade', url: 'Playbill print edition', date: '2019-01-01' }],
  });
  assert.equal(nonHttp.headline, 'Recouped');
  assert.equal(nonHttp.sourceUrl, null);
  assert.equal(nonHttp.confidence.level, 'medium');
});

test('P0-8: "no public announcement" and editorial records read "Not publicly announced", never high confidence', () => {
  const disney = getRecoupmentAttribution({
    ...base,
    recouped: true,
    recoupedDate: '2014-12',
    recoupedSource: 'Disney never formally announces recoupment.',
    sources: [tradeSource],
  });
  assert.equal(disney.qualifier, 'Not publicly announced');
  assert.equal(disney.confidence.level, 'medium');

  const noAnnouncement = getRecoupmentAttribution({
    ...base,
    recouped: true,
    recoupedSource: 'No public announcement; grosses suggest recoupment.',
    sources: [tradeSource],
  });
  assert.equal(noAnnouncement.qualifier, 'Not publicly announced');
  assert.equal(noAnnouncement.confidence.level, 'medium');

  // BRO-4722: the live Lion King / Aladdin wording.
  const doesNot = getRecoupmentAttribution({
    ...base,
    recouped: true,
    recoupedDate: '1999',
    recoupedSource: 'Disney does not announce recoupments. Recouped status follows from more than $2B in Broadway grosses; the 1999 date is an estimate.',
    sources: [tradeSource],
  });
  assert.equal(doesNot.qualifier, 'Not publicly announced');
  assert.equal(doesNot.confidence.level, 'medium');
  // An announcement is never downgraded.
  const announced = getRecoupmentAttribution({
    ...base,
    recouped: true,
    recoupedSource: 'Producers announced recoupment on October 3, 2013, after 30 weeks',
    sources: [tradeSource],
  });
  assert.equal(announced.qualifier, null);

  const flagged = getRecoupmentAttribution({
    ...base,
    recouped: true,
    humanReviewedDesignation: true,
    isEstimate: { recouped: true },
    recoupedSource: 'Broadway Journal lists it among 2022-23 commercial winners.',
    sources: [tradeSource],
  });
  assert.equal(flagged.qualifier, 'Not publicly announced');
  assert.equal(flagged.confidence.level, 'medium');
  assert.equal(flagged.confidence.basis, 'Not publicly announced');

  // appropriate shape: "editorial judgment" in the source reads as not announced.
  const appropriate = getRecoupmentAttribution({
    ...base,
    recouped: true,
    recoupedDate: '2024-03',
    humanReviewedDesignation: true,
    recoupedSource: 'No recoupment was announced. Counted as recouped as an editorial judgment: two extensions and a transfer.',
    sources: [tradeSource],
  });
  assert.equal(appropriate.headline, 'Recouped, March 2024');
  assert.equal(appropriate.qualifier, 'Not publicly announced');
  assert.equal(appropriate.confidence.level, 'medium');
});

test('an announced, hand-reviewed recoupment with a trade source reads high confidence, no qualifier', () => {
  const purpose = getRecoupmentAttribution({
    ...base,
    recouped: true,
    recoupedDate: '2026-06',
    humanReviewedDesignation: true,
    recoupedSource: 'Deadline, Broadway News and Playbill (June 2026)',
    sources: [tradeSource],
  });
  assert.equal(purpose.qualifier, null);
  assert.equal(purpose.confidence.level, 'high');
  assert.equal(purpose.confidence.basis, 'Trade press report');
});

test('P0-8: no attribution ever claims a producer announcement', () => {
  const shapes = [
    { recoupedSource: 'Variety (Dec 2014)', sources: [tradeSource] },
    { recoupedSource: 'Disney never formally announces recoupment.', sources: [tradeSource] },
    { recoupedSource: null, sources: [] },
    { humanReviewedDesignation: true, recoupedSource: 'editorial keep', sources: [] },
  ];
  for (const shape of shapes) {
    const a = getRecoupmentAttribution({ ...base, recouped: true, recoupedDate: '2020-02', ...shape });
    const text = [a.headline, a.qualifier, a.sourceText, a.confidence.label, a.confidence.basis].join(' ');
    assert.doesNotMatch(text, /producers? announced/i);
  }
});

test('P0-1: the Return column shows only a reported, cited multiple; never a model figure', () => {
  assert.equal(getReportedInvestorMultiple({ investorMultiple: 2.4, sources: [tradeSource] }), 2.4);
  assert.equal(getReportedInvestorMultiple({ investorMultiple: 2.4, sources: [] }), null, 'uncited');
  assert.equal(getReportedInvestorMultiple({ investorMultiple: 2.4 }), null, 'no sources');
  assert.equal(getReportedInvestorMultiple({ investorMultiple: null, sources: [tradeSource] }), null);
  assert.equal(getReportedInvestorMultiple({ investorMultiple: 0, sources: [tradeSource] }), null);
  assert.equal(getReportedInvestorMultiple({ investorMultiple: NaN, sources: [tradeSource] }), null);
  // A record with only model output (Chicago ~958x shape) has no reported multiple.
  assert.equal(
    getReportedInvestorMultiple({ modelRecoupmentPct: [90000, 95800, 99000], sources: [tradeSource] }),
    null
  );
});

test('P1-3: one break-even everywhere: model when it clears the floor, else weekly running cost', () => {
  const withModel = { modelBreakeven: 750_000, weeklyRunningCost: 600_000, modelDataQuality: 'high', modelMethod: 'weekly-model' };
  assert.equal(getBreakEven(withModel), 750_000);
  assert.equal(getBreakEven({ ...withModel, modelDataQuality: 'low' }), 600_000);
  assert.equal(getBreakEven({ ...withModel, modelMethod: 'ai-estimated' }), 600_000);
  assert.equal(getBreakEven({ ...withModel, modelBreakeven: null }), 600_000);
  assert.equal(getBreakEven({ modelBreakeven: null, weeklyRunningCost: null }), null);
  // BRO-4985: a model break-even below the running cost is stale (the cost
  // changed after the model ran); the cost is shown, never the lower figure.
  assert.equal(getBreakEven({ ...withModel, modelBreakeven: 536_585, weeklyRunningCost: 560_000 }), 560_000);
  // BRO-6217: an all-in cost holds royalties and rent, so a lower break-even is real.
  assert.equal(getBreakEven({ ...withModel, modelBreakeven: 937_545, weeklyRunningCost: 963_000, weeklyRunningCostBasis: 'all-in' }), 937_545);
});

test('BRO-4721: a Nonprofit production never shows a modeled % recouped (no investors to repay)', () => {
  const base = { recouped: null, modelRecoupmentPct: [-2, 6.6, 14.8], modelDataQuality: 'medium', modelMethod: 'weekly-model' };
  assert.equal(getRecoupmentDisplayMode({ ...base, designation: 'Nonprofit', status: 'open' }), 'none');
  assert.equal(getRecoupmentDisplayMode({ ...base, designation: 'TBD', status: 'open' }), 'model');
  // A recoupment record still wins for any designation.
  assert.equal(getRecoupmentDisplayMode({ ...base, designation: 'Nonprofit', recouped: true }), 'announced');
});

// BRO-5313: cited "% returned to investors" line on closed shows
{
  const { getReportedReturnLine } = await import('../../src/lib/commercial-display.ts');
  const rr = { lo: 55, hi: 60, outlet: 'Broadway Journal', asOf: 'Oct 2026' };
  test('BRO-5313: closed final show prints the cited return line', () => {
    assert.equal(
      getReportedReturnLine({ designation: 'Fizzle', recouped: false, status: 'closed', reportedReturn: rr }),
      'Investors got back about 55-60% (Broadway Journal, Oct 2026)'
    );
  });
  test('BRO-5313: no line without a reported figure, on running, TBD, recouped or nonprofit shows', () => {
    assert.equal(getReportedReturnLine({ designation: 'Fizzle', recouped: false, status: 'closed' }), null);
    assert.equal(getReportedReturnLine({ designation: 'Fizzle', recouped: false, status: 'open', reportedReturn: rr }), null);
    assert.equal(getReportedReturnLine({ designation: 'TBD', recouped: false, status: 'closed', reportedReturn: rr }), null);
    assert.equal(getReportedReturnLine({ designation: 'Windfall', recouped: true, status: 'closed', reportedReturn: rr }), null);
    assert.equal(getReportedReturnLine({ designation: 'Nonprofit', recouped: null, status: 'closed', reportedReturn: rr }), null);
  });
}

test('owner 2026-10-22: the estimate range spans the analyst and our model, rounded to 5', () => {
  const run = { ...base, status: 'open', recouped: false, modelDataQuality: 'medium', modelMethod: 'weekly-model', analystRecoupAsOf: '2026-10-13' };
  // Gatsby: analyst 20, model central 57 -> 20-55.
  assert.deepEqual(getDisplayableEstimateRange({ ...run, analystRecoupPct: [20, 20], modelRecoupmentPct: [30, 57, 80] }), { range: [20, 55], withModel: true });
  // Maybe Happy Ending: analyst 40, model 23 -> 25-40 (the owner's example).
  assert.deepEqual(getDisplayableAnalystRange({ ...run, analystRecoupPct: [40, 40], modelRecoupmentPct: [10, 23, 40] }), [25, 40]);
  // Model inside the analyst's range: same range, still credited.
  assert.deepEqual(getDisplayableEstimateRange({ ...run, analystRecoupPct: [10, 30], modelRecoupmentPct: [5, 17, 30] }), { range: [10, 30], withModel: true });
  // Below costs (the guard leaves 0 central with belowCosts) spans down to 0.
  assert.deepEqual(getDisplayableAnalystRange({ ...run, analystRecoupPct: [10, 10], modelRecoupmentPct: [0, 0, 5] }), [0, 10]);
  // A model under the quality floor, or held by the guard (null), stays out; the analyst alone still rounds.
  assert.deepEqual(getDisplayableEstimateRange({ ...run, analystRecoupPct: [83, 83], modelRecoupmentPct: [10, 23, 40], modelDataQuality: 'low' }), { range: [85, 85], withModel: false });
  assert.deepEqual(getDisplayableEstimateRange({ ...run, analystRecoupPct: [83, 83], modelRecoupmentPct: null }), { range: [85, 85], withModel: false });
  // Unrecouped tops out at 95; a low end of 100+ stays "Est. recouped".
  assert.deepEqual(getDisplayableAnalystRange({ ...run, analystRecoupPct: [90, 90], modelRecoupmentPct: [80, 130, 160] }), [90, 95]);
  assert.deepEqual(getDisplayableAnalystRange({ ...run, analystRecoupPct: [98, 98] }), [95, 95]);
  assert.deepEqual(getDisplayableAnalystRange({ ...run, analystRecoupPct: [100, 100] }), [100, 100]);
  // A closed Flop: the model joins only when the widened range still fits the label.
  const flop = { ...run, status: 'closed', designation: 'Flop', analystRecoupPct: [10, 10] };
  assert.equal(getDisplayableEstimateRange({ ...flop, modelRecoupmentPct: [5, 17, 30] }).withModel, true);
  assert.deepEqual(getDisplayableEstimateRange({ ...flop, modelRecoupmentPct: [60, 80, 95] }), { range: [10, 10], withModel: false });
  // A model held only as too uncertain or disagreeing still bounds the range (Gatsby: analyst 10-30, model 57).
  const gatsby = { ...run, analystRecoupPct: [10, 30], modelRecoupmentPct: null, modelHeldRange: [-11, 57, 117] };
  assert.deepEqual(getDisplayableEstimateRange({ ...gatsby, modelDisplayHold: 'too-uncertain' }), { range: [10, 55], withModel: true });
  assert.deepEqual(getDisplayableEstimateRange({ ...gatsby, modelDisplayHold: 'estimates-disagree' }), { range: [10, 55], withModel: true });
  // Far below costs counts as 0; other holds (too early, past 100, not yet trusted) keep it out.
  assert.deepEqual(getDisplayableEstimateRange({ ...gatsby, modelHeldRange: [-60, -44, -15], modelDisplayHold: 'out-of-bounds' }), { range: [0, 30], withModel: true });
  for (const hold of ['few-weeks', 'awaiting-truth', 'past-100-unannounced', 'star-deal-unknown']) {
    assert.deepEqual(getDisplayableEstimateRange({ ...gatsby, modelDisplayHold: hold }), { range: [10, 30], withModel: false }, hold);
  }
  // The show card reads the public record: it must carry what the range needs (the card once lost modelHeldRange).
  const outOfBounds = { ...gatsby, modelHeldRange: [-60, -44, -15], modelDisplayHold: 'out-of-bounds' };
  for (const rec of [{ ...gatsby, modelDisplayHold: 'too-uncertain' }, outOfBounds, { ...run, analystRecoupPct: [40, 40], modelRecoupmentPct: [10, 23, 40] }]) {
    assert.deepEqual(getDisplayableEstimateRange({ ...toPublicShowCommercial(rec), status: rec.status }), getDisplayableEstimateRange(rec));
  }
  // ...but only the central figure, floored at 0: the held range stays server-only.
  assert.deepEqual(toPublicShowCommercial({ ...gatsby, modelDisplayHold: 'too-uncertain' }).modelHeldRange, [57, 57, 57]);
  assert.deepEqual(toPublicShowCommercial(outOfBounds).modelHeldRange, [0, 0, 0]);
  for (const hold of ['few-weeks', 'past-100-unannounced']) assert.equal('modelHeldRange' in toPublicShowCommercial({ ...gatsby, modelDisplayHold: hold }), false, hold);
  assert.equal('modelHeldRange' in toPublicShowCommercial({ ...gatsby, modelDisplayHold: 'too-uncertain', recouped: true }), false);
  // A held central of 100+ never joins: it would hint at an unannounced recoupment (BRO-5073).
  const past100 = { ...gatsby, analystRecoupPct: [60, 70], modelHeldRange: [80, 130, 180], modelDisplayHold: 'too-uncertain' };
  assert.deepEqual(getDisplayableEstimateRange(past100), { range: [60, 70], withModel: false });
  assert.equal('modelHeldRange' in toPublicShowCommercial(past100), false);
  // The /biz cell carries the flag for its credit.
  assert.equal(getRecoupedCellSummary({ ...run, analystRecoupPct: [20, 20], modelRecoupmentPct: [30, 57, 80] }).withModel, true);
});

test('owner 2026-10-22: a closed label is checked on the rounded range the reader sees', () => {
  const closed = { status: 'closed', designation: 'Flop', analystRecoupPct: [0, 58] };
  // Mid 29 fits Flop, but it shows as 0-60 (mid 30, a Fizzle's): nothing shown.
  assert.equal(getDisplayableEstimateRange(closed), null);
  assert.deepEqual(getDisplayableEstimateRange({ ...closed, analystRecoupPct: [0, 50] }), { range: [0, 50], withModel: false });
});

test('BRO-6245: ourEstimateRangePct stands in for the analyst range and is credited as ours', () => {
  const closedFlop = { ...base, status: 'closed', designation: 'Flop', designationBasis: 'model-estimate', modelRecoupmentPct: null, ourEstimateRangePct: [5, 25] };
  assert.equal(getRecoupmentDisplayMode(closedFlop), 'analyst');
  assert.deepEqual(getDisplayableAnalystRange(closedFlop), [5, 25]);
  const cell = getRecoupedCellSummary(closedFlop);
  assert.equal(cell.kind, 'analyst');
  assert.equal(cell.ours, true);
  assert.equal(cell.url, null);
  // A range whose middle contradicts the closed label stays hidden.
  assert.notEqual(getRecoupmentDisplayMode({ ...closedFlop, ourEstimateRangePct: [40, 60] }), 'analyst');
  // An analyst figure, when present, wins and keeps its attribution.
  const both = getRecoupedCellSummary({ ...closedFlop, analystRecoupPct: [10, 20], analystRecoupAsOf: '2026-10-13', analystRecoupUrl: 'https://example.com/p' });
  assert.equal(both.ours, false);
  assert.deepEqual(both.range, [10, 20]);
  // Never on a recouped show.
  assert.equal(getRecoupmentDisplayMode({ ...closedFlop, recouped: true, designation: 'Trickle' }), 'announced');
});

test('BRO-6245: our own range never reads as an outside estimate in the Likely line', () => {
  const rec = { ...base, status: 'closed', designation: 'Did Not Recoup', recouped: false, ourEstimateRangePct: [10, 30] };
  assert.notEqual(likelyOutcomeBasis(rec), 'estimate');
});

// BRO-6555 (owner 2026-10-29): a win label shows our modeled investor return
// as a range. This supersedes the 2026-07-13 "never quote the model on a
// recouped show" rule for the return line only; the % bar rule stands.
test('BRO-6555: estimated return range for closed win labels', () => {
  const win = { designation: 'Easy Winner', modelInvestorMultiple: [1.04, 1.21, 1.33] };
  const r = (rec, status = 'closed') => getEstimatedReturnRange(rec, status);
  assert.deepEqual(r(win), [1.04, 1.33]);
  assert.equal(r(win, 'open'), null, 'running: a projection, not money returned');
  assert.equal(formatReturnRange([1.04, 1.33]), '1.0–1.3x');
  assert.equal(formatReturnRange([1.21, 1.24]), 'about 1.2x');
  assert.equal(r({ ...win, designation: 'Fizzle' }), null, 'loss label');
  assert.equal(r({ ...win, designation: 'TBD' }), null, 'undecided');
  assert.equal(r({ designation: 'Windfall' }), null, 'no model');
  assert.deepEqual(r({ ...win, modelInvestorMultiple: [1.5, 1.4, 1.2] }), [1.2, 1.5], 'order-safe');
  assert.deepEqual(r({ ...win, modelInvestorMultiple: [0.7, 1.02, 1.7] }), [1, 1.7], 'a win starts at 1x');
  assert.equal(r({ ...win, modelInvestorMultiple: [0.71, 0.95, 1.09] }), null, 'model middle under 1x contradicts the win');
  assert.equal(r({ ...win, modelInvestorMultiple: [0, 2.98, 9.1] }), null, 'too wide to mean anything');
  assert.equal(r({ ...win, investorMultiple: 2.4, sources: [tradeSource] }), null, 'a cited multiple wins');
});

// BRO-6564: exercise the real card with the same public projection as show pages.
const require = createRequire(import.meta.url);
const React = require('react');
const previousReact = globalThis.React;
globalThis.React = React;
after(() => {
  if (previousReact === undefined) delete globalThis.React;
  else globalThis.React = previousReact;
});
const { renderToStaticMarkup } = require('react-dom/server');
const BizBuzzCard = require('../../src/components/BizBuzzCard.tsx').default;

const winner = {
  designation: 'Easy Winner',
  capitalization: 10_000_000,
  weeklyRunningCost: null,
  recouped: true,
  recoupedDate: null,
  recoupedWeeks: null,
  modelInvestorMultiple: [1.3, 1.4, 1.5],
  modelDataQuality: 'medium',
};

function render(commercial = winner, showStatus = 'closed') {
  return renderToStaticMarkup(React.createElement(BizBuzzCard, {
    commercial: toPublicShowCommercial(commercial),
    showTitle: 'Test production',
    showStatus,
  }));
}

test('BRO-6564: closed winner return survives public projection and renders under the label', () => {
  const html = render();
  assert.match(html, /data-testid="estimated-return"/);
  assert.match(html, /Est\. 1\.3–1\.5x returned/);
  assert.match(html, /Our model/);
  assert.match(html, /source · filings, press \+ our model/);
  assert.ok(html.indexOf('Easy Winner') < html.indexOf('data-testid="estimated-return"'));
});

test('model-only wins use the same return wording and disclose assumed costs', () => {
  const html = render({ ...winner, recouped: null, modelInvestorMultiple: [0.95, 1.15, 1.3], modelDataQuality: 'low' });
  assert.match(html, /Est\. 1\.0–1\.3x returned/);
  assert.match(html, /Our model · running cost assumed/);
});

test('running shows never render the estimated final return', () => {
  for (const status of ['open', 'previews', 'upcoming', undefined]) {
    const html = status === undefined
      ? renderToStaticMarkup(React.createElement(BizBuzzCard, { commercial: toPublicShowCommercial(winner), showTitle: 'Test production' }))
      : render(winner, status);
    assert.doesNotMatch(html, /data-testid="estimated-return"/);
  }
});

test('reported returns take precedence over modeled winner returns', () => {
  const html = render({ ...winner, recouped: null, reportedReturn: { lo: 120, hi: 120, outlet: 'Variety', asOf: '2026-10-01' } });
  assert.match(html, /data-testid="reported-return"/);
  assert.match(html, /Variety/);
  assert.doesNotMatch(html, /data-testid="estimated-return"/);
  assert.doesNotMatch(render({ ...winner, investorMultiple: 1.4, sources: [{ type: 'trade', url: 'https://variety.com/article', date: '2026-10-01' }] }), /data-testid="estimated-return"/);
});

test('loss labels and missing, contradictory or overly wide model returns stay hidden', () => {
  for (const patch of [
    { designation: 'Flop', recouped: false },
    { modelInvestorMultiple: undefined },
    { modelInvestorMultiple: [0.5, 0.7, 0.9] },
    { modelInvestorMultiple: [1, 2, 5] },
  ]) assert.doesNotMatch(render({ ...winner, ...patch }), /data-testid="estimated-return"/);
});
