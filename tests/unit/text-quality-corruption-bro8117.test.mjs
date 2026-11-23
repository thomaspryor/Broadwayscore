// BRO-8117: the photo-credit corruption pattern matched the bare substrings
// "image"/"photo"/"credit" inside ordinary prose ("imagery", "credited"), so
// a long complete review plus ONE furniture signal read as 2+ signals = 'corrupted'.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { checkCorruption, assessFullText } = require('../../scripts/lib/text-quality.js');

const PROSE = 'The production opens with a stark, beautifully lit set and the cast commits fully to every scene. The second act drags a little, but the leads are superb and the staging is inventive. Overall this is a thoroughly rewarding evening that earns its recommendation. ';

test('BRO-8117: ordinary words image/imagery/photography/credited/credit are not corruption signals', () => {
  const t = PROSE + "Mamet's piquant imagery, the photography, and the credited choreographer deserve credit.";
  assert.deepEqual(checkCorruption(t).signals, []);
});

test('BRO-8117: real photo credits still flag', () => {
  assert.equal(checkCorruption('Review text. (Photo: Jeremy Daniel)').isCorrupted, true);
  assert.equal(checkCorruption('Review text. Photo: Jeremy Daniel').isCorrupted, true);
  assert.equal(checkCorruption('Review text. Getty Images: Foo').isCorrupted, true);
});

test('BRO-8117: complete review with "imagery" + a privacy-policy line is not "corrupted"', () => {
  const t = PROSE.repeat(6) + "The imagery is striking. Privacy Policy";
  assert.notEqual(assessFullText(t, true, { trustedComplete: true }), 'corrupted');
});

test('BRO-8117: genuine multi-signal furniture still reads corrupted', () => {
  const t = PROSE.repeat(3) + ' (Photo: X) Privacy Policy Cookie Settings Follow us on Twitter';
  assert.equal(assessFullText(t, false, { trustedComplete: true }), 'corrupted');
});
