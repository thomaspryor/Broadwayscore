import test from 'node:test';
import assert from 'node:assert';
import contentVerifier from '../../scripts/lib/content-verifier.js';

const { shouldDeferCvWrongShow } = contentVerifier;

// 700+ word opinion-rich text for long-biographical outlet tests
const LONG_OPINION_TEXT = `
Elysa Gardner has spent decades immersed in the world of theater criticism, and her
perspective on this production is both deeply personal and richly contextual. Born into
a family of artists, she brings a biographical lens to every show she reviews, often
weaving in the history of the form, the careers of the artists involved, and the cultural
moment in which the work appears. It is a style that some find indulgent, but which
others, including this critic, find illuminating in its scope and depth.

The production under consideration here is one that demands exactly this kind of
contextual treatment. The direction is stunning, a word one does not deploy lightly,
but which seems unavoidable given the sheer confidence of the choices on display.
The choreography succeeds where so many contemporary productions falter, finding
physical language for emotional states that words alone cannot capture. The ensemble
shines throughout, with several standout performances that elevate already strong
material to something approaching the transcendent.

What we are witnessing, in other words, is a production that triumphs not merely on
its own terms but against the weight of a tradition that might easily have crushed it.
The book is clever without being merely clever, the score soars in exactly the moments
one might expect it to soar, and yet still manages to surprise. The design is, in the
best possible sense, invisible: it serves the story so completely that one notices it
only in retrospect, once the house lights come up and the spell begins to lift.

Gardner herself would be the first to note that she brings biases to every production
she reviews. She has written movingly about how her background shapes her response to
material that touches on identity, community, and the ways in which stories are passed
down across generations. This production touches on all of these themes, and one can
feel in the writing the weight of that personal investment pressing against the demands
of critical objectivity. The result is writing that is, at its best, genuinely moving.

The leading performance is extraordinary. There is no other word for it. One watches
and wonders how a single human body can contain so much feeling, so much precision, so
much sheer technical mastery, while also appearing completely spontaneous and unguarded.
It is the kind of performance that critics describe as a career best, though in this
case, that phrase seems somehow inadequate to the scale of the achievement. This is not
merely the best work this performer has done. It may be among the finest pieces of
musical theater acting the city has seen in years.

The supporting cast is equally strong, with several performances that would be showstopping
in lesser company. The director has created an ensemble in the truest sense, a group of
artists who seem genuinely to be listening to one another, supporting one another,
building something together rather than competing for individual moments of glory. It is,
in the end, what makes this production more than the sum of its parts.

Unfortunately, not everything lands with equal force. There are moments in the second act
where the pacing falters, where the momentum that has been so carefully built begins to
dissipate. The direction stumbles slightly in these passages, and one wishes that the
same confidence evident elsewhere had been applied here as well. But these are minor
complaints against the backdrop of an evening that is, taken as a whole, remarkably and
movingly successful in its ambitions. Highly recommended.

To understand why this production works so well, it helps to consider the lineage it
inhabits. The form it draws from has a long and complicated history in American theater,
one that stretches back through decades of creative experimentation and commercial
pressures, of bold visions realized and promising projects abandoned halfway through
their development. It is a history that Gardner knows intimately, having covered Broadway
for long enough to remember productions that many younger critics know only from cast
recordings and archival photographs.

She brings that historical consciousness to her assessment of this work, noting the ways
in which it both honors and departs from its predecessors. The book, she argues, owes a
clear debt to a particular tradition of musical storytelling that emerged in the mid-twentieth
century, while the score introduces harmonic and rhythmic innovations that feel genuinely
contemporary. The result is a production that feels at once timeless and urgently of the
present moment, rooted in tradition without being captive to it. That is a difficult
balance to strike, and this creative team strikes it impressively and with evident care.
`.trim();

// 700+ word neutral text with no opinion tokens
const LONG_NEUTRAL_TEXT = (
  'the show begins on stage with actors and lights and sound. ' +
  'the curtain rises and the performers walk on. ' +
  'the audience is seated in rows. ' +
  'the set has furniture and walls and a door. ' +
  'the costumes are various colors and styles. '
).repeat(25);

test('long-biographical outlet + opinion + >500 words → DEFER', () => {
  assert.strictEqual(
    shouldDeferCvWrongShow({ outletId: 'new-york-sun', fullText: LONG_OPINION_TEXT }),
    true,
  );
});

test('standard outlet (variety) → no defer', () => {
  assert.strictEqual(
    shouldDeferCvWrongShow({ outletId: 'variety', fullText: LONG_OPINION_TEXT }),
    false,
  );
});

test('long-biographical outlet but short (≤500 words) → no defer', () => {
  const text = 'Short review of just a few words. brilliant performance throughout.';
  assert.strictEqual(
    shouldDeferCvWrongShow({ outletId: 'new-york-sun', fullText: text }),
    false,
  );
});

test('long-biographical + 500 words exactly → no defer (exclusive boundary)', () => {
  // "the show is brilliant unfortunately here " = 6 words × 83 reps = 498 words (≤500) → must NOT defer
  const text = 'the show is brilliant unfortunately here '.repeat(83).trim();
  assert.strictEqual(
    shouldDeferCvWrongShow({ outletId: 'new-york-sun', fullText: text }),
    false,
  );
});

test('long-biographical + 550 words (bughouse-class) + opinion → defer (true)', () => {
  // "the show is brilliant unfortunately here " = 6 words × 90 reps = 540 words (>500)
  // hits 2 opinion markers: "brilliant" (group 1) + "unfortunately" (group 4)
  const text = 'the show is brilliant unfortunately here '.repeat(90).trim();
  assert.strictEqual(
    shouldDeferCvWrongShow({ outletId: 'new-york-sun', fullText: text }),
    true,
  );
});

test('long-biographical + long but no opinion language → no defer', () => {
  assert.strictEqual(
    shouldDeferCvWrongShow({ outletId: 'new-york-sun', fullText: LONG_NEUTRAL_TEXT }),
    false,
  );
});

test('alias resolves: nysun behaves identically to new-york-sun', () => {
  assert.strictEqual(
    shouldDeferCvWrongShow({ outletId: 'nysun', fullText: LONG_OPINION_TEXT }),
    shouldDeferCvWrongShow({ outletId: 'new-york-sun', fullText: LONG_OPINION_TEXT }),
  );
});

test('missing outletId or fullText → no defer (safe default)', () => {
  assert.strictEqual(shouldDeferCvWrongShow({}), false);
  assert.strictEqual(shouldDeferCvWrongShow({ outletId: 'new-york-sun' }), false);
  assert.strictEqual(shouldDeferCvWrongShow({ fullText: 'whatever' }), false);
});
