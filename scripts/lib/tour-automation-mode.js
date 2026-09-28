'use strict';

/**
 * Mode for the unattended national-tour writers (BRO-4262): enrich-tour-dates
 * (TOUR_DATES_MODE) and create-tour-entries (TOUR_AUTOCREATE).
 *
 * An explicit repo variable wins: off | report | write. Unset, they run
 * report-only for their first week, then write, so the switch-on needs no one
 * (the owner has no Vercel/GitHub settings access from a phone).
 */

const LIVE_FROM = '2026-10-06';

function tourAutomationMode(value, now = new Date()) {
  const v = String(value || '').trim().toLowerCase();
  if (v === 'off' || v === 'report' || v === 'write') return v;
  return now.toISOString().slice(0, 10) >= LIVE_FROM ? 'write' : 'report';
}

module.exports = { tourAutomationMode, LIVE_FROM };
