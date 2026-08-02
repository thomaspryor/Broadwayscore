#!/usr/bin/env node
/**
 * Bright Data / ScrapingBee / Scrapingdog per-call telemetry.
 *
 * Kept as a thin back-compat shim (scripts/lib/scraper.js and
 * scripts/lib/url-discovery.js require this file by name) delegating to the
 * generalized scripts/lib/provider-telemetry.js (task #752), which adds
 * Browserbase support + a durable committed ledger on top of the same
 * `[BD Call]`/`[SB Call]`/`[SD Call]` stdout contract this file always had.
 *
 * Format: `[BD Call] {"ts":"...","script":"...","workflow":"...","host":"...","fn":"...","success":true,"status":200,"fallback_from":null}`
 */
'use strict';

const { recordBdCall, recordSbCall, recordSdCall } = require('./provider-telemetry');

module.exports = { recordBdCall, recordSbCall, recordSdCall };
