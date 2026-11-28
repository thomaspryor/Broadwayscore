'use strict';
/**
 * BRO-7187: a session whose core-data copy predates a retire-show plan sees the
 * retired row still in shows.json, so validate-shows-prebuild.js reports a
 * duplicate the live data no longer has (begin-again-old-regional-2026 was
 * retired by bro-7080 on 2026-11-07; a cloud session on a 2026-11-07 06:56
 * snapshot filed it as a live bug on 2026-11-09). The pending-fix plans live in
 * the public repo, so they are as current as the code: an applied retire-show
 * for a flagged id means the local data is stale, not that the catalog is broken.
 */
const fs = require('fs');
const path = require('path');

const DEFAULT_DIR = path.join(__dirname, '..', '..', 'data', 'pending-fixes');

/**
 * Map of show id -> { plan, executedAt } for every retire-show action an
 * applied (or partial) plan reports as ok, unless a later applied add-show
 * re-added the id (then the row on disk is a real re-add, not stale data).
 * results[i] lines up with plan.actions[i]: execute-approved-fix.js pushes one
 * result per action; the `r.action` check guards any drift.
 */
function appliedRetirements(dir = DEFAULT_DIR) {
  const out = new Map();
  const added = new Map(); // id -> latest executedAt of an ok add-show
  let files = [];
  try { files = fs.readdirSync(dir).filter(f => f.endsWith('.json')); } catch (_) { return out; }
  for (const f of files) {
    let p;
    try { p = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch (_) { continue; }
    if (!p || (p.status !== 'applied' && p.status !== 'partial')) continue;
    const actions = (p.plan && Array.isArray(p.plan.actions)) ? p.plan.actions : [];
    const results = Array.isArray(p.results) ? p.results : [];
    actions.forEach((a, i) => {
      const r = results[i];
      if (!a || !r || r.ok !== true || r.action !== a.type) return;
      const at = p.executedAt || '';
      if (a.type === 'add-show' && a.show && typeof a.show.id === 'string') {
        if (at > (added.get(a.show.id) || '')) added.set(a.show.id, at);
      } else if (a.type === 'retire-show' && typeof a.id === 'string') {
        const prev = out.get(a.id);
        if (!prev || at > (prev.executedAt || '')) out.set(a.id, { plan: f.replace(/\.json$/, ''), executedAt: p.executedAt || null });
      }
    });
  }
  for (const [id, hit] of out) {
    if ((added.get(id) || '') > (hit.executedAt || '')) out.delete(id);
  }
  return out;
}

/** Hint lines for duplicate findings whose ids an applied plan already retired. */
function staleDataHints(findings, dir = DEFAULT_DIR) {
  if (!findings || !findings.length) return [];
  const retired = appliedRetirements(dir);
  const hints = [];
  for (const f of findings) {
    for (const row of [f.show, f.existing]) {
      const hit = row && retired.get(row.id);
      if (hit) hints.push(`${row.id} was retired by ${hit.plan} (${hit.executedAt || 'date unknown'}): this shows.json likely predates that plan. Refresh core data (scripts/setup-local-data.sh, or attach broadway-scorecard-data in cloud) before treating this as a live duplicate.`);
    }
  }
  return [...new Set(hints)];
}

module.exports = { appliedRetirements, staleDataHints };
