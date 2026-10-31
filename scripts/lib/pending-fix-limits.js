'use strict';
// Shared limits for data/pending-fixes plans. execute-approved-fix.js refuses
// a plan past MAX_PLAN_ACTIONS at apply time; tests/unit/pending-fix-plans.test.mjs
// checks every pending plan against the same number so an oversized plan fails
// before it lands instead of after (BRO-4492: a 41-action plan landed, then the
// apply run refused it and had to be split).
const MAX_PLAN_ACTIONS = 25;

module.exports = { MAX_PLAN_ACTIONS };
