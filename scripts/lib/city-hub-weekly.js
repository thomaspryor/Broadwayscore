'use strict';

// venue-write-guard-ok: CLASS_OF maps audit codes (one is 'venue') to classes; no venue data is written
/**
 * BRO-7291 class 8: the weekly dual-model city-hub audit's decisions. Pure; no I/O.
 * The driver is scripts/city-hub-weekly-audit.js (audit-review-quality.yml, Tuesdays).
 *
 * A scorecard flag becomes a FINDING when it is one of the six BRO-7256 problem classes and is believable on its own:
 * a local (deterministic) check, or a model check that BOTH model families raised for the same item and code.
 * A finding is NEW when last week's run did not already report it and triage did not already settle it.
 * Deterministic findings carry an exact `fix` and become pending-fix plan actions; the rest go on one card per city.
 */

/** code -> class (1 stale closing, 2 byline, 3 wrong production/venue/roundup, 4 title, 6 run dates). Class 5 is the provenance check. */
const CLASS_OF = {
  'review-text-later-closing': 1, 'review-text-later-closing-unconfirmed': 1, 'closing-date': 1,
  byline: 2,
  'wrong-production': 3, 'non-review:roundup': 3, 'page-not-this-production': 3, 'review-other-venue': 3, 'venue-contradicted': 3, venue: 3,
  'title-spelling': 4, title: 4,
  'opening-date': 6, 'preview-date': 6,
};
const CLASS_NAME = { 1: 'stale closing date', 2: 'wrong critic byline', 3: 'wrong production / venue / roundup', 4: 'title typo', 5: 'unprovenanced hand-entered row', 6: 'wrong run dates' };

const keyOf = (f) => `${f.kind}:${f.id}:${f.code}`;

/**
 * @param {object[]} flags   scorecard.flags ({ kind, id, label, model, code, detail, fix? })
 * @returns {object[]} findings ({ key, cls, kind, id, label, code, detail, models, fix })
 */
function findingsFromFlags(flags) {
  const by = new Map();
  for (const f of flags || []) {
    const cls = CLASS_OF[f.code];
    if (!cls) continue;
    const k = keyOf(f);
    const cur = by.get(k) || { key: k, cls, kind: f.kind, id: f.id, label: f.label, code: f.code, detail: f.detail, models: [], fix: null };
    if (!cur.models.includes(f.model)) cur.models.push(f.model);
    if (f.fix && !cur.fix) cur.fix = f.fix;
    by.set(k, cur);
  }
  return [...by.values()].filter((x) => x.models.includes('local') || (x.models.includes('gemini') && x.models.includes('openai')));
}

/**
 * Findings not already reported (`seen`: keys from last week) and not settled by triage
 * (triage.items keyed `${kind}:${id}:${code}` or `${kind}:${id}`, verdict false-positive or confirmed + fixed).
 */
function newFindings(findings, seen, triage) {
  const items = (triage && triage.items) || {};
  const prior = new Set(seen || []);
  return findings.filter((f) => {
    if (prior.has(f.key)) return false;
    // a verdict on this exact check (`kind:id:code`) wins over one on the whole item (`kind:id`)
    const t = items[f.key] || items[`${f.kind}:${f.id}`];
    return !(t && (t.verdict === 'false-positive' || (t.verdict === 'confirmed' && t.status === 'fixed')));
  });
}

/**
 * Pending-fix plan actions (new-fix-plan.js --actions format; oldValue is filled in by new-fix-plan) for the
 * deterministic findings that carry an exact fix. Only shows.json fields of the finding's own show.
 */
function planActions(findings) {
  const out = [];
  for (const f of findings) {
    if (!f.fix || f.kind !== 'show' || !f.models.includes('local')) continue;
    out.push({ type: 'data-edit', file: 'shows.json', showId: f.id, field: f.fix.field, newValue: f.fix.value, description: `shows.json: ${f.id}.${f.fix.field} (${CLASS_NAME[f.cls]}: ${f.detail})`.slice(0, 300) });
    if (f.fix.sourceField && f.fix.source) out.push({ type: 'data-edit', file: 'shows.json', showId: f.id, field: f.fix.sourceField, newValue: f.fix.source, description: `shows.json: ${f.id}.${f.fix.sourceField}` });
  }
  return out;
}

/** ISO week label (YYYY-Www) of a YYYY-MM-DD date: one card per city per week. */
function isoWeek(day) {
  const d = new Date(`${day}T00:00:00Z`);
  const dow = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dow);
  const y = d.getUTCFullYear();
  const wk = Math.ceil(((d - Date.UTC(y, 0, 1)) / 86400000 + 1) / 7);
  return `${y}-W${String(wk).padStart(2, '0')}`;
}

/** Title + markdown body of the city's weekly card. Returns null when there is nothing new. */
function cardFor(city, week, fresh, { planId = null, provenance = null } = {}) {
  const prov = provenance && provenance.unprovenanced ? provenance.unprovenanced : 0;
  if (!fresh.length && !prov) return null;
  const lines = [`## Problem`, `The weekly dual-model audit of the ${city} hub found ${fresh.length + (prov ? 1 : 0)} new problem(s) in the BRO-7256 classes.`, ''];
  for (const cls of [1, 2, 3, 4, 6]) {
    const rows = fresh.filter((f) => f.cls === cls);
    if (!rows.length) continue;
    lines.push(`### Class ${cls}: ${CLASS_NAME[cls]} (${rows.length})`);
    for (const f of rows.slice(0, 25)) lines.push(`- ${f.label} (\`${f.id}\`, ${f.code}, ${f.models.join('+')}): ${String(f.detail || '').slice(0, 240)}${f.fix ? ' [in auto-plan]' : ''}`);
    if (rows.length > 25) lines.push(`- ...and ${rows.length - 25} more in data/audit/city-hub-dual/${city}/weekly.json`);
    lines.push('');
  }
  if (prov) lines.push(`### Class 5: ${CLASS_NAME[5]} (${prov})`, '`node scripts/check-manual-entry-provenance.js` lists them: add a `--reason` or remove the row.', '');
  lines.push('## Resolution steps');
  if (planId) lines.push(`1. The deterministic rows are in pending-fix plan \`${planId}\`: check each against its source, then apply it with execute-approved-fix.yml.`);
  lines.push(`${planId ? 2 : 1}. For the other rows, open the source; a confirmed problem is fixed through a pending-fix plan, a false lead is recorded in data/audit/city-hub-dual/${city}/triage.json (verdict false-positive) so it never comes back.`, '');
  // --open ignores last week's seen list, so the check only passes once each finding is fixed or triaged false-positive
  lines.push('## Acceptance criteria', `- \`node scripts/city-hub-weekly-audit.js --city=${city} --no-llm --dry-run --open\` exits 0 (no unsettled findings).`, '', `VERIFY: node scripts/city-hub-weekly-audit.js --city=${city} --no-llm --dry-run --open`, '', `_Auto-filed by scripts/city-hub-weekly-audit.js (${week})._`);
  return { title: `City hub audit ${city} ${week}: ${fresh.length + (prov ? 1 : 0)} new finding(s)`, body: lines.join('\n') };
}

// BRO-7319: finding keys to persist as "seen". When the card could not be filed (Linear 429), the
// fresh findings stay unseen so the next weekly run raises them again instead of losing them.
function keysToPersist(findings, fresh, carded) {
  const hold = carded ? new Set() : new Set((fresh || []).map((f) => f.key));
  return findings.map((f) => f.key).filter((k) => !hold.has(k)).sort();
}

module.exports = { keysToPersist, CLASS_OF, CLASS_NAME, keyOf, findingsFromFlags, newFindings, planActions, isoWeek, cardFor };
