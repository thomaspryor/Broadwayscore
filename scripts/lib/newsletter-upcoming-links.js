/**
 * "Coming Up" see-all links for the weekly newsletter: one browse page per
 * market actually in the slate.
 *
 * Bug this replaces (owner review, 2026-11-02): the link logic only asked
 * "any Broadway show?", so every non-Broadway slate fell through to the
 * off-Broadway page, including the West End edition's all-London slate.
 * Every category the slate can contain must map to its own page here;
 * newsletter-upcoming-links.test.mjs checks each slug exists in
 * src/config/browse-pages.ts.
 */
const UPCOMING_PAGES = {
  broadway: { slug: 'upcoming-broadway-shows', label: 'Broadway' },
  'off-broadway': { slug: 'upcoming-off-broadway-shows', label: 'Off-Broadway' },
  'west-end': { slug: 'upcoming-west-end-shows', label: 'West End' },
  'off-west-end': { slug: 'upcoming-off-west-end-shows', label: 'Off West End' },
};
const ORDER = ['broadway', 'west-end', 'off-broadway', 'off-west-end'];

/**
 * @param {string[]} categories categories of the shows in the slate
 * @returns {Array<{href: string, label: string}>} [] when no category has a page
 */
function upcomingLinks(categories, site) {
  const present = ORDER.filter(c => categories.includes(c));
  return present.map(c => ({ href: `${site}/browse/${UPCOMING_PAGES[c].slug}`, label: UPCOMING_PAGES[c].label }));
}

module.exports = { UPCOMING_PAGES, upcomingLinks };
