/**
 * Append-only ledger of cross-market reroutes (data/audit/market-misroutes.json).
 * Kept out of market-routing.js, which is pure (no filesystem I/O). Callers pass
 * recordMarketMisroute as resolveWriteTarget's `recordMisroute`. BRO-2110.
 */
const fs = require('fs');
const path = require('path');

const MARKET_MISROUTES_PATH = path.join(__dirname, '..', '..', 'data', 'audit', 'market-misroutes.json');

// Never throws: an audit write failure must not abort a write batch.
function recordMarketMisroute(entry, ledgerPath = MARKET_MISROUTES_PATH) {
  try {
    const dir = path.dirname(ledgerPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    let list = [];
    if (fs.existsSync(ledgerPath)) {
      try { list = JSON.parse(fs.readFileSync(ledgerPath, 'utf8')); } catch {}
      if (!Array.isArray(list)) list = [];
    }
    list.push({ recordedAt: new Date().toISOString(), ...entry });
    if (list.length > 500) list = list.slice(-500);
    fs.writeFileSync(ledgerPath, JSON.stringify(list, null, 2));
  } catch { /* audit write must not abort batch */ }
}

module.exports = { recordMarketMisroute, MARKET_MISROUTES_PATH };
