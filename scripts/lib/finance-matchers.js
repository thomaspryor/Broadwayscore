/**
 * finance-matchers.js — pure classification + amount-extraction for the BWSC
 * finance tracker. NO network, NO Gmail SDK — takes a normalized receipt
 * `{ from, subject, body, gmailMessageId, date }` and returns a ledger row or a
 * disposition. Kept pure so the real matchers are `require()`d by the unit test
 * (CLAUDE.md Rule 15) — a production match-rule change fails the test.
 *
 * Used by scripts/ingest-finances.js (the Gmail fetch layer lives there).
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const CONFIG_PATH = path.join(__dirname, 'finance-vendors.json');

function loadVendorConfig(configPath = CONFIG_PATH) {
  return JSON.parse(fs.readFileSync(configPath, 'utf8'));
}

// Default FX → USD. Overridable per call so ingest can inject live rates.
// Only currencies we actually see in receipts need entries.
const DEFAULT_FX_TO_USD = { USD: 1, GBP: 1.27, EUR: 1.08 };

const CURRENCY_BY_SYMBOL = { '$': 'USD', 'US$': 'USD', '£': 'GBP', '€': 'EUR' };

function extractStripeAcct(from = '') {
  const m = String(from).match(/acct_[A-Za-z0-9]+/);
  return m ? m[0] : null;
}

// "Anthropic, PBC <invoice+statements@mail.anthropic.com>" → the bare address.
// The Gmail API returns display-name-wrapped From headers; MCP-sourced receipts
// carry bare addresses. Exact-from rules must match both (2026-07-05 backfill:
// 17/1253 booked because every exact-from vendor failed on the wrapped form).
function extractEmailAddress(from = '') {
  const m = String(from).match(/<([^>]+)>/);
  return (m ? m[1] : String(from)).trim();
}

function lc(s) { return String(s || '').toLowerCase(); }

function condContains(haystack, needle) {
  return lc(haystack).includes(lc(needle));
}

/**
 * Does a receipt satisfy a vendor's `match` block? ALL present conditions must
 * hold (AND). Absent conditions are ignored.
 */
function matchesRule(receipt, match) {
  if (!match) return false;
  const from = receipt.from || '';
  const subject = receipt.subject || '';
  const body = receipt.body || '';

  if (match.from && lc(extractEmailAddress(from)) !== lc(match.from)) return false;
  if (match.fromContains && !condContains(from, match.fromContains)) return false;
  if (match.stripeAcct && extractStripeAcct(from) !== match.stripeAcct) return false;
  if (match.subjectContains && !condContains(subject, match.subjectContains)) return false;
  if (match.bodyContains && !condContains(body, match.bodyContains)) return false;
  if (match.subjectContainsAny &&
      !match.subjectContainsAny.some((s) => condContains(subject, s))) return false;
  return true;
}

function isPersonal(receipt, config) {
  const pe = config.personalExclude || {};
  const from = receipt.from || '';
  if ((pe.fromExact || []).some((f) => lc(from) === lc(f))) return true;
  if ((pe.fromContains || []).some((f) => condContains(from, f))) return true;
  return false;
}

/**
 * Classify a receipt against the allowlist.
 * Returns one of:
 *   { disposition: 'personal' }
 *   { disposition: 'ignore', vendorKey }        // e.g. Bright Data summary invoice
 *   { disposition: 'booked', vendorKey, vendor, category, kind, businessPct }
 *   { disposition: 'needs-review' }              // no confident match
 */
function classifyReceipt(receipt, config = loadVendorConfig()) {
  if (isPersonal(receipt, config)) return { disposition: 'personal' };

  for (const v of config.expenseVendors || []) {
    if (matchesRule(receipt, v.match)) {
      if (v.kind === 'ignore') return { disposition: 'ignore', vendorKey: v.key };
      return {
        disposition: 'booked',
        vendorKey: v.key,
        vendor: v.vendor,
        category: v.category,
        kind: v.kind,
        businessPct: v.businessPct,
      };
    }
  }
  return { disposition: 'needs-review' };
}

// Currency token: symbol + amount, cents optional (Bright Data recharges are whole-dollar).
const MONEY = '(US\\$|[$£€])\\s?([0-9][0-9,]*(?:\\.[0-9]{2})?)';

function escapeRe(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

/**
 * Extract the charged amount from receipt text. Tries, in order: vendor-specific
 * anchors (opts.anchors), then "Amount paid", then "Total", then the last
 * currency token (receipts put the total near the end). Returns
 * { amount, currency } or null.
 */
function extractAmount(text = '', opts = {}) {
  const phrases = [...(opts.anchors || []).map(escapeRe), 'amount\\s*paid', 'total'];
  for (const phrase of phrases) {
    const re = new RegExp(phrase + '[^0-9$£€]{0,20}' + MONEY, 'i');
    const m = String(text).match(re);
    if (m) return toMoney(m[1], m[2]);
  }
  const all = [...String(text).matchAll(new RegExp(MONEY, 'gi'))];
  if (all.length) {
    const last = all[all.length - 1];
    return toMoney(last[1], last[2]);
  }
  return null;
}

function toMoney(symbol, digits) {
  const currency = CURRENCY_BY_SYMBOL[symbol] || CURRENCY_BY_SYMBOL[symbol.replace(/\s/g, '')] || 'USD';
  return { amount: parseFloat(digits.replace(/,/g, '')), currency };
}

function toUsd(amount, currency, fx = DEFAULT_FX_TO_USD) {
  const rate = fx[currency];
  if (rate == null) throw new Error(`No FX rate for currency ${currency}`);
  return Math.round(amount * rate * 100) / 100;
}

function extractReceiptNo(text = '') {
  const m = String(text).match(/#\s?([0-9]{3,4}-[0-9]{3,4}(?:-[0-9]{3,4})?)/);
  return m ? m[1] : null;
}

function computeDedupHash({ vendorKey, date, amountUsd, receiptNo }) {
  const basis = `${vendorKey}|${date}|${Number(amountUsd).toFixed(2)}|${receiptNo || ''}`;
  return crypto.createHash('sha256').update(basis).digest('hex').slice(0, 16);
}

/**
 * Turn a raw receipt into a ledger row, or null if it should not be booked
 * (personal / ignore / needs-review / unparseable amount). Idempotency key is
 * the Gmail canonical messageId; dedupHash is the fallback across the
 * MCP→Gmail-API switch.
 */
function toLedgerRow(receipt, config = loadVendorConfig(), fx = DEFAULT_FX_TO_USD) {
  const cls = classifyReceipt(receipt, config);
  if (cls.disposition !== 'booked') return { row: null, disposition: cls.disposition };

  const vcfg = (config.expenseVendors || []).find((v) => v.key === cls.vendorKey) || {};
  const anchors = vcfg.amountAnchor ? [vcfg.amountAnchor] : [];
  const money = extractAmount(receipt.body || receipt.subject || '', { anchors });
  if (!money) return { row: null, disposition: 'amount-unparsed' };

  const amountUsd = toUsd(money.amount, money.currency, fx);
  const receiptNo = extractReceiptNo(receipt.body || receipt.subject || '');
  const businessPct = cls.businessPct == null ? 100 : cls.businessPct;
  const date = (receipt.date || '').slice(0, 10);

  const row = {
    id: receipt.gmailMessageId ? `gmail-${receipt.gmailMessageId}` : null,
    dedupHash: computeDedupHash({ vendorKey: cls.vendorKey, date, amountUsd, receiptNo }),
    date,
    vendorKey: cls.vendorKey,
    vendor: cls.vendor,
    category: cls.category,
    kind: cls.kind,
    amount: money.amount,
    currency: money.currency,
    amountUsd,
    businessPct,
    amountBusiness: Math.round(amountUsd * (businessPct / 100) * 100) / 100,
    source: 'gmail',
    raw: { subject: receipt.subject || '', from: receipt.from || '', receiptNo },
    confidence: 'high',
  };
  return { row, disposition: 'booked' };
}

/**
 * A vendor billed as 'subscription' should charge once per calendar month; the
 * 2nd+ charge in the same month is a credit top-up / early renewal (ScrapingBee
 * did this 5x in Feb 2026). Reclassify those rows to kind 'extra-topup' so
 * exclusion rules and the recurring-vs-usage split can tell them apart.
 * Operates on the WHOLE ledger and is idempotent + self-healing: each run the
 * earliest subscription-family charge of a vendor-month is 'subscription', the
 * rest are 'extra-topup', regardless of what a prior run wrote.
 * Returns the number of rows whose kind changed.
 */
function reclassifyMonthlyDupes(rows) {
  const groups = new Map();
  for (const r of rows) {
    if (r.kind !== 'subscription' && r.kind !== 'extra-topup') continue;
    const k = `${r.vendorKey}|${String(r.date).slice(0, 7)}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(r);
  }
  let changed = 0;
  for (const group of groups.values()) {
    group.sort((a, b) => String(a.date).localeCompare(String(b.date)) || String(a.id).localeCompare(String(b.id)));
    group.forEach((r, i) => {
      const want = i === 0 ? 'subscription' : 'extra-topup';
      if (r.kind !== want) { r.kind = want; changed++; }
    });
  }
  return changed;
}

/**
 * Mark rows matching config.externallyPaid.rules as excluded (paid by someone
 * other than the business). Recomputes the flag on EVERY row each run so a
 * config edit retroactively updates the whole ledger. finance-stats skips
 * excluded rows; they stay in the ledger for audit.
 * Returns { excluded, cleared } counts.
 */
function applyExternallyPaid(rows, config = loadVendorConfig()) {
  const rules = (config.externallyPaid && config.externallyPaid.rules) || [];
  const matches = (r, rule) =>
    r.vendorKey === rule.vendorKey &&
    (!rule.kinds || rule.kinds.includes(r.kind)) &&
    (!rule.before || String(r.date) < rule.before) &&
    (!rule.after || String(r.date) >= rule.after);
  let excluded = 0;
  let cleared = 0;
  for (const r of rows) {
    const rule = rules.find((rl) => matches(r, rl));
    if (rule) {
      if (!r.excluded) excluded++;
      r.excluded = true;
      r.excludedReason = rule.reason || 'paid-externally';
    } else if (r.excluded) {
      delete r.excluded;
      delete r.excludedReason;
      cleared++;
    }
  }
  return { excluded, cleared };
}

module.exports = {
  loadVendorConfig,
  reclassifyMonthlyDupes,
  applyExternallyPaid,
  classifyReceipt,
  matchesRule,
  isPersonal,
  extractStripeAcct,
  extractEmailAddress,
  extractAmount,
  extractReceiptNo,
  toUsd,
  computeDedupHash,
  toLedgerRow,
  DEFAULT_FX_TO_USD,
};
