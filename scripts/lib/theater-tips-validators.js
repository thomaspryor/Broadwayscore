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
 * MTA station → served lines. Truth table for the Broadway theater district.
 * Sourced from mta.info station pages. Keep keys normalized: lower case, no
 * punctuation except hyphens, "st" not "street".
 *
 * Empirical iteration finding (2026-04-15): Gemini hallucinates nearby lines
 * that don't actually stop at the claimed station. Observed in iteration 1:
 *   - "49 St (N/Q/R/W)"   → Q does not stop at 49 St
 *   - "50 St (1, 2)"       → 2 does not stop at 50 St (express bypass)
 */
const SUBWAY_STATION_LINES = {
  '42 st-times sq':             ['1', '2', '3', '7', 'N', 'Q', 'R', 'W', 'S'],
  'times sq-42 st':             ['1', '2', '3', '7', 'N', 'Q', 'R', 'W', 'S'],
  'times square-42 st':         ['1', '2', '3', '7', 'N', 'Q', 'R', 'W', 'S'],
  '42 st-port authority':       ['A', 'C', 'E'],
  '49 st':                      ['N', 'R', 'W'],
  '50 st':                      ['1'],            // Broadway-7 Av line
  '50 st-8 av':                 ['C', 'E'],       // ambiguous — LLM usually means the 1 stop
  '47-50 sts-rockefeller ctr':  ['B', 'D', 'F', 'M'],
  '47-50 sts':                  ['B', 'D', 'F', 'M'],
  'rockefeller ctr':            ['B', 'D', 'F', 'M'],
  '42 st-bryant pk':            ['B', 'D', 'F', 'M', '7'],
  'bryant park':                ['B', 'D', 'F', 'M', '7'],
  '34 st-herald sq':            ['B', 'D', 'F', 'M', 'N', 'Q', 'R', 'W'],
  '59 st-columbus circle':      ['1', 'A', 'B', 'C', 'D'],
  'grand central-42 st':        ['4', '5', '6', '7', 'S'],
};

function normalizeStationName(text) {
  if (!text || typeof text !== 'string') return null;
  return text
    .toLowerCase()
    // Strip ordinal suffixes on numbers first: "49th" → "49", "42nd" → "42".
    // Otherwise "49th street" doesn't match the "49 st" key.
    .replace(/(\d+)(st|nd|rd|th)\b/g, '$1')
    .replace(/street/g, 'st')
    .replace(/avenue/g, 'av')
    .replace(/center/g, 'ctr')
    .replace(/park/g, 'pk')
    .replace(/square/g, 'sq')
    .replace(/[^\w\s-]/g, ' ')
    .replace(/\bthe\b|\bstation\b|\bsubway\b|\bstop\b/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function findKnownStation(text) {
  const norm = normalizeStationName(text);
  if (!norm) return null;
  // Score candidates by longest-matching key
  let best = null;
  for (const key of Object.keys(SUBWAY_STATION_LINES)) {
    if (norm.includes(key) && (!best || key.length > best.length)) {
      best = key;
    }
  }
  return best;
}

/**
 * Extract subway line tokens from LLM free text. Looks for single uppercase
 * letters (A/C/E/...) and single digits (1-7) mentioned in parenthesized or
 * comma-separated lists.
 *
 * Returns unique set of normalized line tokens, preserving case for letters.
 */
function extractClaimedLines(text) {
  if (!text) return [];
  // Grab the parenthesized list after "station" or "lines" if present,
  // otherwise scan the whole string.
  const parenMatch = text.match(/\(([^)]+)\)/);
  const scope = parenMatch ? parenMatch[1] : text;
  const tokens = new Set();
  // Letter lines A-Z (single letter surrounded by non-letter)
  for (const m of scope.matchAll(/\b([ABCDEFGJLMNQRSWZ])\b/g)) tokens.add(m[1]);
  // Numbered lines 1-7
  for (const m of scope.matchAll(/\b([1-7])\b/g)) tokens.add(m[1]);
  return Array.from(tokens);
}

/**
 * Cross-check the nearestSubway claim against MTA truth. Returns findings for
 * any claimed line that does not actually stop at the identified station.
 */
function validateSubwayFacts(tips) {
  const findings = [];
  const text = tips?.logistics?.nearestSubway;
  if (!text || typeof text !== 'string') return findings;

  const station = findKnownStation(text);
  if (!station) {
    // No known station match — can't verify. Not an error.
    return findings;
  }

  const truth = new Set(SUBWAY_STATION_LINES[station]);
  const claimed = extractClaimedLines(text);
  const wrong = claimed.filter(l => !truth.has(l));

  if (wrong.length > 0) {
    findings.push({
      path: 'logistics.nearestSubway',
      text,
      station,
      claimedLines: claimed,
      truthLines: Array.from(truth),
      wrongLines: wrong,
    });
  }
  return findings;
}

/**
 * Broadway theater → valid entrance street numbers. These are cross-street
 * names (e.g. a theater at 227 W 42nd St has valid entrance "42"). Addresses
 * are stable data — physical theaters don't move. Verified against IBDB and
 * the Broadway League.
 *
 * Values are arrays because some theaters have multiple valid entrances
 * (e.g. Marquis enters through the Marriott hotel on Broadway, Palace
 * entrance is also on Broadway, Shubert's audience entrance is on 44th but
 * many people approach from Shubert Alley).
 *
 * Special tokens: "broadway", "alley", "plaza" cover non-numbered streets.
 *
 * Empirical iteration finding (2026-04-15): Todd Haimes Theatre (227 W 42)
 * draft said entrance on "43rd Street" — classic LLM off-by-one hallucination
 * on theater addresses. This table pins every theater's valid streets.
 */
const THEATER_VALID_ENTRANCE_STREETS = {
  "Al Hirschfeld Theatre":                          ["45"],
  "Ambassador Theatre":                             ["49"],
  "August Wilson Theatre":                          ["52"],
  "Belasco Theatre":                                ["44"],
  "Bernard B. Jacobs Theatre":                      ["45"],
  "Booth Theatre":                                  ["45"],
  "Broadhurst Theatre":                             ["44"],
  "Broadway Theatre":                               ["53", "broadway"],
  "Lena Horne Theatre":                             ["47"],
  "Circle in the Square Theatre":                   ["50", "broadway"],
  "Ethel Barrymore Theatre":                        ["47"],
  "Eugene O'Neill Theatre":                         ["49"],
  "Gerald Schoenfeld Theatre":                      ["45"],
  "Gershwin Theatre":                               ["51"],
  "Harold and Miriam Steinberg Center for Theatre": ["46"],
  "Helen Hayes Theater":                            ["44"],
  "Hudson Theatre":                                 ["44"],
  "Imperial Theatre":                               ["45"],
  "James Earl Jones Theatre":                       ["48"],
  "John Golden Theatre":                            ["45"],
  "Longacre Theatre":                               ["48"],
  "Lunt-Fontanne Theatre":                          ["46"],
  "Lyceum Theatre":                                 ["45"],
  "Lyric Theatre":                                  ["43", "42"],  // entrances on both
  "Majestic Theatre":                               ["44"],
  "Marquis Theatre":                                ["46", "broadway"],  // enter via Marriott
  "Minskoff Theatre":                               ["45", "broadway"],
  "Music Box Theatre":                              ["45"],
  "Nederlander Theatre":                            ["41"],
  "Neil Simon Theatre":                             ["52"],
  "New Amsterdam Theatre":                          ["42"],
  "Palace Theatre":                                 ["47", "broadway"],
  "Richard Rodgers Theatre":                        ["46"],
  "Samuel J. Friedman Theatre":                     ["47"],
  "Shubert Theatre":                                ["44", "alley"],
  "St. James Theatre":                              ["44"],
  "Stephen Sondheim Theatre":                       ["43"],
  "Studio 54":                                      ["54"],
  "Todd Haimes Theatre":                            ["42"],
  "Vivian Beaumont Theater":                        ["plaza", "65"],
  "Walter Kerr Theatre":                            ["48"],
  "Winter Garden Theatre":                          ["50", "broadway"],
};

/**
 * Extract street tokens the LLM claimed as the entrance location. Only looks
 * at the phrase that follows "entrance is on / located on / enter via", not
 * directional references like "between Broadway and 8th Ave".
 *
 * Returns an array of normalized tokens: numeric street numbers (as strings)
 * plus special words "broadway", "alley", "plaza".
 */
function extractClaimedEntranceStreets(text) {
  if (!text || typeof text !== 'string') return [];
  // Capture only the segment after an entrance-locator phrase up to the next
  // sentence boundary or a disqualifying connector ("between", "just off").
  const locatorMatch = text.match(
    /(?:entrance\s+(?:is\s+)?(?:located\s+)?(?:on|at)|enter(?:ed)?\s+(?:via|through|from|on))\s+([^.]+?)(?=\s+between\s|\s+just\s|$|\.)/i
  );
  const scope = locatorMatch ? locatorMatch[1] : text;

  const tokens = new Set();
  // Numbered streets in Midtown West cross-street range (40-70).
  // Avoids building numbers like "1633 Broadway" and street-address prefixes
  // like "242 W 45" picking up the 242.
  for (const m of scope.matchAll(/\b(\d+)(?:st|nd|rd|th)?\b/g)) {
    const n = parseInt(m[1], 10);
    if (n >= 40 && n <= 70) tokens.add(String(n));
  }
  const lower = scope.toLowerCase();
  if (/\bbroadway\b/.test(lower)) tokens.add('broadway');
  if (/\b(shubert\s+alley|the\s+alley)\b/.test(lower)) tokens.add('alley');
  if (/\b(lincoln\s+center|plaza)\b/.test(lower)) tokens.add('plaza');
  return Array.from(tokens);
}

/**
 * Cross-check entrance text against the truth table. Returns findings for
 * any claimed street that is not a valid entrance for this theater.
 *
 * NOTE: this is one of the few validators that needs theaterName context —
 * the caller must pass it in.
 */
function validateEntranceAddress(tips, theaterName) {
  const findings = [];
  const entrance = tips?.logistics?.entrance;
  if (!entrance || typeof entrance !== 'string') return findings;
  const valid = THEATER_VALID_ENTRANCE_STREETS[theaterName];
  if (!valid) return findings; // unknown theater — can't verify

  const claimed = extractClaimedEntranceStreets(entrance);
  if (claimed.length === 0) return findings; // nothing concrete claimed

  const validSet = new Set(valid);
  const wrong = claimed.filter(c => !validSet.has(c));
  if (wrong.length > 0) {
    findings.push({
      path: 'logistics.entrance',
      theater: theaterName,
      text: entrance,
      validStreets: valid,
      claimedStreets: claimed,
      wrongStreets: wrong,
    });
  }
  return findings;
}

/**
 * Top-level runner — validates one theater's tip object and returns a
 * structured result. Used by both the eval harness and the generator's
 * runtime guards.
 *
 * @param {string} theaterName - optional; enables entrance-address check
 */
function validateTips(tips, scrapedData, theaterName = null) {
  return {
    schemaErrors: validateSchema(tips),
    bannedClaims: detectBannedClaims(tips),
    groundingFindings: validateGrounding(tips, scrapedData || {}),
    categoryDupes: validateCategoryDedup(tips),
    subwayFindings: validateSubwayFacts(tips),
    entranceFindings: theaterName ? validateEntranceAddress(tips, theaterName) : [],
  };
}

module.exports = {
  BANNED_CLAIM_PATTERNS,
  FREE_TEXT_PATHS,
  SUBWAY_STATION_LINES,
  THEATER_VALID_ENTRANCE_STREETS,
  validateSchema,
  detectBannedClaims,
  validateGrounding,
  validateCategoryDedup,
  auditCrossTheaterDiversity,
  validateSubwayFacts,
  extractClaimedLines,
  findKnownStation,
  validateEntranceAddress,
  extractClaimedEntranceStreets,
  validateTips,
};
