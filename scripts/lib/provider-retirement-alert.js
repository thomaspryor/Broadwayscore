'use strict';
/**
 * BRO-7342: worker-card decisions for scripts/audit-provider-retirements.js --alert
 * (Anthropic and Gemini; the OpenAI twin is openai-retirement-alert.js). Pure. Two keys
 * per provider, so a missing page never closes the findings card:
 *   <provider>-retirement:input-missing   the deprecations page could not be read or parsed.
 *   <provider>-retirement:unregistered    the repo uses a model the provider has scheduled for
 *                                         shutdown that research-cost.js does not know (or
 *                                         whose date moved). Rows are model ids and dates only.
 */
const { buildAuditAlert } = require('./audit-alert');
const { PROVIDERS } = require('./provider-deprecations');

const keys = (provider) => ({ input: `${provider}-retirement:input-missing`, found: `${provider}-retirement:unregistered` });

/** @param {'anthropic'|'gemini'} provider @param {{inputMissing:boolean, missing:object[], dateDrift:object[]}} out */
function decideProviderRetirementAlerts(provider, out) {
  const { name, url } = PROVIDERS[provider];
  const k = keys(provider);
  const done = `Done when node scripts/audit-provider-retirements.js --provider=${provider} --strict exits 0.`;
  if (!out || out.inputMissing) {
    return [buildAuditAlert({
      conditionKey: k.input,
      rows: [`${name} deprecations page: too few usable rows`],
      title: () => `${name} shutdown check could not read the deprecations page (input missing)`,
      intro: `The daily ${name} retirement audit parsed too few rows from ${url}, so it checked nothing. The page layout may have changed or the fetch was blocked.`,
      hint: `Fetch the page by hand and compare it with the ${provider} parser in scripts/lib/provider-deprecations.js; fix the parser if the layout moved. ${done}`,
    })];
  }
  const rows = [
    ...(out.missing || []).map((m) => `${m.id}: ${name} shuts it down ${m.shutdown} (${m.daysLeft} days), replacement ${m.replacement || 'none named'}; the repo uses it and the registry does not list it`),
    ...(out.dateDrift || []).map((d) => `${d.id}: registry says ${d.registry}, ${name} now says ${d.page}`),
  ];
  return [
    { action: 'resolve', conditionKey: k.input, reason: 'deprecations page parsed' },
    buildAuditAlert({
      conditionKey: k.found,
      rows,
      title: (n) => `${name} shutdown: ${n} model${n === 1 ? '' : 's'} the repo uses ${n === 1 ? 'is' : 'are'} not in the retirement registry`,
      intro: `The daily ${name} retirement audit found ${rows.length} model${rows.length === 1 ? '' : 's'} this repo references that ${name} has scheduled for shutdown and scripts/lib/research-cost.js does not track.`,
      hint: `Move each call site to ${name}'s named replacement (scoring models: A/B first, CLAUDE.md rule 13), then add the id to MODEL_SHUTDOWNS in scripts/lib/research-cost.js; or list it in ACCEPTED_SHUTDOWNS with a card id when the migration needs its own A/B. ${done}`,
      resolveReason: `every referenced ${name} model with a shutdown date is registered`,
    }),
  ];
}

module.exports = { decideProviderRetirementAlerts, retirementKeys: keys };
