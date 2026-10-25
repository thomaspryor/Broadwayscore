// Pull-quote contiguity (2026-10-19): displayed quotes must be a passage the
// critic actually wrote. Covers the four Other Desert Cities shapes with
// synthetic fullText: a dropped mid-sentence clause (NY Post), a trailing
// dash qualifier lost to an invented period (Guardian), and multi-sentence
// passages hard-cut with "..." (People / Culture Sauce).
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  isContiguousInSource, pickExcerptCandidate, snapToSourceSpan, isTrustedContiguitySource,
  startsWithPageChrome, phraseContradictsScore, stripLeadingCredits,
} = require('./pull-quote-guards.js');
const {
  trimToCompleteSentence, cleanExcerpt, truncateAtSentenceBoundary, isOverlongExcerpt, hardCutExcerpt,
} = require('./rebuild-helpers.js');
const { selectBestExcerpt } = require('../rebuild-all-reviews.js');

const PAD = ' The set is a handsome, sun-bleached Palm Springs living room. The lighting does quiet, careful work across both acts. '.repeat(3);

const POST_TEXT = `Family dramas thrive on friction.${PAD}But the likeable enough Broadway revival of Jon Robin Baitz’s sharp-tongued drama, which opened Sunday night at the Hudson Theatre, takes these people’s competing personalities way too far. The second act is better.${PAD}`;
const POST_SPLICED = 'But the likeable enough Broadway revival of Jon Robin Baitz’s sharp-tongued drama takes these people’s competing personalities way too far.';
const POST_REAL = 'But the likeable enough Broadway revival of Jon Robin Baitz’s sharp-tongued drama, which opened Sunday night at the Hudson Theatre, takes these people’s competing personalities way too far.';

const GUARDIAN_TEXT = `Baitz has written many family plays.${PAD}A decade and a half after its premiere, this revival makes a strong case for its ranking among the better of those, and a definitive one for its dissection of American rot – perhaps too eerily. Janney is superb.${PAD}`;
const GUARDIAN_FULL = 'A decade and a half after its premiere, this revival makes a strong case for its ranking among the better of those, and a definitive one for its dissection of American rot – perhaps too eerily.';
const GUARDIAN_CUT = 'A decade and a half after its premiere, this revival makes a strong case for its ranking among the better of those, and a definitive one for its dissection of American rot.';

const PEOPLE_PASSAGE = 'Under John Benjamin Hickey’s deft direction, a stellar five-person ensemble brings humor, humanity and devastating emotional depth to a crackling revival that feels strikingly relevant in 2026. Louis-Dreyfus is a revelation as the brittle matriarch, all clipped vowels and steel. Janney steals every scene she is in as the boozy, wisecracking aunt who sees through everyone and says so loudly and often.';

const SAUCE_TEXT = `It is Christmas in Palm Springs.${PAD}Despite all the squabbling and acting out, family values still hold sway. The cast is uniformly fine. In the end the Wyeths stay together, and that is the point.${PAD}`;

describe('isContiguousInSource', () => {
  it('NY Post: a quote that drops a mid-sentence clause is not contiguous', () => {
    assert.equal(isContiguousInSource(POST_SPLICED, POST_TEXT), false);
    assert.equal(isContiguousInSource(POST_REAL, POST_TEXT), true);
  });

  it('Guardian: an invented period that drops a dash qualifier is not contiguous', () => {
    assert.equal(isContiguousInSource(GUARDIAN_CUT, GUARDIAN_TEXT), false);
    assert.equal(isContiguousInSource(GUARDIAN_FULL, GUARDIAN_TEXT), true);
    // dash glyph, curly quotes, case and wrapping quotes are normalized
    assert.equal(isContiguousInSource(`"${GUARDIAN_FULL.replace('–', '-').toUpperCase()}"`, GUARDIAN_TEXT), true);
  });

  it('accepts a terminal period only where the source also ends a sentence', () => {
    assert.equal(isContiguousInSource('Despite all the squabbling and acting out, family values still hold sway.', SAUCE_TEXT), true);
    assert.equal(isContiguousInSource('Despite all the squabbling and acting out.', SAUCE_TEXT), false);
    // a scrape that lost the period at a paragraph break
    const lostBreak = `${PAD}It is the kind of show worth coming back to again and again\n\nGrindr Mom plays at Waterloo East.`;
    assert.equal(isContiguousInSource('It is the kind of show worth coming back to again and again.', lostBreak), true);
    // a capitalised next word alone is NOT a sentence end ("starring Audra." vs "Audra McDonald")
    const starring = `${PAD}The revival, starring Audra McDonald as Rose, is a thunderclap.`;
    assert.equal(isContiguousInSource('The revival, starring Audra.', starring), false);
    // ...and a continuing lowercase clause is still a cut
    assert.equal(isContiguousInSource('It is the kind of show worth coming back to.', lostBreak), false);
  });

  it('Culture Sauce: an honest in-order elision is contiguous, an out-of-order splice is not', () => {
    assert.equal(isContiguousInSource('Despite all the squabbling ... family values still hold sway.', SAUCE_TEXT), true);
    assert.equal(isContiguousInSource('Despite all the squabbling and acting out, family values still hold sway. The cast is…', SAUCE_TEXT), true);
    assert.equal(isContiguousInSource('The cast is uniformly fine… Despite all the squabbling and acting out', SAUCE_TEXT), false);
  });

  it('has nothing to check without a source', () => {
    assert.equal(isContiguousInSource(POST_SPLICED, ''), true);
    assert.equal(isContiguousInSource('', POST_TEXT), true);
  });
});

describe('trimToCompleteSentence keeps a trailing dash qualifier', () => {
  it('Guardian: "... American rot – perhaps too eerily." survives', () => {
    assert.equal(trimToCompleteSentence(GUARDIAN_FULL), GUARDIAN_FULL);
    const twoSentences = 'This revival is a sharp, unsparing piece of work. A dissection of American rot. – perhaps too eerily';
    assert.equal(trimToCompleteSentence(twoSentences), twoSentences);
  });

  it('does not cut at an apostrophe or an abbreviation', () => {
    const t = 'The cast is superb throughout the evening and beyond. It plays the U.K. and L.A. productions';
    assert.equal(trimToCompleteSentence(t), 'The cast is superb throughout the evening and beyond.');
    const a = 'A revival that understands Baitz’s characters better than any production before it has';
    assert.equal(trimToCompleteSentence(a), a);
  });
});

describe('cleanExcerpt truncation (People / Culture Sauce "..." hard cut)', () => {
  it('cuts a long passage at the last sentence end, never appending "..."', () => {
    assert.ok(PEOPLE_PASSAGE.length > 350);
    const out = cleanExcerpt(PEOPLE_PASSAGE);
    assert.ok(!out.endsWith('...'), out);
    assert.ok(out.endsWith('steel.'), out);
    assert.equal(truncateAtSentenceBoundary(PEOPLE_PASSAGE), out);
  });

  it('leaves a passage with no sentence end uncut and flags it overlong', () => {
    const run = 'Under the deft direction a stellar ensemble brings humor and humanity and devastating emotional depth to a crackling revival that feels strikingly relevant and also '.repeat(3).trim();
    const out = cleanExcerpt(run);
    assert.equal(out, run);
    assert.equal(isOverlongExcerpt(out), true);
    const cut = hardCutExcerpt(out);
    assert.ok(cut.length <= 350 && cut.endsWith('...'), cut);
  });
});

describe('pickExcerptCandidate: non-contiguous / overlong deferrals are last resorts', () => {
  it('overlong / sentiment / chrome deferrals never outrank an accepted raw-body sentence', () => {
    assert.equal(pickExcerptCandidate({
      accepted: { rank: 11, excerpt: 'body' },
      deferred: [{ rank: 1, excerpt: 'long...', reason: 'overlong' }, { rank: 1, excerpt: 'neg', reason: 'sentiment-mismatch' }],
    }), 'body');
  });

  it('an unsnappable non-contiguous verdict beats a raw-body slice, but loses to a hedge deferral', () => {
    assert.equal(pickExcerptCandidate({
      accepted: { rank: 11, excerpt: 'plot summary' },
      deferred: [{ rank: 0, excerpt: 'paraphrased verdict', reason: 'non-contiguous' }],
    }), 'paraphrased verdict');
    assert.equal(pickExcerptCandidate({
      accepted: { rank: 11, excerpt: 'plot summary' },
      deferred: [{ rank: 0, excerpt: 'paraphrased verdict', reason: 'non-contiguous' }, { rank: 3, excerpt: 'hedge', reason: 'hedge' }],
    }), 'hedge');
  });

  it('a prefix closed with an invented period snaps to the real prefix + "..." when the sentence runs long', () => {
    const long = `${PAD}This revival pulsates with energy, snaps with attitude and enlivens history, which takes place mostly in the chamber of the Continental Congress in Philadelphia as these colonial delegates argue about breaking ties with England.${PAD}`;
    assert.equal(snapToSourceSpan('This revival pulsates with energy, snaps with attitude and enlivens history.', long),
      'This revival pulsates with energy, snaps with attitude and enlivens history...');
  });

  it('never splits a source sentence at an initial ("Christopher J. Hanke")', () => {
    const t = `${PAD}The cast is led by Christopher J. Hanke, who is a delight from start to finish here.${PAD}`;
    assert.equal(snapToSourceSpan('The cast is led by Christopher Hanke, who is a delight.', t),
      'The cast is led by Christopher J. Hanke, who is a delight from start to finish here.');
  });

  it('rank after hedge/fragment deferrals when nothing was accepted, but still fill the slot', () => {
    assert.equal(pickExcerptCandidate({
      deferred: [{ rank: 0, excerpt: 'spliced', reason: 'non-contiguous' }, { rank: 5, excerpt: 'hedge', reason: 'hedge' }],
    }), 'hedge');
    assert.equal(pickExcerptCandidate({
      deferred: [{ rank: 0, excerpt: 'spliced', reason: 'non-contiguous' }, { rank: 5, excerpt: 'long...', reason: 'overlong' }],
    }), 'long...');
    assert.equal(pickExcerptCandidate({ deferred: [{ rank: 0, excerpt: 'spliced', reason: 'non-contiguous' }] }), 'spliced');
  });
});

describe('snapToSourceSpan', () => {
  it('returns the exact source sentence for a dropped-clause quote', () => {
    assert.equal(snapToSourceSpan(POST_SPLICED, POST_TEXT), POST_REAL);
  });
  it('restores a trailing dash qualifier lost to an invented period', () => {
    assert.equal(snapToSourceSpan(GUARDIAN_CUT, GUARDIAN_TEXT), GUARDIAN_FULL);
  });
  it('declines when the quote spans more than two sentences or is not in the text', () => {
    assert.equal(snapToSourceSpan('Family dramas thrive on friction ... the second act is better.', POST_TEXT), null);
    assert.equal(snapToSourceSpan('An entirely invented sentence that no critic ever wrote.', POST_TEXT), null);
  });
});

describe('isTrustedContiguitySource / startsWithPageChrome / phraseContradictsScore', () => {
  it('distrusts flagged or truncated bodies', () => {
    const ok = { fullText: POST_TEXT, textStatus: 'complete' };
    assert.equal(isTrustedContiguitySource(ok), true);
    for (const f of ['wrongShow', 'wrongProduction', 'wrongFullText', 'isRoundupArticle']) {
      assert.equal(isTrustedContiguitySource({ ...ok, [f]: true }), false, f);
    }
    assert.equal(isTrustedContiguitySource({ ...ok, contentTier: 'invalid' }), false);
    assert.equal(isTrustedContiguitySource({ ...ok, textStatus: 'truncated' }), false);
    assert.equal(isTrustedContiguitySource({ ...ok, wrongShowAutoRecovered: 'rebuild: heuristic' }), false);
    assert.equal(isTrustedContiguitySource({ ...ok, wrongShowAutoRecovered: 'x', contentVerification: { wrongArticle: false } }), true);
  });
  it('detects share-toolbar chrome but not prose that starts with "By"', () => {
    assert.equal(startsWithPageChrome('Gift this articleShare Any honest musician'), true);
    assert.equal(startsWithPageChrome('By the end of the night the audience was on its feet.'), false);
  });
  it('flags sentiment that contradicts the score', () => {
    assert.equal(phraseContradictsScore('negative', 78), true);
    assert.equal(phraseContradictsScore('positive', 35), true);
    assert.equal(phraseContradictsScore('negative', 55), false);
    assert.equal(phraseContradictsScore('negative', null), false);
  });
});

describe('selectBestExcerpt (real cascade)', () => {
  const base = { showId: 'contiguity-test-show', textStatus: 'complete' };

  it('NY Post: a spliced llmPullQuote snaps to the real source sentence', () => {
    const q = selectBestExcerpt({ ...base, fullText: POST_TEXT, llmPullQuote: POST_SPLICED, llmScore: { score: 50 } }, 'Other Desert Cities');
    assert.equal(q, POST_REAL);
  });

  it('Guardian: a quote closed with an invented period snaps to the full sentence', () => {
    const q = selectBestExcerpt({ ...base, fullText: GUARDIAN_TEXT, llmPullQuote: GUARDIAN_CUT, llmScore: { score: 85 } }, 'Other Desert Cities');
    assert.equal(q, GUARDIAN_FULL);
  });

  it('never falls back to a keyPhrase whose sentiment contradicts the score', () => {
    const q = selectBestExcerpt({
      ...base, fullText: SAUCE_TEXT, llmScore: { score: 78, keyPhrases: [
        { quote: 'The cast is uniformly fine, but the play spins its wheels for a bit.', sentiment: 'negative' },
      ] },
      bwwExcerpt: 'Despite all the squabbling and acting out, family values still hold sway.',
    }, 'Other Desert Cities');
    assert.equal(q, 'Despite all the squabbling and acting out, family values still hold sway.');
  });

  it('a contradicting keyPhrase still ships when it is the only candidate', () => {
    const only = 'Adrien Brody, giving a polished and engaging performance as Yarris.';
    const q = selectBestExcerpt({ ...base, llmScore: { score: 35, keyPhrases: [{ quote: only, sentiment: 'positive' }] } }, 'The Fear of 13');
    assert.equal(q, only);
  });

  it('skips the contiguity check against a body flagged as another article', () => {
    const q = selectBestExcerpt({ ...base, fullText: POST_TEXT, wrongShow: true, llmPullQuote: GUARDIAN_FULL, llmScore: { score: 85 } }, 'Other Desert Cities');
    assert.equal(q, GUARDIAN_FULL);
  });

  it('rejects raw body text that opens with page chrome', () => {
    const chromeText = `Gift this articleShare Any honest musician will tell you the show is loud. ${PAD}`;
    const q = selectBestExcerpt({ ...base, fullText: chromeText, bwwExcerpt: 'Despite all the squabbling and acting out, family values still hold sway.' }, 'Other Desert Cities');
    assert.ok(!q || !/^Gift this article/i.test(q), q);
  });

  it('a spliced quote still ships when it is the only candidate (never quote-less)', () => {
    const q = selectBestExcerpt({ ...base, fullText: POST_TEXT.slice(0, 600), textStatus: 'truncated', llmPullQuote: POST_SPLICED }, 'Other Desert Cities');
    assert.equal(q, POST_SPLICED);
    const q2 = selectBestExcerpt({ ...base, fullText: 'x'.repeat(10), llmPullQuote: POST_SPLICED }, 'Other Desert Cities');
    assert.equal(q2, POST_SPLICED);
  });

  it('People: a long aggregator passage ships cut at a sentence end, not with "..."', () => {
    const q = selectBestExcerpt({ ...base, bwwExcerpt: PEOPLE_PASSAGE }, 'Other Desert Cities');
    assert.ok(q && !q.endsWith('...') && q.endsWith('steel.'), q);
  });

  it('manual pullQuote stays exempt from the contiguity check', () => {
    const q = selectBestExcerpt({ ...base, fullText: POST_TEXT, pullQuote: POST_SPLICED }, 'Other Desert Cities');
    assert.equal(q, POST_SPLICED);
  });
});

describe('leading credits header (BRO-5718, Talkin\' Broadway)', () => {
  const base2 = { showId: 'contiguity-test-show', textStatus: 'complete' };
  const PROSE = 'Other Desert Cities is a sharp, funny family drama that finds fresh bite in its Broadway revival. The performances are superb and the staging is crisp enough to hide the machinery for most of the night.';
  const HEADER = 'Theatre Review by Howard Miller - October 18, 2026. Other Desert Cities by Jon Robin Baitz. Directed by Scott Ellis. Scenic design by Beowulf Boritt. Costume design by Jane Greenwood. Lighting design by Ken Posner. ';

  it('stripLeadingCredits starts the slice at the first prose sentence', () => {
    const out = stripLeadingCredits(HEADER + PROSE, { showTitle: 'Other Desert Cities' });
    assert.ok(out.startsWith('Other Desert Cities is a sharp'), out.slice(0, 60));
  });

  it('handles abbreviated months and initials in the byline', () => {
    const out = stripLeadingCredits('Theater Review by J. R. Smith - Oct. 3, 2026. Directed by Jo Q. Public. ' + PROSE);
    assert.ok(out.startsWith('Other Desert Cities is a sharp'), out.slice(0, 60));
  });

  it('never touches prose that opens with "Directed by"', () => {
    const prose = 'Directed by Sam Mendes, this revival soars with a confidence the script rarely earns. ' + PROSE;
    assert.equal(stripLeadingCredits(prose), prose);
  });

  it('leaves text alone when stripping would leave a husk', () => {
    const short = 'Theatre Review by Howard Miller - October 18, 2026. Directed by Scott Ellis. Great.';
    assert.equal(stripLeadingCredits(short), short);
  });

  it('startsWithPageChrome flags the header but not "Theatre review of..." prose', () => {
    assert.ok(startsWithPageChrome(HEADER + PROSE));
    assert.ok(!startsWithPageChrome('Theatre review of the week is grim reading for Broadway.'));
  });

  it('strips newline-separated credits and keeps "Cast: <prose>" intact', () => {
    const nl = 'Theatre Review by Howard Miller - October 18, 2026\nOther Desert Cities by Jon Robin Baitz\nDirected by Scott Ellis\nScenic design by Beowulf Boritt\n' + PROSE;
    assert.ok(stripLeadingCredits(nl, { showTitle: 'Other Desert Cities' }).startsWith('Other Desert Cities is a sharp'));
    const cast = 'Cast: a terrific ensemble led by Audra McDonald makes this sing. ' + PROSE;
    assert.equal(stripLeadingCredits(cast), cast);
    assert.ok(!startsWithPageChrome(cast));
    assert.ok(!startsWithPageChrome('Where: it all goes wrong is the second act. ' + PROSE));
  });

  it('a lowercase "theater review by a critic" sentence is prose, not a header', () => {
    const prose = 'Theater review by a critic who loved it is rare these days, but here we are. ' + PROSE;
    assert.equal(stripLeadingCredits(prose), prose);
    assert.ok(!startsWithPageChrome(prose));
  });

  it('selectBestExcerpt raw fallback never shows the credits block', () => {
    const q = selectBestExcerpt({ ...base2, fullText: HEADER + PROSE + PAD }, 'Other Desert Cities');
    assert.ok(q && !/Theat(?:re|er) Review by|Scenic design by|Directed by/i.test(q), q);
    assert.ok(q.startsWith('Other Desert Cities is a sharp'), q);
  });
});
