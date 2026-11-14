// Section-heading rule for BrowseListClient, extracted (same pattern as
// browse-sort.js) so a real unit test can call it instead of regex-matching the
// component source.
//
// BRO-712: a heading is drawn whenever a row's label differs from the previous
// row's, so headings are only truthful when every label forms ONE contiguous run
// in the order on screen. The component used to guess this from the sort state
// (`sort === 'custom' || sort === 'score'`), which got it wrong both ways:
//   - hid the headings on every page whose default order is 'closing-date',
//     'performances' or 'opening-date' (closing soon, longest running and new
//     2026 all had a sectionGroup and rendered no heading), and
//   - drew duplicated headings when a visitor clicked Critics on a page whose
//     labels follow a custom order.
// Checking the labels themselves cannot go out of date with a new sort option.
// A page whose labels interleave in its default order (upcoming-broadway-shows:
// "In Previews Now" / "Coming Soon" alternate when sorted by date) still shows no
// headings, as before, instead of repeating them.
//
// CommonJS on purpose, like browse-sort.js and sort-toggle.js: tsconfig has
// `allowJs: true`, so the .tsx component imports the named export and
// tests/unit/*.test.mjs can require this file directly.

// labels: the section label of each row, in the order the rows are displayed.
// All-or-nothing: a missing label or a label that returns after a different
// label means no headings at all (a half-headed list reads worse than none).
function sectionLabelsContiguous(labels) {
  if (!Array.isArray(labels) || labels.length === 0) return false;
  const seen = new Set();
  let prev;
  for (const label of labels) {
    if (!label) return false;
    if (label !== prev) {
      if (seen.has(label)) return false;
      seen.add(label);
      prev = label;
    }
  }
  return true;
}

module.exports = { sectionLabelsContiguous };
