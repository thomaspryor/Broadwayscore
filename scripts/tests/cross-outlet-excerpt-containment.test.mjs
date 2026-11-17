// BRO-7663: an aggregator excerpt filed under the wrong outlet must pair with the
// fullText it was lifted from (trigram Jaccard alone scored it ~3%).
import { createRequire } from 'module';
import assert from 'assert/strict';
const require = createRequire(import.meta.url);
const { excerptContainment, excerptCopySide } = require('../lib/cross-outlet-group');

const filler = Array.from({ length: 400 }, (_, i) => `word${i} filler sentence about staging`).join(' ');
const quote = 'In the end what stands out most is that while the mothers quarrel over gardening approaches their sons romance is a total non-issue for everyone onstage tonight.';
const full = `${filler} ${quote} ${filler}`;

// 1. Excerpt fully inside a long review: contained, excerpt side is the copy.
assert.equal(excerptContainment(quote, full), 100);
const ex = { text: quote, textSource: 'excerpts' };
const ft = { text: full, textSource: 'fullText' };
assert.deepEqual(excerptCopySide(ex, ft), { copy: 'a', containment: 100 });
assert.deepEqual(excerptCopySide(ft, ex), { copy: 'b', containment: 100 });

// 2. Curly vs straight apostrophes still match.
assert.equal(excerptContainment('It’s probably a high compliment to say that if you liked the original form then you will like this one too', "It's probably a high compliment to say that if you liked the original form then you will like this one too. " + filler), 100);

// 2b. Accented and plain spellings match (Jenůfa / Jenufa).
assert.equal(excerptContainment('The soprano sings Jenůfa with a radiant fragility that the whole cast of this production matches', 'The soprano sings Jenufa with a radiant fragility that the whole cast of this production matches. ' + filler), 100);

// 3. An unrelated excerpt is not paired.
assert.equal(excerptCopySide({ text: 'A wholly different critic writes that the lighting design overwhelms every quiet scene in the second act tonight.', textSource: 'excerpts' }, ft), null);

// 4. Too-short excerpts are not judged; two fullTexts are left to Jaccard.
assert.equal(excerptContainment('a total non-issue', full), null);
assert.equal(excerptCopySide({ text: full, textSource: 'fullText' }, ft), null);

// 5. A quote with its own url or a named byline is not auto-paired (may be the real review).
assert.equal(excerptCopySide({ ...ex, hasUrl: true }, ft), null);
assert.equal(excerptCopySide({ ...ex, criticName: 'Soyica Diggs Colbert' }, ft), null);
assert.deepEqual(excerptCopySide({ ...ex, criticName: 'Unknown' }, ft), { copy: 'a', containment: 100 });

console.log('cross-outlet-excerpt-containment: 5 cases pass');
