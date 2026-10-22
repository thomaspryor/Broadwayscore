/**
 * Prompt note for review files that are one show's section of a multi-show
 * article (multi-show-review-fanout.js writes the markers). Pure function so a
 * unit test can require() the real thing (CLAUDE.md rule 15).
 *
 * BRO-6000: Helen Shaw's NYT piece covers School Pictures and Two Girls. The
 * Two Girls section is cut at the sentence that names the show, and that
 * sentence opens "Though it's similarly portable, I don't recommend that tack
 * for the other Cherry Lane production...". "That tack" is School Pictures'
 * staging, which sat in the removed section. Two of three ensemble models read
 * it as a verdict on Two Girls ("explicitly states a lack of recommendation")
 * and scored it 40 against Claude's 62 (Mixed); the majority branch published
 * 46 (Negative) for a review whose only evaluative words are "jauntily
 * unpleasant" and "strangely chilly". The cut text keeps the dangling
 * reference but loses its antecedent, so the scorer has to be told.
 */

/** A split child or the parent that kept its own section of the article. */
function isSplitSection(review) {
  return !!review && (review.multiShowSplitChild === true || review.multiShowSplitParent === true);
}

/**
 * @param {object} review review file / row (reads the multiShowSplit* markers)
 * @param {string} [showTitle] the show being scored, to name it in the note
 * @returns {string|null} the NOTE line, or null when the text is a whole review
 */
function buildSplitExcerptNote(review, showTitle) {
  if (!isSplitSection(review)) return null;
  const show = String(showTitle || (review && review.showTitle) || '').replace(/\s+/g, ' ').trim().slice(0, 120);
  const subject = show ? `"${show}"` : 'the show being scored';
  return 'NOTE: This text is only the section about ' + subject + ' from a longer article in which the critic '
    + 'reviewed several productions. The paragraphs about the other shows were removed, so the text can open '
    + 'mid-argument and point back to something that is no longer there ("that approach", "similarly", '
    + '"the other production", "the first show"). A sentence that advises about, compares with, or points back '
    + 'to ANOTHER production is not a verdict on ' + subject + ': "I don\'t recommend that tack" is a comment '
    + 'on a method the removed section described. Score only what the critic says about ' + subject
    + ' itself. Do not read the absence of a recommendation as a negative one, and do not treat an '
    + 'unexplained back-reference as criticism.';
}

module.exports = { buildSplitExcerptNote, isSplitSection };
