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
import test from 'node:test';
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
  getDesignationDisplay,
  getBreakEven,
  getDisplayableAnalystRange,
  getRecoupedCellSummary,
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

  assert.equal(getDesignationDisplay('Flop', 'closed').label, 'Flop');
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
  assert.deepEqual(getDisplayableAnalystRange({ ...twoStrangers, analystRecoupPct: [80, 120] }), [80, 99]);
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
    { kind: 'analyst', range: [10, 30], asOf: '2026-10-13', url: 'https://r/x' });
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
