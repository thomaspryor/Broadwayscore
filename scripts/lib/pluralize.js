// pluralize(n, singular[, plural]) -> "3 weeks", "1 week"
// Shared count-label formatter for user-facing copy (newsletter, emails).
// Born from the "RECOUPED IN 1 WEEKS" newsletter bug (2026-07-26): five call
// sites hand-rolled the same singular/plural ternary and one shipped without it.
function pluralize(n, singular, plural) {
  return `${n} ${n === 1 ? singular : (plural || singular + 's')}`;
}

// pluralNoun: just the noun part, for templates that render the count
// separately (e.g. `${delta} audience ${pluralNoun(delta, 'review')}`).
function pluralNoun(n, singular, plural) {
  return n === 1 ? singular : (plural || singular + 's');
}

module.exports = { pluralize, pluralNoun };
