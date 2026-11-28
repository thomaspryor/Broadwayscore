'use strict';

/**
 * Second, independent signal that show.cast came from the wrong production.
 *
 * show.cast is scraped from an IBDB production page; show.castBilling is the Playbill billing
 * for THIS run. A real cast and its own billing share people (even a long-run cast turns over
 * gradually). Zero shared names across two lists of 3+ means the cast belongs to another run:
 * wanted-2022 showed 13 names from a 1928 play against 19 Playbill names with no overlap.
 * Checked over every shows.json entry 2026-11-10: wanted-2022 was the only disjoint pair.
 */

function normName(n) {
  const raw = n && typeof n === 'object' ? n.name : n;
  return String(raw || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z]/g, '');
}

// True when both lists have 3+ people and no one appears in both.
function castDisjointFromBilling(show, { minNames = 3 } = {}) {
  if (!show || !Array.isArray(show.cast) || !Array.isArray(show.castBilling)) return false;
  const cast = show.cast.map(normName).filter(Boolean);
  const billing = new Set(show.castBilling.map(normName).filter(Boolean));
  if (cast.length < minNames || billing.size < minNames) return false;
  return !cast.some(n => billing.has(n));
}

module.exports = { castDisjointFromBilling, normName };
