'use strict';
// scripts/lib/mac-retired-reconciler.js — retire Mac launchd jobs from one
// tracked list, config/mac-retired.json (BRO-5085, Mac-to-cloud plan BRO-4622).
//
// WHY ONE RECONCILER, NOT A PER-SCRIPT isRetired() CHECK (plan review
// 2026-10-04): a check inside a script also stops the GitHub Actions copy of
// that same script, and it cannot reach the ~15 plists that exist only in
// ~/Library/LaunchAgents with no script of ours to edit. So retirement is a
// launchd-level action: `launchctl bootout` the label, then rename its plist
// so the next login does not load it again.
//
// Runs from com.broadwayscore.checkout-sync after a successful sync (wired in
// scripts/lib/sync-audit-checkout.sh's EXIT trap via
// scripts/checkout-sync-post.js), so a retirement lands on the Mac within one
// 30-min tick of reaching origin/main, with nobody at the keyboard.
//
// Rules:
//  * checkout-sync itself is NEVER retirable: it is the thing that applies
//    this file, and retiring it would freeze the Mac on the code it had. The
//    same goes for KEEP_NAMES (cookie renewal, the deploy heartbeat), which
//    need the Mac's browser/session and have no cloud replacement. The match
//    is on the label's last dot-segment so a com.bwsc.* twin is refused too.
//  * RETIRE_GRACE_DAYS: an entry is only acted on once it is that many days
//    old. The plan pairs each retirement with a kill-switch marker first
//    (BRO-4638's RETIRED: file) and a quiet period to confirm nothing pages;
//    the grace keeps the plist in place for that window so a revert is just
//    deleting the entry.
//  * Idempotent: a label that is not loaded and has no plist plans nothing,
//    so a second run is a no-op.
//
// planReconcile() is pure (tested by tests/unit/mac-retired-reconciler.test.mjs);
// applyPlan() does the launchctl/fs work.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const SELF_LABEL = 'com.broadwayscore.checkout-sync';
const KEEP_NAMES = new Set(['checkout-sync', 'cookie-renew', 'wsj-cookie-refresh', 'deploy-heartbeat']);
const RETIRE_GRACE_DAYS = 3;
const LABEL_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// `launchctl list` prints "PID\tStatus\tLabel" rows under a header.
function parseLaunchctlList(text) {
  const labels = new Set();
  for (const line of String(text || '').split('\n')) {
    const cols = line.trim().split(/\s+/);
    if (cols.length < 3 || cols[2] === 'Label') continue;
    labels.add(cols.slice(2).join(' '));
  }
  return labels;
}

function refusalReason(label) {
  if (typeof label !== 'string' || !LABEL_RE.test(label)) return 'invalid label';
  if (label === SELF_LABEL) return 'checkout-sync applies this list and is never retirable';
  const last = label.split('.').pop();
  if (KEEP_NAMES.has(last)) return `"${last}" is on the hard-coded keep list`;
  return null;
}

function validateEntry(e) {
  if (!e || typeof e !== 'object') return 'entry is not an object';
  const r = refusalReason(e.label);
  if (r) return r;
  if (typeof e.retiredAt !== 'string' || !DATE_RE.test(e.retiredAt) || Number.isNaN(Date.parse(`${e.retiredAt}T00:00:00Z`))) {
    return 'retiredAt must be YYYY-MM-DD';
  }
  if (!Array.isArray(e.replacedBy)) return 'replacedBy must be an array';
  if (!Array.isArray(e.watchers)) return 'watchers must be an array';
  return null;
}

// config: parsed mac-retired.json. loaded: Set of loaded labels (or raw
// `launchctl list` text). presentPlists: Set of labels whose
// ~/Library/LaunchAgents/<label>.plist exists. now: Date.
// Returns { actions, refused, waiting } — actions in execution order.
function planReconcile({ config, loaded, presentPlists, now = new Date() }) {
  const loadedSet = loaded instanceof Set ? loaded : parseLaunchctlList(loaded);
  const plists = presentPlists instanceof Set ? presentPlists : new Set(presentPlists || []);
  const actions = [];
  const refused = [];
  const waiting = [];
  const seen = new Set();
  const entries = config && Array.isArray(config.entries) ? config.entries : [];
  for (const e of entries) {
    const bad = validateEntry(e);
    if (bad) { refused.push({ label: e && e.label, reason: bad }); continue; }
    if (seen.has(e.label)) continue;
    seen.add(e.label);
    const actAt = Date.parse(`${e.retiredAt}T00:00:00Z`) + RETIRE_GRACE_DAYS * 86400e3;
    const isLoaded = loadedSet.has(e.label);
    const hasPlist = plists.has(e.label);
    if (!isLoaded && !hasPlist) continue;
    if (now.getTime() < actAt) {
      waiting.push({ label: e.label, actFrom: new Date(actAt).toISOString().slice(0, 10) });
      continue;
    }
    if (isLoaded) actions.push({ type: 'bootout', label: e.label });
    if (hasPlist) actions.push({ type: 'move-plist', label: e.label });
  }
  return { actions, refused, waiting };
}

function launchAgentsDir(home = process.env.HOME) {
  return path.join(home, 'Library', 'LaunchAgents');
}

// Rename target that never overwrites an earlier retired copy.
function retiredPlistPath(dir, label, now, exists = fs.existsSync) {
  const base = path.join(dir, `${label}.plist.retired-${now.toISOString().slice(0, 10)}`);
  if (!exists(base)) return base;
  for (let i = 2; ; i++) if (!exists(`${base}.${i}`)) return `${base}.${i}`;
}

function readConfig(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function presentPlistLabels(config, dir) {
  const out = new Set();
  for (const e of (config && config.entries) || []) {
    if (e && typeof e.label === 'string' && LABEL_RE.test(e.label) && fs.existsSync(path.join(dir, `${e.label}.plist`))) out.add(e.label);
  }
  return out;
}

// Executes a plan. Never throws: every outcome is one log line.
function applyPlan(plan, { dir = launchAgentsDir(), uid = process.getuid(), now = new Date(), log = console.log, run = execFileSync } = {}) {
  for (const r of plan.refused) log(`[mac-retired] REFUSED ${r.label}: ${r.reason}`);
  for (const w of plan.waiting) log(`[mac-retired] waiting ${w.label}: grace period, acts from ${w.actFrom}`);
  for (const a of plan.actions) {
    if (a.type === 'bootout') {
      try {
        run('launchctl', ['bootout', `gui/${uid}/${a.label}`], { stdio: 'pipe', timeout: 30000 });
        log(`[mac-retired] bootout ${a.label}: ok`);
      } catch (err) {
        log(`[mac-retired] bootout ${a.label}: FAILED (${String(err.stderr || err.message).trim().split('\n')[0]})`);
      }
    } else if (a.type === 'move-plist') {
      const from = path.join(dir, `${a.label}.plist`);
      try {
        const to = retiredPlistPath(dir, a.label, now);
        fs.renameSync(from, to);
        log(`[mac-retired] moved ${from} -> ${path.basename(to)}`);
      } catch (err) {
        log(`[mac-retired] move ${from}: FAILED (${err.message})`);
      }
    }
  }
}

module.exports = {
  SELF_LABEL, KEEP_NAMES, RETIRE_GRACE_DAYS,
  parseLaunchctlList, refusalReason, validateEntry, planReconcile,
  launchAgentsDir, retiredPlistPath, readConfig, presentPlistLabels, applyPlan,
};
