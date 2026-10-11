/**
 * Owner policy B (BRO-5020, 2026-10-11) display rules. Runs in the tsx unit
 * batch: imports src TS directly (the real functions, no copies).
 *  - A Fizzle/Flop whose designationBasis is 'no-recoupment-announced' carries
 *    "Based on no recoupment being announced"; a reported loss carries nothing.
 *  - The basis reaches the browser through the toPublicShowCommercial allowlist.
 *  - Group C: no Reddit or blog characterisation prints as a source line.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

const { lossBasisCaveat, LOSS_ON_SILENCE_CAVEAT, toPublicShowCommercial, publicSourceText } =
  await import('../../src/lib/commercial-display.ts');

test('the caveat is shown only for a loss label resting on silence', () => {
  assert.equal(LOSS_ON_SILENCE_CAVEAT, 'Based on no recoupment being announced');
  assert.equal(lossBasisCaveat({ designation: 'Fizzle', designationBasis: 'no-recoupment-announced' }), LOSS_ON_SILENCE_CAVEAT);
  assert.equal(lossBasisCaveat({ designation: 'Flop', designationBasis: 'no-recoupment-announced' }), LOSS_ON_SILENCE_CAVEAT);
  assert.equal(lossBasisCaveat({ designation: 'Flop', designationBasis: 'reported-loss' }), null);
  assert.equal(lossBasisCaveat({ designation: 'Fizzle', designationBasis: 'notes-stated' }), null);
  assert.equal(lossBasisCaveat({ designation: 'Fizzle' }), null);
  assert.equal(lossBasisCaveat({ designation: 'TBD', designationBasis: 'no-recoupment-announced' }), null, 'a flipped row never shows it');
  assert.equal(lossBasisCaveat(null), null);
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
