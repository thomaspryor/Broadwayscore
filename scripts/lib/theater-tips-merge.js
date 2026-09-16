/**
 * Pure per-theater merge logic for merge-theater-tips.js.
 *
 * Extracted so the regression test can require() the real function instead
 * of re-implementing the merge rules (CLAUDE.md §15). Building the merged
 * structuredTips object here — not the fs I/O — is what the coverage test
 * for BRO-932 pins: existing hand-curated `seating.sections` must survive a
 * merge even though the LLM draft never produces that field.
 */

function buildAccessibilityText(accessibility) {
  if (!accessibility) return null;
  if (accessibility.notes) return accessibility.notes;
  const parts = [];
  if (accessibility.wheelchair) parts.push('Wheelchair accessible');
  if (accessibility.elevator) parts.push('elevator available');
  if (accessibility.hearingLoop) parts.push('hearing loop available');
  if (accessibility.assistiveListening) parts.push('assistive listening devices available');
  return parts.length > 0 ? parts.join('. ').replace(/\.\./g, '.') + '.' : null;
}

/**
 * Build the structuredTips object for one theater from its LLM draft tips
 * plus the theater's existing metadata entry.
 *
 * @param {object} tips - draft.theaters[name] from generate-theater-tips.js
 * @param {object} existingTheaterMetadata - metadata[name] (may be undefined)
 * @returns {{ structuredTips: object, accessibilityInjected: boolean, restaurantNames: string[] }}
 */
function buildMergedStructuredTips(tips, existingTheaterMetadata) {
  const structuredTips = {
    lastUpdated: tips.lastUpdated || new Date().toISOString(),
  };

  // Seating (without accessibility — injected below from verified data)
  if (tips.seating) {
    structuredTips.seating = {};
    if (tips.seating.bestSeats) structuredTips.seating.bestSeats = tips.seating.bestSeats;
    if (tips.seating.avoidSeats) structuredTips.seating.avoidSeats = tips.seating.avoidSeats;
    // Never copy LLM accessibility — always from verified data
    if (Object.keys(structuredTips.seating).length === 0) delete structuredTips.seating;
  }

  // Inject verified accessibility from metadata
  let accessibilityInjected = false;
  const verifiedAccessibility = existingTheaterMetadata?.accessibility;
  if (verifiedAccessibility?.verified) {
    const accessText = buildAccessibilityText(verifiedAccessibility);
    if (accessText) {
      if (!structuredTips.seating) structuredTips.seating = {};
      structuredTips.seating.accessibility = accessText;
      accessibilityInjected = true;
    }
  }

  // Preserve hand-curated seating sections. The LLM draft never produces
  // this field (generate-theater-tips.js only outputs bestSeats/avoidSeats),
  // so without this the merge silently deleted it on every quarterly run —
  // wiped all 42 theaters' sections on the 2026-07-01 automated run (BRO-932).
  const existingSections = existingTheaterMetadata?.structuredTips?.seating?.sections;
  if (existingSections?.length) {
    if (!structuredTips.seating) structuredTips.seating = {};
    structuredTips.seating.sections = existingSections;
  }

  // Parking
  if (tips.parking) {
    structuredTips.parking = {};
    if (tips.parking.nearestGarages?.length > 0) {
      structuredTips.parking.nearestGarages = tips.parking.nearestGarages.map((g) => ({
        name: g.name,
        ...(g.walkMinutes != null ? { walkMinutes: g.walkMinutes } : {}),
        ...(g.notes ? { notes: g.notes } : {}),
      }));
    }
    if (tips.parking.streetParking) structuredTips.parking.streetParking = tips.parking.streetParking;
    if (tips.parking.tip) structuredTips.parking.tip = tips.parking.tip;
    if (Object.keys(structuredTips.parking).length === 0) delete structuredTips.parking;
  }

  // Dining
  const restaurantNames = [];
  if (tips.dining) {
    structuredTips.dining = {};
    for (const category of ['preShow', 'postShow', 'quickBite']) {
      if (tips.dining[category]?.length > 0) {
        structuredTips.dining[category] = tips.dining[category].map((r) => {
          restaurantNames.push(r.name);
          return {
            name: r.name,
            ...(r.cuisine ? { cuisine: r.cuisine } : {}),
            ...(r.walkMinutes != null ? { walkMinutes: r.walkMinutes } : {}),
            ...(r.priceRange ? { priceRange: r.priceRange } : {}),
            ...(r.notes ? { notes: r.notes } : {}),
          };
        });
      }
    }
    if (Object.keys(structuredTips.dining).length === 0) delete structuredTips.dining;
  }

  // Logistics
  if (tips.logistics) {
    structuredTips.logistics = {};
    if (tips.logistics.entrance) structuredTips.logistics.entrance = tips.logistics.entrance;
    if (tips.logistics.nearestSubway) structuredTips.logistics.nearestSubway = tips.logistics.nearestSubway;
    if (tips.logistics.exitStrategy) structuredTips.logistics.exitStrategy = tips.logistics.exitStrategy;
    if (tips.logistics.restrooms) structuredTips.logistics.restrooms = tips.logistics.restrooms;
    if (Object.keys(structuredTips.logistics).length === 0) delete structuredTips.logistics;
  }

  return { structuredTips, accessibilityInjected, restaurantNames };
}

module.exports = { buildMergedStructuredTips, buildAccessibilityText };
