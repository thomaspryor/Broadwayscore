'use strict';
/**
 * BRO-7339: worker-card decisions for scripts/audit-openai-retirements.js --alert.
 * Pure. Two keys, so a missing page never closes the findings card:
 *   openai-retirement:input-missing   the deprecations page could not be read or parsed.
 *   openai-retirement:unregistered    the repo uses a model OpenAI has scheduled for
 *                                     shutdown that research-cost.js does not know (or
 *                                     whose date moved). Rows are model ids and dates only.
 */
const { buildAuditAlert } = require('./audit-alert');

const INPUT_MISSING_KEY = 'openai-retirement:input-missing';
const UNREGISTERED_KEY = 'openai-retirement:unregistered';
const DONE = 'Done when node scripts/audit-openai-retirements.js --strict exits 0.';

/** @param {{inputMissing:boolean, missing:object[], dateDrift:object[]}} out */
function decideOpenAiRetirementAlerts(out) {
  if (!out || out.inputMissing) {
    return [buildAuditAlert({
      conditionKey: INPUT_MISSING_KEY,
      rows: ['OpenAI deprecations page: 0 usable rows'],
      title: () => 'OpenAI shutdown check could not read the deprecations page (input missing)',
      intro: 'The daily OpenAI retirement audit parsed too few rows from developers.openai.com/api/docs/deprecations, so it checked nothing. The page layout may have changed or the fetch was blocked.',
      hint: `Fetch the page by hand and compare its tables with parseDeprecations() in scripts/lib/openai-deprecations.js; fix the parser if the layout moved. ${DONE}`,
    })];
  }
  const rows = [
    ...(out.missing || []).map((m) => `${m.id}: OpenAI shuts it down ${m.shutdown} (${m.daysLeft} days), replacement ${m.replacement || 'none named'}; the repo uses it and the registry does not list it`),
    ...(out.dateDrift || []).map((d) => `${d.id}: registry says ${d.registry}, OpenAI now says ${d.page}`),
  ];
  return [
    { action: 'resolve', conditionKey: INPUT_MISSING_KEY, reason: 'deprecations page parsed' },
    buildAuditAlert({
      conditionKey: UNREGISTERED_KEY,
      rows,
      title: (n) => `OpenAI shutdown: ${n} model${n === 1 ? '' : 's'} the repo uses ${n === 1 ? 'is' : 'are'} not in the retirement registry`,
      intro: `The daily OpenAI retirement audit found ${rows.length} model${rows.length === 1 ? '' : 's'} this repo references that OpenAI has scheduled for shutdown and scripts/lib/research-cost.js does not track.`,
      hint: `Add each id to MODEL_SHUTDOWNS in scripts/lib/research-cost.js (the guard in tests/unit/research-cost.test.mjs then fails every call site that still names it), move the call sites to OpenAI's named replacement (check price in RATES, run 3 real cases), or list it in ACCEPTED_SHUTDOWNS with a card id when the migration needs its own A/B. ${DONE}`,
      resolveReason: 'every referenced OpenAI model with a shutdown date is registered',
    }),
  ];
}

module.exports = { decideOpenAiRetirementAlerts, INPUT_MISSING_KEY, UNREGISTERED_KEY };
