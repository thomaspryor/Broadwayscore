// Check a sitemap match against the review dates before persisting it.
const { dtliSlugPredatesShow, extractDtliReviewYears, dtliShowYear } = require('./review-guards');

async function checkDtliCandidate(show, slug, fetchPage) {
  const result = await fetchPage(`https://didtheylikeit.com/shows/${slug}/`);
  if (!result.ok || typeof result.body !== 'string') {
    return { allowed: false, reason: 'could not check page dates' };
  }
  const years = extractDtliReviewYears(result.body);
  if (dtliSlugPredatesShow(years, dtliShowYear(show))) {
    return { allowed: false, reason: `review years ${years.join(', ')} predate the production` };
  }
  return { allowed: true };
}

module.exports = { checkDtliCandidate };
