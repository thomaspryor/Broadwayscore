'use strict';

/**
 * press-night-audit-note.js — make the morning-after "Opening-night audit YYYY-MM-DD" card read the
 * press-night record (BRO-6067). The audit is a cloud routine whose prompt lives outside this repo, so
 * the one place every such card passes through, scripts/linear-brain.js create/update, annotates it:
 * when any record for the night is FAIL or UNKNOWN the card says so at the top, and "no fixes needed"
 * is rewritten so a routine log cannot call a failed night clean (BRO-6057 did, for a night whose bulk
 * reviews went live ~85 min after the embargo).
 *
 * Pure apart from reading the committed records (and shows.json for nights with no record at all).
 */
const fs = require('fs');
const path = require('path');
const { evaluateCheck } = require('./press-night-record');

const TITLE_RE = /^Opening-night audit (\d{4}-\d{2}-\d{2})\b/;
const CLEAN_RE = /\b(no fixes? (?:needed|required)|nothing to fix|no action needed)\b/gi;
const MARKER = 'PRESS-NIGHT RECORD NOT PASSING';
// Markets the probe covers (press-night-probe.yml via probeDue): a show of these opening that night
// with no record is itself an UNKNOWN (the probe never ran).
const PROBED_MARKETS = new Set(['broadway', 'west-end']);

function auditDateFromTitle(title) {
  const m = TITLE_RE.exec(String(title || ''));
  return m ? m[1] : null;
}

function dayBefore(ymd) {
  const d = new Date(`${ymd}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

/** The press night an audit dated D covers: openings of D-1. D's own night has not happened yet. */
function auditNights(auditDate) {
  return auditDate ? [dayBefore(auditDate)] : [];
}

function pressNightResults({ nights, dir, shows = [] }) {
  const out = [];
  let files = [];
  try { files = fs.readdirSync(dir); } catch (_) { files = []; }
  const seen = new Set();
  for (const night of nights) {
    for (const f of files.filter((x) => x.endsWith(`-${night}.json`)).sort()) {
      let rec = null;
      try { rec = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch (_) { rec = null; }
      const showId = rec ? rec.showId : f.slice(0, -`-${night}.json`.length);
      seen.add(`${showId}|${night}`);
      out.push({ showId, night, ...evaluateCheck(rec) });
    }
    for (const s of shows) {
      const id = s && (s.id || s.slug);
      if (!id || s.openingDate !== night || !PROBED_MARKETS.has(s.category) || seen.has(`${id}|${night}`)) continue;
      out.push({ showId: id, night, ...evaluateCheck(null) });
    }
  }
  return out;
}

function summaryBlock(notPassing) {
  const lines = [`${MARKER} (node scripts/press-night-record.js --show=ID --night=DATE --check). Do not log this night as clean until each line is explained or fixed:`];
  for (const r of notPassing) {
    const bad = r.gates.filter((g) => g.required && g.status !== 'pass').map((g) => `${g.name} ${g.status.toUpperCase()}: ${g.detail}`);
    lines.push(`- ${r.showId} ${r.night}: ${r.verdict}. ${bad.join(' | ')}`);
    if (r.release) lines.push(`  The lane found the first review at ${r.release.observedAt}, ${r.release.lateMin} min after the assumed embargo ${r.release.assumedAt}; the verdict uses the assumed one. Measured from the observed release: ${r.release.observed.verdict}.`);
  }
  return lines.join('\n');
}

/**
 * @returns {{text:string, notPassing:Array, changed:boolean}}
 */
function annotateAuditText(title, text, { dir, shows = [], onlyIfCleanClaim = false } = {}) {
  const body = String(text || '');
  const date = auditDateFromTitle(title);
  if (!date || body.includes(MARKER)) return { text: body, notPassing: [], changed: false };
  // Follow-up comments ("closing, done") get the banner only when they call the night clean.
  if (onlyIfCleanClaim && !new RegExp(CLEAN_RE.source, 'i').test(body)) return { text: body, notPassing: [], changed: false };
  const results = pressNightResults({ nights: auditNights(date), dir, shows });
  const notPassing = results.filter((r) => r.verdict !== 'PASS');
  if (!notPassing.length) return { text: body, notPassing, changed: false };
  const rewritten = body.replace(CLEAN_RE, 'NOT clean: the press-night record is FAIL/UNKNOWN (see the top of this note)');
  return { text: `${summaryBlock(notPassing)}\n\n${rewritten}`.trim(), notPassing, changed: true };
}

/** linear-brain.js entry: never throws (an advisory must not block filing). */
function annotateAuditCard(title, text, root, opts = {}) {
  if (!auditDateFromTitle(title)) return { text: String(text || ''), notPassing: [], changed: false };
  try {
    const dir = path.join(root, 'data', 'audit', 'press-night');
    let shows = [];
    try { shows = JSON.parse(fs.readFileSync(path.join(root, 'data', 'shows.json'), 'utf8')).shows || []; } catch (_) { shows = []; }
    return annotateAuditText(title, text, { dir, shows, ...opts });
  } catch (e) {
    return { text: String(text || ''), notPassing: [], changed: false, error: e.message };
  }
}

module.exports = { auditDateFromTitle, auditNights, pressNightResults, annotateAuditText, annotateAuditCard, MARKER };
