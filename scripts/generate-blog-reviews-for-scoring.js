#!/usr/bin/env node
/**
 * Generate blog-reviews-for-scoring.json from content/reviews/*.md
 *
 * Includes reviews that resolve to a show in shows.json, either via an
 * explicit `showSlug` (preferred, unambiguous) or by matching the `show:`
 * title field authors actually write (see resolveShowId below — every real
 * post uses `show:`, not `showSlug`, task #1908).
 * Output format matches RawReview interface so data-core.ts can inject
 * blog reviews as Tier 3 critic reviews into the scoring engine.
 *
 * Run as part of prebuild.
 */

const fs = require('fs');
const path = require('path');
const matter = require('gray-matter');
const { normalizeTitle } = require('./lib/title-match');
const { venuesMatch } = require('./lib/deduplication');

const REVIEWS_DIR = path.join(__dirname, '../content/reviews');
const SHOWS_PATH = path.join(__dirname, '../data/shows.json');
const OUTPUT_PATH = path.join(__dirname, '../data/blog-reviews-for-scoring.json');

/**
 * Resolve a post's frontmatter to a shows.json id.
 * Priority: explicit showSlug > title match, disambiguated by venue, then
 * by dateAttended falling inside the run's [openingDate, closingDate].
 * Same-title shows (revivals, transfers) are common enough (Cats, Spelling
 * Bee below) that title alone isn't sufficient.
 */
function resolveShowId(data, file, slugToId, showsByNormTitle) {
  if (data.showSlug) {
    const showId = slugToId.get(data.showSlug);
    if (!showId) {
      console.warn(`[blog-scoring] Skipping ${file}: showSlug "${data.showSlug}" not found in shows.json`);
      return null;
    }
    return showId;
  }

  if (!data.show) {
    console.warn(`[blog-scoring] Skipping ${file}: no showSlug or show field`);
    return null;
  }

  let candidates = showsByNormTitle.get(normalizeTitle(data.show)) || [];
  if (candidates.length === 0) {
    console.warn(`[blog-scoring] Skipping ${file}: show "${data.show}" not found in shows.json`);
    return null;
  }

  if (candidates.length > 1 && data.venue) {
    // venuesMatch(), not a raw canonicalVenue() equality check — the latter
    // falls back to the lowercased first word for any venue outside the
    // curated alias table, so two unrelated theatres sharing a first word
    // (e.g. "The Duke on 42nd Street" / "The Public Theater") would
    // otherwise collapse to the same key for this automated decision.
    const byVenue = candidates.filter(sh => venuesMatch(data.venue, sh.venue));
    if (byVenue.length > 0) candidates = byVenue;
  }

  if (candidates.length > 1) {
    // Coerce to an ISO "YYYY-MM-DD" string: an unquoted YAML date (e.g.
    // 2026-03-21 with no quotes) is parsed by gray-matter/js-yaml into a
    // Date object, which would otherwise compare incorrectly (or throw)
    // against shows.json's ISO date strings below.
    const rawAttended = data.dateAttended || data.publishDate;
    const attended = rawAttended instanceof Date
      ? rawAttended.toISOString().slice(0, 10)
      : String(rawAttended || '');
    if (attended) {
      // Lower bound uses previewsStartDate (not openingDate) so a review
      // written during previews — the norm for this author, see Cats above —
      // isn't wrongly excluded from its own run's window.
      const byDate = candidates.filter(sh => {
        const start = sh.previewsStartDate || sh.openingDate;
        if (!start) return false;
        if (attended < start) return false;
        return !sh.closingDate || attended <= sh.closingDate;
      });
      if (byDate.length > 0) candidates = byDate;
    }
  }

  if (candidates.length !== 1) {
    console.warn(`[blog-scoring] Skipping ${file}: show "${data.show}" is ambiguous (${candidates.length} matches after venue/date disambiguation) — add showSlug to resolve`);
    return null;
  }

  return candidates[0].id;
}

function main() {
  // Load shows for slug→id and title→shows mapping
  const showsData = JSON.parse(fs.readFileSync(SHOWS_PATH, 'utf8'));
  const slugToId = new Map();
  const showsByNormTitle = new Map();
  for (const show of showsData.shows) {
    slugToId.set(show.slug, show.id);
    const norm = normalizeTitle(show.title);
    if (!showsByNormTitle.has(norm)) showsByNormTitle.set(norm, []);
    showsByNormTitle.get(norm).push(show);
  }

  if (!fs.existsSync(REVIEWS_DIR)) {
    fs.writeFileSync(OUTPUT_PATH, JSON.stringify({ reviews: [] }, null, 2));
    console.log('[blog-scoring] No reviews directory, wrote empty file');
    return;
  }

  const files = fs.readdirSync(REVIEWS_DIR).filter(
    f => f.endsWith('.md') && !f.startsWith('_')
  );

  const reviews = [];

  for (const file of files) {
    try {
      const raw = fs.readFileSync(path.join(REVIEWS_DIR, file), 'utf8');
      const { data } = matter(raw);

      const showId = resolveShowId(data, file, slugToId, showsByNormTitle);
      if (!showId) continue;

      const score = Number(data.score);
      if (isNaN(score) || score < 0 || score > 100) {
        console.warn(`[blog-scoring] Skipping ${file}: invalid score ${data.score}`);
        continue;
      }

      reviews.push({
        showId,
        outlet: 'Broadway Scorecard',
        outletId: 'broadway-scorecard',
        criticName: 'Tom Pryor',
        url: `https://broadwayscorecard.com/reviews/${file.replace(/\.md$/, '')}`,
        publishDate: data.publishDate || data.dateAttended || '',
        assignedScore: score,
      });
    } catch (err) {
      console.warn(`[blog-scoring] Skipping ${file}: ${err.message}`);
    }
  }

  fs.writeFileSync(OUTPUT_PATH, JSON.stringify({ reviews }, null, 2));
  console.log(`[blog-scoring] Generated ${reviews.length} reviews for scoring`);
}

main();
