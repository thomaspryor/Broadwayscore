/**
 * Page-weight constants for the market list pages (/west-end, /off-broadway,
 * /off-west-end). Server-safe on purpose: page.tsx files import these, and a
 * value exported from a 'use client' module is not usable on the server (BRO-5991).
 */

/** Cards rendered into the prerendered HTML, and added per scroll step. */
export const INITIAL_SHOW_COUNT = 20;
export const LOAD_MORE_STEP = 20;

/** Max cards on a market-page shelf; the main list below holds the rest. */
export const SHELF_MAX_ITEMS = 8;
