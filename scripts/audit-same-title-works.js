#!/usr/bin/env node
'use strict';
/**
 * Audit of every same-title group in data/shows.json (BRO-7429).
 *
 *   node scripts/audit-same-title-works.js [--write] [--check]
 *
 * For each pair of productions sharing a normalized title, classifies them as the
 * same work, a different work, or unknown (scripts/lib/work-identity.js), applies
 * the hand-checked verdicts in data/audit/same-title-manual-verdicts.json (each
 * cites its evidence), and flags unknown pairs that carry a risk signal.
 * --write refreshes data/audit/same-title-works.json and docs/audits/same-title-works.md.
 * --check exits 1 when a pair the matcher still links is recorded as a different work.
 */
require('./lib/cli-help').exitOnHelp(module);
require('./lib/same-title-audit').main();
