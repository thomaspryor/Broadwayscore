'use strict';

/**
 * Pure helpers for impact-payout-readout.js (BRO-4967): explain why some
 * Impact actions carry a real sale Amount but a $0.00 Payout.
 *
 * Output goes to a PUBLIC repo's Actions log, so nothing here may emit a
 * customer, order or click identifier. SubId1 (the visitor's PostHog
 * distinct_id) is only ever reduced to counts and an owner/not-owner flag.
 */

// Enumerated, non-identifying fields worth tallying. Anything not listed is
// reported by NAME only (fieldNames), never by value.
const SAFE_FIELDS = [
  'State',
  'CampaignName',
  'ActionTrackerName',
  'CustomerStatus',
  'ReferringType',
  'EventCode',
  'CustomerCountry',
  'ClearedDate',
  'LockingDate',
];

// Free-text or per-customer fields (promo codes can be single-use, a dispute
// reason can name an order): report only how many orders have a value.
const PRESENCE_ONLY_FIELDS = ['PromoCode', 'DisputeReason', 'ReferringDomain', 'Note'];

function num(v) {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : 0;
}

function isBlank(v) {
  return v === undefined || v === null || v === '';
}

function isZeroPayout(a) {
  return num(a.Amount) > 0 && num(a.Payout) === 0;
}

function tally(actions, field) {
  const out = {};
  for (const a of actions) {
    let v = a[field];
    if (field === 'ClearedDate' || field === 'LockingDate') v = v ? 'set' : 'empty';
    const key = v === undefined || v === null || v === '' ? '(empty)' : String(v).slice(0, 60);
    out[key] = (out[key] || 0) + 1;
  }
  return out;
}

function isoWeek(dateStr) {
  const d = new Date(String(dateStr || '').slice(0, 10) + 'T00:00:00Z');
  if (Number.isNaN(d.getTime())) return '(no date)';
  const day = (d.getUTCDay() + 6) % 7; // Mon=0
  d.setUTCDate(d.getUTCDate() - day);
  return d.toISOString().slice(0, 10);
}

/**
 * @param {object[]} actions Impact Actions.json rows
 * @param {Set<string>} ownerIds PostHog distinct_ids whose person has is_owner=true
 */
function summarizeZeroPayout(actions, ownerIds = new Set()) {
  const rows = actions || [];
  const zero = rows.filter(isZeroPayout);
  const paid = rows.filter((a) => num(a.Payout) > 0);
  // Clawbacks (negative payout), $0 sales and anything else: shown, not dropped.
  const other = rows.filter((a) => !isZeroPayout(a) && !(num(a.Payout) > 0));

  const describe = (group) => {
    const subCounts = new Map();
    let noSub = 0;
    let ownerOrders = 0;
    for (const a of group) {
      const sub = a.SubId1 || '';
      if (!sub) { noSub += 1; continue; }
      subCounts.set(sub, (subCounts.get(sub) || 0) + 1);
      if (ownerIds.has(sub)) ownerOrders += 1;
    }
    const perVisitor = [...subCounts.values()].sort((x, y) => y - x);
    const byWeek = {};
    for (const a of group) {
      const w = isoWeek(a.EventDate);
      byWeek[w] = byWeek[w] || { orders: 0, sales: 0, payout: 0 };
      byWeek[w].orders += 1;
      byWeek[w].sales += num(a.Amount);
      byWeek[w].payout += num(a.Payout);
    }
    const fields = {};
    for (const f of SAFE_FIELDS) fields[f] = tally(group, f);
    for (const f of PRESENCE_ONLY_FIELDS) {
      fields[`${f} (presence only)`] = tally(group.map((a) => ({ v: isBlank(a[f]) ? '(empty)' : 'has value' })), 'v');
    }
    // Was the commission $0 from the start, or reduced afterwards? A field the
    // payload lacks is '(missing)', never read as an answer.
    const sign = (a, f, neg, pos, zero) => (isBlank(a[f]) ? '(missing)' : num(a[f]) < 0 ? neg : num(a[f]) > 0 ? pos : zero);
    fields['IntendedPayout'] = tally(group.map((a) => ({ v: sign(a, 'IntendedPayout', 'negative', '>0', '0') })), 'v');
    fields['DeltaPayout'] = tally(group.map((a) => ({ v: sign(a, 'DeltaPayout', 'reduced', 'raised', 'unchanged') })), 'v');
    fields['DeltaAmount'] = tally(group.map((a) => ({ v: sign(a, 'DeltaAmount', 'reduced', 'raised', 'unchanged') })), 'v');
    return {
      orders: group.length,
      sales: group.reduce((s, a) => s + num(a.Amount), 0),
      payout: group.reduce((s, a) => s + num(a.Payout), 0),
      distinctVisitors: subCounts.size,
      ordersWithoutVisitorId: noSub,
      ordersFromOwner: ownerOrders,
      ordersPerVisitorTop: perVisitor.slice(0, 5),
      byWeek,
      fields,
    };
  };

  const fieldNames = [...new Set(rows.flatMap((a) => Object.keys(a)))].sort();
  return { total: rows.length, zero: describe(zero), paid: describe(paid), other: describe(other), fieldNames };
}

function fmtMoney(n) {
  return `$${n.toFixed(2)}`;
}

function renderMarkdown(summary, { windowLabel, pages, incomplete, singlePageCount }) {
  const lines = [];
  lines.push(`# Impact $0-commission readout (${windowLabel})`);
  lines.push('');
  lines.push(`${summary.total} actions fetched over ${pages} page(s).`);
  if (incomplete) lines.push('', `**INCOMPLETE: stopped paging with more pages left; every count below is a lower bound.**`);
  if (Number.isInteger(singlePageCount)) {
    lines.push('', singlePageCount < summary.total
      ? `**Revenue code check: affiliate-stats fetchImpact (one request, Impact's default page size) returned ${singlePageCount} of ${summary.total} actions, so the weekly report, accruals and health checks undercount.**`
      : `Revenue code check: affiliate-stats fetchImpact returned all ${singlePageCount} actions in one request (no truncation).`);
  }
  lines.push('');
  for (const [label, g] of [['$0 payout, real sale', summary.zero], ['Paid', summary.paid], ['Other (clawbacks, $0 sales)', summary.other]]) {
    if (label.startsWith('Other') && g.orders === 0) continue;
    lines.push(`## ${label}: ${g.orders} orders, ${fmtMoney(g.sales)} sales, ${fmtMoney(g.payout)} commission`);
    lines.push('');
    lines.push(`- Distinct visitors (SubId1): ${g.distinctVisitors}; orders with no SubId1: ${g.ordersWithoutVisitorId}; orders from the owner's own visitor IDs: ${g.ordersFromOwner}`);
    lines.push(`- Orders per visitor, top 5: ${g.ordersPerVisitorTop.join(', ') || '(none)'}`);
    lines.push('');
    lines.push('| Week of | Orders | Sales | Commission |');
    lines.push('| --- | --- | --- | --- |');
    for (const w of Object.keys(g.byWeek).sort()) {
      const r = g.byWeek[w];
      lines.push(`| ${w} | ${r.orders} | ${fmtMoney(r.sales)} | ${fmtMoney(r.payout)} |`);
    }
    lines.push('');
    for (const [f, counts] of Object.entries(g.fields)) {
      const entries = Object.entries(counts).sort((x, y) => y[1] - x[1]);
      if (entries.length === 1 && entries[0][0] === '(empty)') continue;
      lines.push(`- **${f}**: ${entries.map(([k, v]) => `${k} ×${v}`).join('; ')}`);
    }
    lines.push('');
  }
  lines.push(`Fields present on actions (names only): ${summary.fieldNames.join(', ')}`);
  return lines.join('\n');
}

module.exports = { summarizeZeroPayout, renderMarkdown, isZeroPayout, isoWeek, SAFE_FIELDS, PRESENCE_ONLY_FIELDS };
