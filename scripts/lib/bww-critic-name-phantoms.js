/**
 * Drop BWW-roundup "phantom outlet" records: a posting whose JSON-LD
 * author.name is a bare critic name ("Ben Ryland") and whose headline outlet
 * ("Media Mikes - Theater Review: ...") is not yet registered falls through
 * extractBWWRoundupReviews' Method 1 as outletId="ben-ryland", criticName=null.
 * Method 2/3 then writes the correctly attributed twin (media-mikes / Ben
 * Ryland), and both survive: the same review is counted twice and the
 * critic's name is auto-registered as a domainless outlet by the rebuild
 * (mrs-doubtfire-tour-2025 and water-for-elephants-tour-2025, 2026-09-29 —
 * this is what pushed outlet-registry.test.mjs's null-domain ceiling over 50
 * and turned main's Test Suite red). BRO-3247 fixed the registered-headline
 * case only.
 *
 * A record is a phantom when it has no critic (null / "Unknown") and its
 * outletId is exactly the slug of a critic name some OTHER record in the same
 * roundup carries under a different outlet. The phantom's excerpt/thumb are
 * handed to the twin when the twin lacks them, then the phantom is dropped.
 */

function slugifyName(name) {
  return String(name || '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function hasCritic(r) {
  return !!r.criticName && r.criticName !== 'Unknown';
}

/**
 * @param {object[]} reviews - records from one roundup (not mutated except for field hand-off onto twins)
 * @returns {{ kept: object[], dropped: Array<{ phantom: object, twin: object }> }}
 */
function dropCriticNamePhantoms(reviews) {
  const twinByCriticSlug = new Map();
  for (const r of reviews || []) {
    if (!hasCritic(r)) continue;
    const slug = slugifyName(r.criticName);
    if (slug && slug !== r.outletId && !twinByCriticSlug.has(slug)) twinByCriticSlug.set(slug, r);
  }
  const kept = [];
  const dropped = [];
  for (const r of reviews || []) {
    const twin = !hasCritic(r) ? twinByCriticSlug.get(r.outletId) : null;
    if (!twin) {
      kept.push(r);
      continue;
    }
    for (const f of ['bwwExcerpt', 'bwwThumb', 'url']) {
      if (!twin[f] && r[f]) twin[f] = r[f];
    }
    dropped.push({ phantom: r, twin });
  }
  return { kept, dropped };
}

module.exports = { dropCriticNamePhantoms, slugifyName };
