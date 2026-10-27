'use strict';
/**
 * BRO-6038: shared --counts=PATH writer for audits wired into data-health-check.yml.
 * Writes { generatedAt, findings, ...counts } where `findings` is the one alertable number
 * health-check.js's orphanAuditCountsResults compares against its limit (null = no usable
 * result). Counts only: callers must never pass file names, ids or review text.
 */
const fs = require('fs');
const path = require('path');

function countsPathFrom(argv) {
  const a = (argv || []).find((x) => typeof x === 'string' && x.startsWith('--counts='));
  return a ? a.slice('--counts='.length) : null;
}

function writeAuditCounts(argv, findings, counts = {}) {
  const file = countsPathFrom(argv);
  if (!file) return null;
  const body = { generatedAt: new Date().toISOString(), findings: Number.isFinite(findings) ? findings : null, ...counts };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(body, null, 2) + '\n');
  return body;
}

module.exports = { countsPathFrom, writeAuditCounts };
