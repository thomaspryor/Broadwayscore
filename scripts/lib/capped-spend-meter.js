'use strict';
/**
 * capped-spend-meter.js (BRO-7527): a hard spend cap for paid eval runs.
 * Every call is priced at `capModel`'s rate (pick the dearest model in the
 * run so the cap never under-counts); list price per model is tracked apart.
 * canSpend() keeps room for `concurrency` calls already in flight, each as
 * large as the biggest call seen so far.
 */
const { estimateUSD } = require('./autonomous-budget');

function createMeter(capUsd, { capModel, concurrency = 4, firstCallUsd = 0.05 } = {}) {
  if (!capModel) throw new Error('createMeter: capModel is required');
  const t = { capUsd, capPricedUsd: 0, listUsd: 0, calls: 0, maxCallUsd: firstCallUsd, byModel: {} };
  return {
    totals: t,
    canSpend: () => t.capPricedUsd + concurrency * t.maxCallUsd < capUsd,
    record(usage, model) {
      const inT = (usage && (usage.input_tokens || 0) + (usage.cache_creation_input_tokens || 0) + (usage.cache_read_input_tokens || 0)) || 0;
      const outT = (usage && usage.output_tokens) || 0;
      t.calls += 1;
      const callUsd = estimateUSD(capModel, inT, outT);
      t.capPricedUsd += callUsd;
      if (callUsd > t.maxCallUsd) t.maxCallUsd = callUsd;
      t.listUsd += estimateUSD(model, inT, outT);
      const m = (t.byModel[model] ||= { calls: 0, inputTokens: 0, outputTokens: 0 });
      m.calls += 1; m.inputTokens += inT; m.outputTokens += outT;
    },
  };
}

module.exports = { createMeter };
