// Lede ⊆ body invariant (Notion 3a9637c5): the newsletter lede must never name
// a show the body doesn't actually render. Twice shipped broken: "The Fear of
// 13 plays final performance" (2026-07-12, closings window bug) and "Oh, Mary!
// recoups" in the West End edition (2026-07-26, recoupment input not
// edition-gated). Both were fixed input-by-input; this is the mechanical
// backstop so the NEXT new candidate type can't regress it silently.
//
// `ledeShows` is generate.mjs's `ledeShows` meta field: [{id, slug, title}]
// for every show the primary lede paragraph names. `bodyHtml` should be the
// full rendered email with the lede's own <div> stripped out (see
// pre-send-check.mjs) so a match can only come from a body section.
function findLedeBodyViolations(ledeShows, bodyHtml) {
  const violations = [];
  const html = bodyHtml || '';
  for (const s of ledeShows || []) {
    if (!s || (!s.slug && !s.title)) continue; // nothing identifiable to check
    const linked = !!s.slug && html.includes(`/show/${s.slug}`);
    const titled = !!s.title && html.includes(s.title);
    if (!linked && !titled) {
      violations.push(`Lede names "${s.title || s.slug || s.id}" but it doesn't appear anywhere in the body — lede ⊆ body invariant violated`);
    }
  }
  return violations;
}

module.exports = { findLedeBodyViolations };
