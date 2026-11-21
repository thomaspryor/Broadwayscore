'use strict';

/**
 * Generate title variants for fuzzy matching in headings.
 * E.g., "The Outsiders: A New Musical" → ["the outsiders: a new musical", "the outsiders"]
 */
function getTitleVariants(title) {
  const lower = title.toLowerCase();
  const variants = [lower];

  // Strip subtitle after colon
  if (lower.includes(':')) {
    variants.push(lower.split(':')[0].trim());
  }
  // Strip subtitle after dash (but not compound words)
  if (lower.includes(' - ')) {
    variants.push(lower.split(' - ')[0].trim());
  }
  // "& Juliet" ↔ "and Juliet"
  if (lower.includes(' & ')) {
    variants.push(lower.replace(/ & /g, ' and '));
  }
  if (lower.includes(' and ')) {
    variants.push(lower.replace(/ and /g, ' & '));
  }

  return [...new Set(variants)];
}

/**
 * Finkle's First Nighter columns separate reviews with long asterisk runs.
 * Some stored pages flatten the divider directly against the prose. Require
 * source metadata and long runs so star ratings, footnotes and other outlets'
 * decorative rules cannot silently cut a single-show review.
 * Repeated title mentions identify the section; a passing comparison in another
 * section is allowed only when the target section has at least twice the hits.
 */
function trimByAsteriskDivider(fullText, targetShowTitle, source) {
  const originalLength = fullText.length;
  const fail = { text: fullText, trimmed: false, trimFailed: true, method: 'none', originalLength, trimmedLength: originalLength };
  if (!targetShowTitle || source?.outletId !== 'huffpost' || source.criticName?.trim().toLowerCase() !== 'david finkle') return fail;
  const sections = fullText.split(/\*{10,}/).map(s => s.trim());
  if (sections.filter(s => s.length >= 500).length < 2) return fail;

  const normalize = (s) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  const variants = [...new Set(getTitleVariants(targetShowTitle).map(normalize).filter(Boolean))];
  const patterns = variants.map(v => new RegExp(`(?<![\\p{L}\\p{N}])${v}(?![\\p{L}\\p{N}])`, 'gu'));
  const ranked = sections.map(text => {
    const normalized = normalize(text);
    const mentions = Math.max(0, ...patterns.map(pattern => [...normalized.matchAll(pattern)].length));
    return { text, mentions };
  }).sort((a, b) => b.mentions - a.mentions);
  const best = ranked[0];
  if (best.text.length < 500 || best.mentions < 2 || best.mentions <= ranked[1].mentions || best.mentions < ranked[1].mentions * 2) {
    return fail;
  }
  return { text: best.text, trimmed: true, trimFailed: false, method: 'asterisk-divider', originalLength, trimmedLength: best.text.length };
}

module.exports = { getTitleVariants, trimByAsteriskDivider };
