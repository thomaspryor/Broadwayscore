/**
 * Pure validators for LLM-generated theater tips.
 *
 * Extracted so both the generator (runtime guards) and the eval harness
 * (scripts/evals/theater-tips-eval.js) call the same code. Tests require()
 * these functions directly — never copy logic into the test file.
 *
 * Incident that motivated this: Gemini hallucinated elevator access for 17
 * theaters in 2026-04-03. The prompt said "don't invent restaurant names"
 * but gave the LLM free rein on accessibility claims. See
 * memory/feedback_structuredtips_hallucinations.md.
 *
 * Rule: accessibility/ADA/medical/safety claims must NEVER appear in any
 * LLM-generated free-text field. The accessibility object in
 * theater-metadata.json is the source of truth and is injected post-hoc.
 */

// Free-text fields the LLM fills that can hallucinate facts.
const FREE_TEXT_PATHS = [
  ['seating', 'bestSeats'],
  ['seating', 'avoidSeats'],
  ['parking', 'streetParking'],
  ['parking', 'tip'],
  ['logistics', 'entrance'],
  ['logistics', 'nearestSubway'],
  ['logistics', 'exitStrategy'],
  ['logistics', 'restrooms'],
];

// Patterns that must not appear in LLM-generated free text.
// Accessibility/safety/medical — these need to come from verified sources,
// not from the model's pretraining guess at a theater's physical layout.
const BANNED_CLAIM_PATTERNS = [
  { pattern: /\belevators?\b/i, category: 'accessibility', reason: 'accessibility claims must come from verified theater-metadata.json, not the LLM' },
  { pattern: /\bwheelchair[- ]?(accessible|access|friendly|lift|ramp)?\b/i, category: 'accessibility', reason: 'accessibility claims must come from verified source' },
  { pattern: /\bADA[- ](compliant|accessible)?\b/, category: 'accessibility', reason: 'ADA compliance claims need legal-grade verification' },
  { pattern: /\bstep[- ]free\b/i, category: 'accessibility', reason: 'accessibility claim' },
  { pattern: /\bassistive[- ](listening|device)/i, category: 'accessibility', reason: 'accessibility claim' },
  { pattern: /\bhearing[- ]loop\b/i, category: 'accessibility', reason: 'accessibility claim' },
  { pattern: /\b(closed[- ])?caption(ing|ed)?\b/i, category: 'accessibility', reason: 'accessibility claim' },
  { pattern: /\b(audio[- ])?description\b(?!\s+of)/i, category: 'accessibility', reason: 'accessibility-feature claim (note: narrow regex)' },
  { pattern: /\bservice (animal|dog)\b/i, category: 'accessibility', reason: 'accessibility claim' },
  // Medical / dietary — easy hallucinations
  { pattern: /\b(gluten[- ]free|allergen[- ]free|nut[- ]free|dairy[- ]free)\b/i, category: 'medical', reason: 'dietary claims should come from restaurant source, not LLM' },
  // Safety — out of scope entirely
  { pattern: /\bfire (exit|escape)\b/i, category: 'safety', reason: 'safety infrastructure claims out of scope' },
  { pattern: /\bemergency (exit|evacuation)\b/i, category: 'safety', reason: 'safety infrastructure claims out of scope' },
  // Specific number claims about physical infrastructure are a red flag —
  // e.g. "two elevators", "three accessible bathrooms". These almost never
  // come from our data. Catch numeric modifiers of banned-category nouns.
  { pattern: /\b(\d+|two|three|four|five|six)\s+(elevators?|ramps?|lifts?)\b/i, category: 'accessibility', reason: 'specific count of accessibility infrastructure — classic hallucination pattern' },
];

function getPath(obj, pathParts) {
  let cur = obj;
  for (const k of pathParts) {
    if (cur == null) return null;
    cur = cur[k];
  }
  return cur;
}

/**
 * Scan every free-text field on a tip object for banned claim patterns.
 * Returns an array of findings — empty array means clean.
 *
 * @param {object} tips - a single theater's tip object
 * @returns {Array<{path: string, text: string, category: string, pattern: string, reason: string}>}
 */
function detectBannedClaims(tips) {
  const findings = [];
  if (!tips || typeof tips !== 'object') return findings;

  // Scan top-level free-text paths
  for (const pathParts of FREE_TEXT_PATHS) {
    const value = getPath(tips, pathParts);
    if (typeof value !== 'string' || value.length === 0) continue;
    for (const rule of BANNED_CLAIM_PATTERNS) {
      const match = value.match(rule.pattern);
      if (match) {
        findings.push({
          path: pathParts.join('.'),
          text: value,
          category: rule.category,
          pattern: rule.pattern.toString(),
          match: match[0],
          reason: rule.reason,
        });
      }
    }
  }

  // Scan dining[*].notes — these are user-visible and LLM-generated
  for (const category of ['preShow', 'postShow', 'quickBite']) {
    const items = tips?.dining?.[category];
    if (!Array.isArray(items)) continue;
    items.forEach((item, idx) => {
      const notes = item?.notes;
      if (typeof notes !== 'string' || notes.length === 0) return;
      for (const rule of BANNED_CLAIM_PATTERNS) {
        const match = notes.match(rule.pattern);
        if (match) {
          findings.push({
            path: `dining.${category}[${idx}].notes`,
            text: notes,
            category: rule.category,
            pattern: rule.pattern.toString(),
            match: match[0],
            reason: rule.reason,
          });
        }
      }
    });
  }

  return findings;
}

/**
 * Validate that the tip object matches the expected schema. Returns an array
 * of error strings — empty array means the schema is good.
 */
function validateSchema(tips) {
  const errors = [];
  if (!tips || typeof tips !== 'object') {
    return ['tips is not an object'];
  }
  const requireObject = (obj, name) => {
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
      errors.push(`${name} must be an object`);
      return false;
    }
    return true;
  };
  const requireStringOrNull = (val, name) => {
    if (val !== null && typeof val !== 'string') {
      errors.push(`${name} must be a string or null`);
    }
  };
  const requireArray = (val, name) => {
    if (!Array.isArray(val)) {
      errors.push(`${name} must be an array`);
      return false;
    }
    return true;
  };

  if (requireObject(tips.seating, 'seating')) {
    requireStringOrNull(tips.seating.bestSeats, 'seating.bestSeats');
    requireStringOrNull(tips.seating.avoidSeats, 'seating.avoidSeats');
    if ('accessibility' in tips.seating) {
      errors.push('seating.accessibility must not be present on LLM output (injected separately)');
    }
  }

  if (requireObject(tips.parking, 'parking')) {
    if (requireArray(tips.parking.nearestGarages, 'parking.nearestGarages')) {
      tips.parking.nearestGarages.forEach((g, i) => {
        if (typeof g.name !== 'string' || !g.name.trim()) errors.push(`parking.nearestGarages[${i}].name missing`);
        if (typeof g.walkMinutes !== 'number' || !Number.isFinite(g.walkMinutes)) errors.push(`parking.nearestGarages[${i}].walkMinutes must be number`);
      });
    }
    requireStringOrNull(tips.parking.streetParking, 'parking.streetParking');
    requireStringOrNull(tips.parking.tip, 'parking.tip');
  }

  if (requireObject(tips.dining, 'dining')) {
    for (const category of ['preShow', 'postShow', 'quickBite']) {
      if (!requireArray(tips.dining[category], `dining.${category}`)) continue;
      tips.dining[category].forEach((r, i) => {
        const label = `dining.${category}[${i}]`;
        if (typeof r.name !== 'string' || !r.name.trim()) errors.push(`${label}.name missing`);
        if (typeof r.walkMinutes !== 'number' || !Number.isFinite(r.walkMinutes)) errors.push(`${label}.walkMinutes must be number`);
        if (r.priceRange && !/^\${1,4}$/.test(r.priceRange)) errors.push(`${label}.priceRange must be $, $$, $$$, or $$$$`);
      });
    }
  }

  if (requireObject(tips.logistics, 'logistics')) {
    requireStringOrNull(tips.logistics.entrance, 'logistics.entrance');
    requireStringOrNull(tips.logistics.nearestSubway, 'logistics.nearestSubway');
    requireStringOrNull(tips.logistics.exitStrategy, 'logistics.exitStrategy');
    requireStringOrNull(tips.logistics.restrooms, 'logistics.restrooms');
  }

  return errors;
}

/**
 * Validate that every restaurant/garage name in the tip object exists in the
 * scraped data for that theater. Returns array of invented names.
 */
function validateGrounding(tips, scrapedData) {
  const findings = [];
  if (!tips) return findings;

  const scrapedDiningNames = new Set((scrapedData?.dining || []).map(r => r.name));
  const scrapedGarageNames = new Set((scrapedData?.parking || []).map(g => g.name));

  for (const category of ['preShow', 'postShow', 'quickBite']) {
    const items = tips?.dining?.[category];
    if (!Array.isArray(items)) continue;
    items.forEach((r, idx) => {
      if (!scrapedDiningNames.has(r.name)) {
        findings.push({
          path: `dining.${category}[${idx}].name`,
          name: r.name,
          kind: 'invented-restaurant',
        });
      }
    });
  }

  const garages = tips?.parking?.nearestGarages;
  if (Array.isArray(garages)) {
    garages.forEach((g, idx) => {
      if (!scrapedGarageNames.has(g.name)) {
        findings.push({
          path: `parking.nearestGarages[${idx}].name`,
          name: g.name,
          kind: 'invented-garage',
        });
      }
    });
  }

  return findings;
}

/**
 * Validate that no restaurant appears in more than one dining category for
 * the same theater.
 */
function validateCategoryDedup(tips) {
  const findings = [];
  const seen = new Map(); // name -> category it first appeared in
  for (const category of ['preShow', 'postShow', 'quickBite']) {
    const items = tips?.dining?.[category];
    if (!Array.isArray(items)) continue;
    items.forEach((r, idx) => {
      if (seen.has(r.name)) {
        findings.push({
          path: `dining.${category}[${idx}].name`,
          name: r.name,
          duplicateOf: seen.get(r.name),
        });
      } else {
        seen.set(r.name, category);
      }
    });
  }
  return findings;
}

/**
 * Cross-theater diversity audit. Flags restaurants appearing in more than
 * `thresholdFraction` of total theaters — a symptom of lazy LLM padding
 * (e.g. "Junior's" showing up for 40 of 41 theaters regardless of distance).
 *
 * @param {object} allDrafts - { [theaterName]: tipsObject }
 * @param {number} thresholdFraction - default 0.5
 * @returns {Array<{name: string, count: number, theaters: number, fraction: number}>}
 */
function auditCrossTheaterDiversity(allDrafts, thresholdFraction = 0.5) {
  const counts = {};
  const theaterNames = Object.keys(allDrafts || {});
  const total = theaterNames.length;
  if (total === 0) return [];

  for (const theaterName of theaterNames) {
    const tips = allDrafts[theaterName];
    const seenForThisTheater = new Set();
    for (const category of ['preShow', 'postShow', 'quickBite']) {
      const items = tips?.dining?.[category];
      if (!Array.isArray(items)) continue;
      for (const r of items) {
        if (!seenForThisTheater.has(r.name)) {
          counts[r.name] = (counts[r.name] || 0) + 1;
          seenForThisTheater.add(r.name);
        }
      }
    }
  }

  const threshold = total * thresholdFraction;
  return Object.entries(counts)
    .filter(([, count]) => count > threshold)
    .map(([name, count]) => ({ name, count, theaters: total, fraction: count / total }))
    .sort((a, b) => b.count - a.count);
}

/**
 * Top-level runner — validates one theater's tip object and returns a
 * structured result. Used by both the eval harness and the generator's
 * runtime guards.
 */
function validateTips(tips, scrapedData) {
  return {
    schemaErrors: validateSchema(tips),
    bannedClaims: detectBannedClaims(tips),
    groundingFindings: validateGrounding(tips, scrapedData || {}),
    categoryDupes: validateCategoryDedup(tips),
  };
}

module.exports = {
  BANNED_CLAIM_PATTERNS,
  FREE_TEXT_PATHS,
  validateSchema,
  detectBannedClaims,
  validateGrounding,
  validateCategoryDedup,
  auditCrossTheaterDiversity,
  validateTips,
};
