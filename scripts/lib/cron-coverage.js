'use strict';

/**
 * Pure helpers for the scheduled-workflow coverage gate in
 * audit-cron-health-coverage.js.
 *
 * Every scheduled (cron) workflow must be EITHER monitored in check-cron-health.yml's
 * CRITICAL_CRONS (real-time paging) OR listed in .cron-health-exempt.txt (digest-only /
 * low-stakes). A scheduled workflow in NEITHER has zero monitoring and can die silently —
 * the gap that hid process-feedback.yml being disabled for 15 days (2026-06-11..26).
 */

// Does a workflow YAML body declare a scheduled (cron) trigger?
// Strips comment-only lines first so a commented `# - cron: ...` under a live `schedule:`
// key isn't mistaken for a trigger. Matches a list-item cron with ANY value (quoted OR
// unquoted) — an unquoted-but-valid cron (`cron: 30 5 1,15 * *`) must NOT evade the gate.
function isScheduledWorkflow(yamlText) {
  if (!yamlText) return false;
  const body = String(yamlText)
    .split('\n')
    .filter(line => !line.trim().startsWith('#'))
    .join('\n');
  return /^\s*schedule:/m.test(body) && /-\s*cron:\s*\S/.test(body);
}

// Parse a .cron-health-exempt.txt body into a Set of workflow filenames.
// The filename is the first pipe-separated field; `#` comments and blank lines ignored; trailing whitespace trimmed.
function parseExemptList(text) {
  const out = new Set();
  for (const raw of (text || '').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    out.add(line.split('|')[0].trim());
  }
  return out;
}

/**
 * Scheduled workflows covered by neither CRITICAL_CRONS nor the exempt list.
 * @param {string[]} scheduled - filenames of workflows with a cron trigger
 * @param {Set<string>} covered - filenames present in CRITICAL_CRONS
 * @param {Set<string>} exempt  - filenames present in the exempt list
 * @returns {string[]} sorted uncovered filenames
 */
function findUncoveredScheduled(scheduled, covered, exempt) {
  return scheduled
    .filter(f => !covered.has(f) && !exempt.has(f))
    .sort();
}

/**
 * Exempt entries that are stale — listed but no longer a scheduled workflow (deleted
 * or de-scheduled), or also in CRITICAL_CRONS (double-listed). Keeps the allowlist honest.
 * @returns {{ notScheduled: string[], alsoCovered: string[] }}
 */
function findStaleExempt(exempt, scheduledSet, covered) {
  const notScheduled = [], alsoCovered = [];
  for (const f of exempt) {
    if (!scheduledSet.has(f)) notScheduled.push(f);
    else if (covered.has(f)) alsoCovered.push(f);
  }
  return { notScheduled: notScheduled.sort(), alsoCovered: alsoCovered.sort() };
}

function parseField(field, min, max) {
  if (field === '*') return null; // wildcard
  const out = new Set();
  for (const part of field.split(',')) {
    if (part.startsWith('*/')) {
      const step = parseInt(part.slice(2), 10);
      for (let v = min; v <= max; v += step) out.add(v);
    } else if (part.includes('-')) {
      const [a, b] = part.split('-').map(Number);
      for (let v = a; v <= b; v++) out.add(v);
    } else {
      out.add(parseInt(part, 10));
    }
  }
  return out;
}

// Compute worst-case gap (hours) across a 60-day window, treating multiple crons as a union.
function worstGapHours(cronExprs, windowDays = 60) {
  const matchers = cronExprs.map(expr => {
    const [m, h, dom, mon, dow] = expr.split(/\s+/);
    return {
      m: parseField(m, 0, 59),
      h: parseField(h, 0, 23),
      dom: parseField(dom, 1, 31),
      mon: parseField(mon, 1, 12),
      dow: parseField(dow, 0, 6),
    };
  });

  const fires = [];
  const start = new Date(Date.UTC(2026, 0, 5, 0, 0, 0)); // Mon 2026-01-05 — neutral start
  const WINDOW_MIN = windowDays * 24 * 60;

  for (let i = 0; i < WINDOW_MIN; i++) {
    const t = new Date(start.getTime() + i * 60_000);
    const tm = t.getUTCMinutes(), th = t.getUTCHours();
    const tdom = t.getUTCDate(), tmon = t.getUTCMonth() + 1, tdow = t.getUTCDay();
    for (const c of matchers) {
      if (c.m && !c.m.has(tm)) continue;
      if (c.h && !c.h.has(th)) continue;
      if (c.mon && !c.mon.has(tmon)) continue;
      // cron oddity: when dom and dow are both set, they're an OR
      const domOk = !c.dom || c.dom.has(tdom);
      const dowOk = !c.dow || c.dow.has(tdow);
      if (c.dom && c.dow) {
        if (!domOk && !dowOk) continue;
      } else {
        if (!domOk || !dowOk) continue;
      }
      fires.push(t.getTime());
      break;
    }
  }

  if (fires.length < 2) return null; // can't determine (seasonal cron or never fires)

  let maxGap = 0;
  for (let i = 1; i < fires.length; i++) {
    maxGap = Math.max(maxGap, fires[i] - fires[i - 1]);
  }
  return Math.round(maxGap / 3_600_000);
}

// The paging workflow remains canonical for paging entries and thresholds.
function parsePagingCrons(text) {
  return [...text.matchAll(/"([a-z0-9-]+\.yml)\|(\d+)\|([^"|]+)(?:\|(\d+-\d+))?"/g)]
    .map(([, workflow, hours, name, activeMonths]) => ({ workflow, maxHours: Number(hours), name, activeMonths }));
}

function parseExemptEntries(text) {
  return (text || '').split('\n').map(line => line.trim())
    .filter(line => line && !line.startsWith('#'))
    .map(line => {
      const [workflow, mode, hours, reason, activeMonths, ...extra] = line.split('|').map(part => part.trim());
      return { workflow, mode, maxHours: Number(hours), reason, activeMonths, extra };
    });
}

function loadDigestCrons(root) {
  const fs = require('fs');
  const path = require('path');
  const paging = parsePagingCrons(fs.readFileSync(path.join(root, '.github/workflows/check-cron-health.yml'), 'utf8'));
  const exempt = parseExemptEntries(fs.readFileSync(path.join(root, '.cron-health-exempt.txt'), 'utf8'));
  return [...paging, ...exempt.filter(entry => entry.mode === 'digest').map(entry => ({
    workflow: entry.workflow, maxHours: entry.maxHours, name: entry.workflow === 'audit-reverse-discovery.yml' ? 'Reverse Discovery' : entry.reason?.split(':')[0] || entry.workflow, activeMonths: entry.activeMonths,
  }))];
}

function validateExemptEntries(entries, digest) {
  const monitored = new Set(digest.map(entry => entry.workflow));
  const seen = new Set();
  const errors = [];
  for (const entry of entries) {
    if (seen.has(entry.workflow)) errors.push(`${entry.workflow}: duplicate exemption`);
    seen.add(entry.workflow);
    if (entry.extra?.length || !/^[a-z0-9-]+\.yml$/.test(entry.workflow) || !entry.reason ||
        !['digest', 'low-stakes'].includes(entry.mode)) {
      errors.push(`${entry.workflow}: requires explicit digest or low-stakes classification and justification`);
    }
    if (entry.mode === 'digest' && (!Number.isFinite(entry.maxHours) || entry.maxHours <= 0 || !monitored.has(entry.workflow))) {
      errors.push(`${entry.workflow}: digest coverage claimed without a valid digest monitor`);
    }
    if (entry.activeMonths && !/^(?:[1-9]|1[0-2])-(?:[1-9]|1[0-2])$/.test(entry.activeMonths)) {
      errors.push(`${entry.workflow}: invalid active months`);
    } else if (entry.activeMonths) {
      try { isCronActive(entry, 1); } catch { errors.push(`${entry.workflow}: invalid active months`); }
    }
    if (entry.mode === 'low-stakes' && /digest/i.test(entry.reason) && !monitored.has(entry.workflow)) {
      errors.push(`${entry.workflow}: justification claims digest coverage but no digest monitor exists`);
    }
  }
  return errors;
}

// Compare a digest threshold with the actual workflow cadence over a full year.
// Seasonal monitors only run in their configured months, so measure the in-season
// cadence without treating the intentional off-season pause as an outage.
function digestCadenceError(entry, yamlText) {
  let crons = [...yamlText.matchAll(/-?\s*cron:\s*['"]([^'"]+)['"]/g)].map(match => match[1]);
  if (entry.activeMonths) {
    crons = crons.map(cron => {
      const fields = cron.split(/\s+/);
      fields[3] = '*';
      return fields.join(' ');
    });
  }
  const gap = worstGapHours(crons, 366);
  if (gap === null || entry.maxHours < gap) {
    return `${entry.workflow}: digest threshold ${entry.maxHours}h cannot cover scheduled gap ${gap}h`;
  }
  return null;
}

function isCronActive(entry, month) {
  if (!entry.activeMonths) return true;
  const [start, end] = entry.activeMonths.split('-').map(Number);
  if (!/^(?:[1-9]|1[0-2])-(?:[1-9]|1[0-2])$/.test(entry.activeMonths) || !(start >= 1 && end <= 12 && start <= end)) throw new Error(`Invalid active months: ${entry.activeMonths}`);
  return month >= start && month <= end;
}

module.exports = { isScheduledWorkflow, parseExemptList, findUncoveredScheduled, findStaleExempt,
  worstGapHours, parsePagingCrons, parseExemptEntries, loadDigestCrons, validateExemptEntries, isCronActive, digestCadenceError };
