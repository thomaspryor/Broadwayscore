'use strict';
/**
 * Consecutive "all SERP providers unavailable" strikes (BRO-6492).
 *
 * gather-reviews.js used to abort a show's whole STEP 2 sweep on the first
 * outlet where every provider failed. That fires on one bad query, not only
 * on a real outage: a Scrapingdog transient 400 while Bright Data is over its
 * daily cap and ScrapingBee times out. 5 of 29 sampled backfill shows lost
 * the rest of their sweep that way (one after 18 of 150 outlets). Abort only
 * after `max` unavailable outlets in a row (one strike per outlet, however
 * many queries it made, BRO-6534); any answered query resets it.
 */
const DEFAULT_MAX_STRIKES = 3;

/** SERP_UNAVAILABLE_MAX_STRIKES: positive integer, else the default. */
function resolveMaxStrikes(env = process.env) {
  const n = parseInt(env.SERP_UNAVAILABLE_MAX_STRIKES, 10);
  return Number.isFinite(n) && n >= 1 ? n : DEFAULT_MAX_STRIKES;
}

function createSerpUnavailableStrikes(max = resolveMaxStrikes()) {
  let strikes = 0;
  return {
    max,
    /** @returns {{abort: boolean, strikes: number}} */
    note(unavailable) {
      strikes = unavailable ? strikes + 1 : 0;
      return { abort: strikes >= max, strikes };
    },
  };
}

module.exports = { DEFAULT_MAX_STRIKES, resolveMaxStrikes, createSerpUnavailableStrikes };
