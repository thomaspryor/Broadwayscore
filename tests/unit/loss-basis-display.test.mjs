/**
 * Owner policy B (BRO-5020, 2026-10-11) display rules. Runs in the tsx unit
 * batch: imports src TS directly (the real functions, no copies).
 *  - A Fizzle/Flop carries "Based on no recoupment being announced" unless a
 *    source reported the loss: silence, our own notes and a missing basis all
 *    read the same. A reported loss carries nothing.
 *  - Every "did not recoup" style phrase goes through lossOutcomePhrase.
 *  - The basis reaches the browser through the toPublicShowCommercial allowlist.
 *  - Group C: no Reddit or blog characterisation prints as a source line.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

const { lossBasisCaveat, LOSS_ON_SILENCE_CAVEAT, toPublicShowCommercial, publicSourceText, lossOutcomePhrase, isReportedLoss, publicNotesText, lossCanChangeNote, LOSS_CAN_CHANGE_NOTE, likelyOutcomeLine, likelyOutcomeBasis, LIKELY_OUTCOME_BASIS, LIKELY_OUTCOME_NOTE, DESIGNATION_ESTIMATE_CAVEAT } =
  await import('../../src/lib/commercial-display.ts');

test('a Did Not Recoup show carries our best guess as a marked Likely line (owner 2026-10-18, BRO-5647)', () => {
  const dnr = { designation: 'Did Not Recoup' };
  // Any data quality: low still gives a guess, the label stays Did Not Recoup.
  assert.equal(likelyOutcomeLine({ ...dnr, modelDataQuality: 'low', modelReturnedExCreditPct: [0, 12, 30] }), 'Likely: Flop');
  assert.equal(likelyOutcomeLine({ ...dnr, modelReturnedExCreditPct: [20, 45, 70] }), 'Likely: Fizzle');
  // Order: ex-credit, then V2, then the original figure; a malformed tuple is skipped.
  assert.equal(likelyOutcomeLine({ ...dnr, modelReturnedExCreditPct: [1, 2], modelRecoupmentPctV2: [20, 45, 70], modelRecoupmentPct: [0, 5, 10] }), 'Likely: Fizzle');
  assert.equal(likelyOutcomeLine({ ...dnr, modelRecoupmentPct: [0, 5, 10] }), 'Likely: Flop');
  // The record's own estimate comes first, as for the Fizzle/Flop split.
  assert.equal(likelyOutcomeLine({ ...dnr, analystRecoupPct: [40, 50], modelReturnedExCreditPct: [0, 12, 30] }), 'Likely: Fizzle');
  assert.equal(likelyOutcomeLine({ ...dnr, estimatedRecoupmentPct: 5 }), 'Likely: Flop');
  // No reading, no guess.
  assert.equal(likelyOutcomeLine(dnr), null);
  assert.equal(likelyOutcomeLine(null), null);
  // Undisclosed (a closed TBD, BRO-5647 owner 2026-10-19): the line gives an indication where no source does.
  const undisclosed = { designation: 'TBD', status: 'closed' };
  assert.equal(likelyOutcomeLine({ ...undisclosed, modelDataQuality: 'low', modelRecoupmentPct: [0, 12, 30] }), 'Likely: Flop');
  assert.equal(likelyOutcomeLine({ ...undisclosed, modelRecoupmentPct: [20, 60, 90] }), 'Likely: Fizzle');
  assert.equal(likelyOutcomeLine({ ...undisclosed, modelRecoupmentPct: [70, 104, 140] }), 'Likely: Recouped');
  assert.equal(likelyOutcomeLine({ ...undisclosed, modelRecoupmentPct: [-200, -50, 10] }), 'Likely: Flop');
  assert.equal(likelyOutcomeLine({ ...undisclosed, estimatedRecoupmentPct: 0 }), 'Likely: Flop');
  assert.equal(likelyOutcomeLine(undisclosed), null);
  // Still running, or announced: no guess.
  assert.equal(likelyOutcomeLine({ designation: 'TBD', status: 'open', modelRecoupmentPct: [0, 12, 30] }), null);
  assert.equal(likelyOutcomeLine({ designation: 'TBD', modelRecoupmentPct: [0, 12, 30] }), null);
  assert.equal(likelyOutcomeLine({ ...undisclosed, recouped: true, modelRecoupmentPct: [0, 12, 30] }), null);
  // recouped:false prints "Not Recouped": no Recouped guess beside it, a loss guess still stands.
  assert.equal(likelyOutcomeLine({ ...undisclosed, recouped: false, modelRecoupmentPct: [70, 104, 140] }), null);
  assert.equal(likelyOutcomeLine({ ...undisclosed, recouped: false, modelRecoupmentPct: [0, 12, 30] }), 'Likely: Flop');
  assert.equal(likelyOutcomeLine({ designation: 'TBD', status: 'previews', modelRecoupmentPct: [0, 12, 30] }), null);
  // A Did Not Recoup show never reads Recouped, whatever the model says.
  assert.equal(likelyOutcomeLine({ ...dnr, modelRecoupmentPct: [70, 104, 140] }), 'Likely: Fizzle');
  // Only Did Not Recoup and a closed Undisclosed: a sized loss label, an open TBD or any other label gets no line.
  for (const designation of ['Fizzle', 'Flop', 'TBD', 'Windfall', 'Nonprofit']) {
    assert.equal(likelyOutcomeLine({ designation, modelReturnedExCreditPct: [0, 12, 30] }), null, designation);
  }
  assert.equal(toPublicShowCommercial({ designation: 'Did Not Recoup', likelyOutcome: 'Likely: Flop' }).likelyOutcome, 'Likely: Flop');
  // What the line rests on: a outside estimate the record carries, else our model (BRO-5647).
  assert.equal(likelyOutcomeBasis({ ...undisclosed, analystRecoupPct: [0, 0], modelRecoupmentPct: [0, 12, 30] }), 'estimate');
  assert.equal(likelyOutcomeBasis({ ...undisclosed, modelRecoupmentPct: [0, 12, 30] }), 'model');
  assert.equal(likelyOutcomeBasis(undisclosed), null);
  assert.ok(LIKELY_OUTCOME_BASIS.estimate && LIKELY_OUTCOME_NOTE.estimate && LIKELY_OUTCOME_BASIS.model && LIKELY_OUTCOME_NOTE.model);
  assert.equal(toPublicShowCommercial({ designation: 'TBD', likelyOutcome: 'Likely: Flop', likelyOutcomeBasis: 'estimate' }).likelyOutcomeBasis, 'estimate');
  assert.equal('likelyOutcome' in toPublicShowCommercial({ designation: 'Did Not Recoup' }), false);
});

test('every loss label says it can change if the show recoups later (owner 2026-10-18, BRO-5645)', () => {
  assert.match(LOSS_CAN_CHANGE_NOTE, /recoups later, from tours or licensing/);
  for (const designation of ['Fizzle', 'Did Not Recoup', 'Flop']) {
    assert.equal(lossCanChangeNote({ designation }), LOSS_CAN_CHANGE_NOTE, designation);
  }
  for (const designation of ['TBD', 'Windfall', 'Trickle', 'Nonprofit', 'Tour Stop']) {
    assert.equal(lossCanChangeNote({ designation }), null, designation);
  }
  assert.equal(lossCanChangeNote(null), null);
});

test('the caveat is shown for every loss label no source reported', () => {
  assert.equal(LOSS_ON_SILENCE_CAVEAT, 'Based on no recoupment being announced');
  assert.equal(lossBasisCaveat({ designation: 'Fizzle', designationBasis: 'no-recoupment-announced' }), LOSS_ON_SILENCE_CAVEAT);
  assert.equal(lossBasisCaveat({ designation: 'Flop', designationBasis: 'no-recoupment-announced' }), LOSS_ON_SILENCE_CAVEAT);
  assert.equal(lossBasisCaveat({ designation: 'Flop', designationBasis: 'reported-loss' }), null);
  assert.equal(lossBasisCaveat({ designation: 'Fizzle', designationBasis: 'notes-stated' }), LOSS_ON_SILENCE_CAVEAT, 'our own notes are not a reported fact');
  assert.equal(lossBasisCaveat({ designation: 'Fizzle' }), LOSS_ON_SILENCE_CAVEAT, 'no basis recorded reads as unreported');
  assert.equal(lossBasisCaveat({ designation: 'TBD', designationBasis: 'no-recoupment-announced' }), null, 'a flipped row never shows it');
  assert.equal(lossBasisCaveat(null), null);
});

test('lossOutcomePhrase: only a reported loss says "did not recoup" or "without recouping"', () => {
  const reportedFlop = { designation: 'Flop', designationBasis: 'reported-loss' };
  const reportedFizzle = { designation: 'Fizzle', designationBasis: 'reported-loss' };
  assert.equal(isReportedLoss(reportedFlop), true);
  assert.equal(isReportedLoss({ designation: 'TBD', designationBasis: 'reported-loss' }), false);
  assert.equal(lossOutcomePhrase(reportedFlop, 'cell'), 'Did not recoup');
  assert.equal(lossOutcomePhrase(reportedFlop, 'closing'), 'closed as a flop');
  assert.equal(lossOutcomePhrase(reportedFizzle, 'closing'), 'closed without recouping');
  for (const basis of ['no-recoupment-announced', 'notes-stated', undefined]) {
    for (const designation of ['Fizzle', 'Flop']) {
      const c = { designation, designationBasis: basis };
      assert.equal(lossOutcomePhrase(c, 'cell'), 'No recoupment announced', `${designation}/${basis}`);
      assert.equal(lossOutcomePhrase(c, 'closing'), 'closed with no recoupment announced', `${designation}/${basis}`);
    }
  }
  assert.equal(lossOutcomePhrase({ designation: 'TBD' }, 'closing'), 'closed');
});

test('Did Not Recoup reads like any loss label: caveat on silence, reported wording only when reported (BRO-5636)', () => {
  const silence = { designation: 'Did Not Recoup', designationBasis: 'no-recoupment-announced' };
  const reported = { designation: 'Did Not Recoup', designationBasis: 'reported-loss' };
  assert.equal(lossBasisCaveat(silence), LOSS_ON_SILENCE_CAVEAT);
  assert.equal(lossBasisCaveat(reported), null);
  assert.equal(isReportedLoss(reported), true);
  assert.equal(lossOutcomePhrase(silence, 'cell'), 'No recoupment announced');
  assert.equal(lossOutcomePhrase(silence, 'closing'), 'closed with no recoupment announced');
  // Its label already says it did not recoup; the % column says what is missing.
  assert.equal(lossOutcomePhrase(reported, 'cell'), 'Amount returned not reported');
  assert.equal(lossOutcomePhrase(reported, 'closing'), 'closed without recouping');
});

test('no page or component hardcodes a loss phrase outside lossOutcomePhrase', async () => {
  const { spawnSync } = await import('node:child_process');
  const r = spawnSync('git', ['grep', '-n', '-i', '-E', 'did not recoup|without recouping|closed as a flop|lost money|never recouped', '--', 'src/app', 'src/components'], { encoding: 'utf8' });
  // Comments may name the phrases; rendered text may not.
  const hits = r.stdout.split('\n').filter((l) => l && !/^[^:]+:\d+:\s*(\*|\/\/|\/\*)/.test(l));
  assert.deepEqual(hits, []);
});

test('our own notes stay off a loss label no source reported', () => {
  const notes = 'Closed in 2024 without recouping.';
  assert.equal(publicNotesText({ designation: 'Flop', designationBasis: 'notes-stated', notes }), null);
  assert.equal(publicNotesText({ designation: 'Fizzle', designationBasis: 'no-recoupment-announced', notes }), null);
  assert.equal(publicNotesText({ designation: 'Flop', designationBasis: 'reported-loss', notes }), notes);
  assert.equal(publicNotesText({ designation: 'TBD', notes }), notes);
  // Not just hidden on screen: the client payload never carries them.
  const base = { recouped: false, capitalization: null, capitalizationSource: null, weeklyRunningCost: null, recoupedDate: null, recoupedWeeks: null, notes };
  assert.equal(toPublicShowCommercial({ ...base, designation: 'Fizzle', designationBasis: 'notes-stated' }).notes, undefined);
  assert.equal(toPublicShowCommercial({ ...base, designation: 'Flop', designationBasis: 'reported-loss' }).notes, notes);
});

test('toPublicShowCommercial passes the basis through, and only when present', () => {
  const base = { designation: 'Fizzle', recouped: false, capitalization: null, capitalizationSource: null, weeklyRunningCost: null, recoupedDate: null, recoupedWeeks: null };
  assert.equal(toPublicShowCommercial({ ...base, designationBasis: 'no-recoupment-announced' }).designationBasis, 'no-recoupment-announced');
  assert.equal('designationBasis' in toPublicShowCommercial(base), false);
});

test('Group C: Reddit and blog characterisations never print as a source line', () => {
  for (const text of [
    "Reddit discussion mentioned show was 'hemorrhaging cash' before closing",
    'Financing Broadway blog states it closed at a loss after 33 previews',
    'Ken Davenport blog post analyzing revival recoupment rates',
    'Trade report from Financing Broadway blog',
    'reddit thread',
  ]) {
    assert.equal(publicSourceText(text), null, text);
  }
  const pub = toPublicShowCommercial({
    designation: 'Flop', recouped: false, capitalization: null, capitalizationSource: 'Financing Broadway blog listing capitalization at $14 million',
    weeklyRunningCost: null, recoupedDate: null, recoupedWeeks: null,
    recoupedSource: "Reddit discussion mentioned show was 'hemorrhaging cash'", notes: 'Per a Reddit post the show lost money.',
  });
  assert.doesNotMatch(JSON.stringify(pub), /reddit|blog/i);
  // A trade citation still prints.
  assert.equal(publicSourceText('Deadline: producers said the production will not recoup'), 'Deadline: producers said the production will not recoup');
});

test('a designation resting on our estimate says so, whatever its tier (owner 2026-10-24, BRO-6158)', () => {
  assert.match(DESIGNATION_ESTIMATE_CAVEAT, /^Our estimate, not a reported result/);
  assert.doesNotMatch(DESIGNATION_ESTIMATE_CAVEAT, /—/);
  for (const designation of ['Flop', 'Fizzle', 'Did Not Recoup', 'Trickle', 'Windfall']) {
    assert.equal(lossBasisCaveat({ designation, designationBasis: 'model-estimate' }), DESIGNATION_ESTIMATE_CAVEAT, designation);
  }
  // The estimate wording replaces both the silence caveat and the can-change note.
  assert.equal(lossCanChangeNote({ designation: 'Flop', designationBasis: 'model-estimate' }), null);
  assert.equal(lossCanChangeNote({ designation: 'Flop', designationBasis: 'no-recoupment-announced' }), LOSS_CAN_CHANGE_NOTE);
  // It is not a reported loss, and the notes stay off the page.
  assert.equal(isReportedLoss({ designation: 'Flop', designationBasis: 'model-estimate' }), false);
  assert.equal(publicNotesText({ designation: 'Trickle', designationBasis: 'model-estimate', notes: 'internal' }), null);
  assert.equal(toPublicShowCommercial({ designation: 'Windfall', designationBasis: 'model-estimate' }).designationBasis, 'model-estimate');
  assert.equal(lossBasisCaveat({ designation: 'Windfall' }), null);
});
