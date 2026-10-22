/**
 * Prompt note for review files that are one show's section of a multi-show
 * article (multi-show-review-fanout.js writes the markers). Pure function so a
 * unit test can require() the real thing (CLAUDE.md rule 15).
 *
 * BRO-6000: a section cut from a joint article can open on a sentence that
 * points back at the removed section ("I don't recommend that approach for the
 * other production"). Two of three ensemble models read such an opening as a
 * verdict on the show being scored; the majority branch then published a
 * Negative score for a review whose evaluative words were mixed. The cut text
 * keeps the dangling reference but loses its antecedent, so the scorer has to
 * be told. The note must not soften a verdict the section states outright.
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
    + '"the other production", "the first show"). Advice about ANOTHER production in such a sentence is not '
    + 'a verdict on ' + subject + ', and a back-reference whose target you cannot see is not criticism by '
    + 'itself. Score what the critic says about ' + subject + ' itself. A verdict or comparison that plainly '
    + 'judges ' + subject + ' counts in full, favorable or not.';
}

module.exports = { buildSplitExcerptNote, isSplitSection };
