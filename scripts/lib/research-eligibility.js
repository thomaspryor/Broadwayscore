/**
 * Eligibility predicates for deep-research-commercial selection.
 *
 * Extracted so they can be unit-tested without invoking the OpenAI-driven
 * main() of deep-research-commercial.js.
 */

const MAX_RESEARCH_ATTEMPTS = 3;

// Designations that intentionally lack capitalization/weekly-running-cost
// figures — re-researching them is wasted spend.
const NON_COMMERCIAL_DESIGNATIONS = new Set(['Nonprofit', 'Tour Stop']);

function hasMissingEssentialFields(entry) {
  if (!entry) return false;
  if (NON_COMMERCIAL_DESIGNATIONS.has(entry.designation)) return false;
  const hasCap = typeof entry.capitalization === 'number' && entry.capitalization > 0;
  const hasWeekly = typeof entry.weeklyRunningCost === 'number' && entry.weeklyRunningCost > 0;
  return !hasCap || !hasWeekly;
}

function isSixMonthEligible(entry, { now = new Date(), maxAttempts = MAX_RESEARCH_ATTEMPTS } = {}) {
  if (!entry || !entry.lastResearchedAt) return false;
  if ((entry.researchAttempts || 0) >= maxAttempts) return false;
  // TBD shows are always eligible after 6 months; classified shows are only
  // eligible if essential financial fields are still missing.
  if (entry.designation && entry.designation !== 'TBD') {
    if (!hasMissingEssentialFields(entry)) return false;
  }
  const lastResearched = new Date(entry.lastResearchedAt);
  const sixMonthsAgo = new Date(now);
  sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 6);
  return lastResearched < sixMonthsAgo;
}

module.exports = {
  MAX_RESEARCH_ATTEMPTS,
  hasMissingEssentialFields,
  isSixMonthEligible,
};
