// BRO-4280: isUkOutletUrl must not read US 'theatre'/'independent' sites as UK.
import test from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'node:module';
const { isUkOutletUrl } = createRequire(import.meta.url)('./venue-classification.js');

test('US sites with theatre/independent/standard in the hostname are not UK', () => {
  for (const u of [
    'https://mdtheatreguide.com/x', 'https://dctheatrearts.org/x', 'https://bgindependentmedia.org/x',
    'https://www.newyorktheatreguide.com/x', 'https://dctheatrescene.com/x', 
    'https://www.theatrereviews.com/x', 'https://www.newhavenindependent.org/x', 'https://recliningstandards.com/x',
    'https://www.nytheatre.com/x', 'https://www.dctheatrearts.org/x',
  ]) assert.strictEqual(isUkOutletUrl(u), false, u);
});

test('real UK outlets still read as UK', () => {
  for (const u of [
    'https://www.theguardian.com/x', 'https://www.whatsonstage.com/x', 'https://www.thetimes.com/x',
    'https://www.londontheatre1.com/x', 'https://www.britishtheatreguide.info/x', 'https://www.the-independent.com/x',
    'https://www.telegraph.co.uk/x', 'https://www.standard.co.uk/x', 'https://inews.co.uk/x',
    'https://www.thestage.co.uk/x', 'https://onin.london/x', 'https://www.ayoungertheatre.com/x', 'https://theatreweekly.com/x',
    'https://www.adventuresintheatreland.com/x', 'https://theatrecat.com/x', 'https://www.theguardian.com/x',
  ]) assert.strictEqual(isUkOutletUrl(u), true, u);
});

test('theatrely and empty input stay false', () => {
  assert.strictEqual(isUkOutletUrl('https://www.theatrely.com/x'), false);
  assert.strictEqual(isUkOutletUrl(''), false);
  assert.strictEqual(isUkOutletUrl('not a url'), false);
});
