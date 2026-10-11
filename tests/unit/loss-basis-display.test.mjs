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

const { lossBasisCaveat, LOSS_ON_SILENCE_CAVEAT, toPublicShowCommercial, publicSourceText, lossOutcomePhrase, isReportedLoss, publicNotesText } =
  await import('../../src/lib/commercial-display.ts');

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
