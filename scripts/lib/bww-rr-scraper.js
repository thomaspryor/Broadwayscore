'use strict';

/**
 * Count the number of outlets/critics listed in a BWW Review Roundup HTML page.
 * Supports two page formats:
 *  - New (2024+): JSON-LD with BlogPosting[] array — each entry = one review
 *  - Old: JSON-LD articleBody text with "Critic Name, Outlet:" patterns
 *
 * @param {string} html - Raw HTML of the BWW Review Roundup page
 * @returns {number} Count of distinct reviews listed on the page
 */
function countBwwRrOutlets(html) {
  if (!html) return 0;

  // New format: count BlogPosting entries in JSON-LD
  const blogPostingCount = (html.match(/"@type":\s*"BlogPosting"/g) || []).length;
  if (blogPostingCount > 0) return blogPostingCount;

  // Old format: parse articleBody from JSON-LD and count critic bylines
  const jsonMatch = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/);
  if (jsonMatch) {
    let articleBody = null;
    try {
      // BWW JSON-LD sometimes has literal newlines/control chars inside string values.
      // Replace all ASCII control chars (0x00-0x1F except \t) with a space — safe because
      // JSON is whitespace-tolerant between tokens and string newlines just become spaces.
      const cleaned = jsonMatch[1].replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x0A\x0D]/g, ' ');
      const json = JSON.parse(cleaned);
      articleBody = json.articleBody || null;
    } catch (_) {}

    if (articleBody) {
      // Skip intro, start from the critics section
      const reviewStart = articleBody.indexOf("Let's see what the critics had to say");
      const text = reviewStart > 0 ? articleBody.substring(reviewStart) : articleBody;

      const patterns = [
        /([A-Z][a-z]+(?:\s+[A-Z]\.?)?\s+[A-Z][a-z]+),\s+([A-Za-z][A-Za-z\s&'.]+):/g,
        /([A-Z][a-z]+\s+[A-Z]\.\s+[A-Z][a-z]+),\s+([A-Za-z][A-Za-z\s&'.]+):/g,
      ];

      const critics = new Set();
      for (const pattern of patterns) {
        let match;
        while ((match = pattern.exec(text)) !== null) {
          const outlet = match[2].trim();
          if (
            outlet.length >= 2 &&
            outlet.length <= 60 &&
            !outlet.includes('http') &&
            !outlet.match(/^(In|The|A|An|On|At|For|With|And|But|Or|If|So|As|By)$/i)
          ) {
            critics.add(match[1].trim().toLowerCase());
          }
        }
      }
      return critics.size;
    }
  }

  return 0;
}

module.exports = { countBwwRrOutlets };
