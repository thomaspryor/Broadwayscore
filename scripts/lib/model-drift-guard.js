#!/usr/bin/env node
// scripts/lib/model-drift-guard.js — pure decision function + file-mutation
// CLI for the ConfigChange hook at ~/.claude/hooks/model-drift-guard.sh.
//
// Incident (task #1352, 2026-08-12): ~/.claude/settings.json's top-level
// "model" field is GLOBAL shared state — /model in ANY session rewrites it
// for every future interactive session. With ~20 parallel sessions this is
// unguarded shared mutable state. It drifted from "opus" to
// "claude-fable-5[1m]" for ~40 min with no owner action (git commit
// efc3a3f fixed it back to "opusplan"). Fable is the priciest tier; the
// [1m] suffix also silently moved a SEPARATE spend guard's trigger
// (context-budget-nudge.sh) from 140K to 700K tokens (fixed in 54d8702) —
// so one accidental default drift defeats two unrelated cost controls.
//
// EMPIRICALLY VERIFIED (not assumed — see card review) that the ConfigChange
// hook event observes /model's write path: ~/.claude/audit-config-changes.jsonl
// carries a source="user_settings" row per active session for every
// settings.json content change, and the hash transitions line up exactly
// with the known opus->fable->opusplan history. Firing happens AFTER the
// write lands (a reconcile-after-write pattern, not a pre-write block) —
// ConfigChange cannot block the tool call that caused it, so this module
// corrects the file back rather than preventing the write.
//
// ALLOWLIST, NOT DENYLIST (second-opinion review before implementation):
// the incident happened because "fable" wasn't on any prior forbidden list.
// A denylist can only block names already known to be expensive — it
// guarantees missing the next unnamed expensive tier. An allowlist of
// known-safe tiers fails closed on anything unrecognized, including a
// currently-safe tier wrapped in a "[1m]" (or any other bracketed) suffix.
//
// NO AUTO-RATCHET: `intendedDefault` (the value to restore TO on a
// violation) is read from a small state file and only ever written by a
// human/deliberate edit — never updated automatically from an observed
// allowed /model value. An earlier draft of this guard updated it on every
// allowed value seen; review flagged that as gameable (a session setting a
// transient-but-allowed value moments before the real drift would silently
// become the new restore target) and pointless (the guard only needs ONE
// safe fallback to restore to, not a live mirror of whatever was last set).
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DEFAULT_FALLBACK_MODEL = 'opusplan';

const SAFE_MODEL_RE = /^(?:claude-)?(?:sonnet|opus|haiku|opusplan)[\w.-]*$/i;

function isDisallowedModelDefault(value) {
  if (typeof value !== 'string') return false;
  const v = value.trim();
  if (!v) return false;
  return !SAFE_MODEL_RE.test(v);
}

// Pure decision, no fs. `intendedDefault` is the single recorded source of
// truth for the safe restore target (falls back to DEFAULT_FALLBACK_MODEL
// if unset or itself somehow disallowed).
function decideModelDriftAction({ currentModel, intendedDefault }) {
  if (!isDisallowedModelDefault(currentModel)) {
    return { block: false, restoreValue: null, reason: null };
  }
  const fallback =
    intendedDefault && !isDisallowedModelDefault(intendedDefault)
      ? intendedDefault
      : DEFAULT_FALLBACK_MODEL;
  return {
    block: true,
    restoreValue: fallback,
    reason:
      `Global model default "${currentModel}" is disallowed (fails the safe-tier allowlist — ` +
      `expensive/unrecognized tier or a "[1m]"-style context-window suffix). Restoring to "${fallback}".`,
  };
}

module.exports = {
  SAFE_MODEL_RE,
  DEFAULT_FALLBACK_MODEL,
  isDisallowedModelDefault,
  decideModelDriftAction,
};

// ── CLI (file mutation — only reached when invoked directly by the hook) ──
if (require.main === module) {
  const args = process.argv.slice(2);
  const sub = args[0];
  const opts = {};
  for (const a of args.slice(1)) {
    const m = a.match(/^--([\w-]+)=(.*)$/);
    if (m) opts[m[1]] = m[2];
  }

  if (sub !== 'apply' || !opts.settings) {
    process.stderr.write(
      'usage: model-drift-guard.js apply --settings=<path> [--session-id=<id>] [--state=<path>] [--audit=<path>]\n'
    );
    process.exit(0);
  }

  const settingsPath = opts.settings;
  const sessionId = opts['session-id'] || 'unknown';
  const home = process.env.HOME || path.dirname(path.dirname(settingsPath));
  // --state/--audit overrides exist so this can be exercised end-to-end
  // against a scratch settings.json without touching the real
  // ~/.claude/model-drift-guard-state.json or audit log (see
  // tests/unit/model-default-guard.test.mjs's CLI-integration cases).
  const stateFile = opts.state || path.join(home, '.claude', 'model-drift-guard-state.json');
  const auditFile = opts.audit || path.join(home, '.claude', 'audit-config-changes.jsonl');

  try {
    if (!fs.existsSync(settingsPath)) process.exit(0);

    const rawBefore = fs.readFileSync(settingsPath, 'utf8');
    const hashBefore = crypto.createHash('sha256').update(rawBefore).digest('hex');
    const parsed = JSON.parse(rawBefore);
    const currentModel = parsed.model;

    let intendedDefault = null;
    try {
      intendedDefault = JSON.parse(fs.readFileSync(stateFile, 'utf8')).intendedDefault || null;
    } catch {
      // Bootstrap: seed the state file so there's one recorded place for the
      // safe restore target (card #1352 requirement) — the owner can edit
      // this file directly to change it; the guard never rewrites it itself.
      try {
        fs.writeFileSync(
          stateFile,
          JSON.stringify({ intendedDefault: DEFAULT_FALLBACK_MODEL }, null, 2) + '\n'
        );
      } catch {
        // non-fatal — falls through to the DEFAULT_FALLBACK_MODEL constant
      }
    }

    const decision = decideModelDriftAction({ currentModel, intendedDefault });
    if (!decision.block) process.exit(0);

    // Optimistic concurrency: ~20 sessions can be writing settings.json at
    // once (card #1352 review, correctness blocker #1). Re-check the file
    // is still exactly what we read before mutating it — if another
    // process wrote in the meantime, skip this round rather than clobbering
    // it; that write's own ConfigChange firing will re-evaluate.
    const rawNow = fs.readFileSync(settingsPath, 'utf8');
    const hashNow = crypto.createHash('sha256').update(rawNow).digest('hex');
    if (hashNow !== hashBefore) process.exit(0);

    const restored = Object.assign({}, parsed, { model: decision.restoreValue });
    const tmp = `${settingsPath}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(restored, null, 2) + '\n');
    fs.renameSync(tmp, settingsPath);

    try {
      fs.appendFileSync(
        auditFile,
        JSON.stringify({
          ts: new Date().toISOString(),
          session_id: sessionId,
          event: 'model_drift_revert',
          rejected_value: currentModel,
          restored_value: decision.restoreValue,
          file_path: settingsPath,
        }) + '\n'
      );
    } catch {
      // audit logging is best-effort — never block the revert on it
    }

    process.stderr.write(decision.reason + '\n');
    process.exit(2);
  } catch (e) {
    // Fail open on any infra problem (bad JSON, permissions, etc.) — only a
    // confirmed, successfully-reverted violation should ever exit 2.
    process.stderr.write(`model-drift-guard: skipped (${e.message})\n`);
    process.exit(0);
  }
}
