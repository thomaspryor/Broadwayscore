'use strict';

// BRO-2633: read-only investigation, also included in the daily guard audit.
// Usage: node scripts/lib/check-daily-breaker-pattern.js [--until=YYYY-MM-DD]
//        [--days=7] [--ledger=path]
const { readLedger, daysTripped, DEFAULT_PATH } = require('./breaker-transitions');

function checkDailyBreakerPattern(ledger, {
  untilDay = new Date().toISOString().slice(0, 10), days = 7,
  bdZone = 'web_unlocker2',
} = {}) {
  const end = Date.parse(`${untilDay}T00:00:00Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(untilDay) || !Number.isFinite(end)
      || new Date(end).toISOString().slice(0, 10) !== untilDay) {
    throw new Error('until must be a valid YYYY-MM-DD UTC date');
  }
  if (!Number.isInteger(days) || days < 1 || days > 366) {
    throw new Error('days must be an integer from 1 to 366');
  }
  const sinceDay = new Date(end - (days - 1) * 86400000).toISOString().slice(0, 10);
  const providers = {};
  for (const [name, conditionKey] of Object.entries({
    web: `bd-circuit-breaker-${bdZone}`,
    serp: 'bd-circuit-breaker-serp_api1',
    scrapingdog: 'sd-circuit-breaker',
  })) {
    providers[name] = daysTripped(ledger.rows, { conditionKey, sinceDay, untilDay });
  }
  const sdDays = new Set(providers.scrapingdog.dayList);
  const webAndSd = providers.web.dayList.filter((day) => sdDays.has(day));
  const serpAndSd = providers.serp.dayList.filter((day) => sdDays.has(day));
  const allThree = webAndSd.filter((day) => serpAndSd.includes(day));
  const incomplete = Boolean(ledger.missing || ledger.unreadable || ledger.corruptLines
    || Object.values(providers).some((p) => p.lowerBound));
  const observedDays = [...new Set([...webAndSd, ...serpAndSd])].sort();
  // No trip rows is not evidence that every checker ran or every fetch worked.
  const summary = `${incomplete ? 'Incomplete history; at least ' : 'Recorded '}`
    + `${observedDays.length}/${days} day(s) with BD + Scrapingdog trips`
    + ` (web + SD: ${webAndSd.length}, SERP + SD: ${serpAndSd.length}, all three: ${allThree.length}).`
    + ` Days: ${observedDays.join(', ') || 'none recorded'}.`
    + ' Same-day trips do not prove simultaneous outages or ScrapingBee coverage;'
    + ' missing observations can undercount trips.';
  return {
    window: { sinceDay, untilDay, days }, providers,
    webAndSd, serpAndSd, allThree, observedDays, incomplete, summary,
  };
}

function main(args = process.argv.slice(2)) {
  const options = {};
  let ledgerPath = DEFAULT_PATH;
  for (const arg of args) {
    if (arg.startsWith('--until=')) options.untilDay = arg.slice(8);
    else if (arg.startsWith('--days=')) options.days = Number(arg.slice(7));
    else if (arg.startsWith('--ledger=')) ledgerPath = arg.slice(9);
    else throw new Error(`Unknown argument: ${arg}`);
  }
  console.log(JSON.stringify(checkDailyBreakerPattern(readLedger(ledgerPath), options), null, 2));
}

if (require.main === module) {
  try { main(); } catch (err) { console.error(err.message); process.exitCode = 1; }
}

module.exports = { checkDailyBreakerPattern, main };
