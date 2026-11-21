#!/usr/bin/env node
/**
 * audit-new-show-posters.js (BRO-5331)
 *
 * Advisory vision audit for art the fetch run just wrote: every show whose
 * thumbnail is new or modified in the working tree is checked with
 * audit-images-llm.js --show=ID --no-write. Delete verdicts are reported as
 * ::warning:: lines and in the step summary. Never fails the job and never
 * writes the audit report (CLAUDE.md section 19: advisory first).
 *
 * Usage: node scripts/audit-new-show-posters.js [--limit=25] [--help]
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { changedThumbnailShowIds, parseAuditResult, supportsNoWrite, isReportableVerdict } = require('./lib/new-poster-audit.js');

if (process.argv.includes('--help') || process.argv.includes('-h')) {
  console.log('Usage: node scripts/audit-new-show-posters.js [--limit=25]\nAudits shows whose thumbnail changed in the working tree; advisory, always exits 0.');
  process.exit(0);
}

const AUDIT = path.join(__dirname, 'audit-images-llm.js');
const limitArg = process.argv.find((a) => a.startsWith('--limit='));
const limit = limitArg ? Math.max(1, parseInt(limitArg.split('=')[1], 10) || 25) : 25;

function main() {
  if (!supportsNoWrite(fs.readFileSync(AUDIT, 'utf8'))) {
    console.log('audit-images-llm.js has no --no-write yet; skipping so image-verification.json is not rewritten.');
    return;
  }
  if (!process.env.GEMINI_API_KEY) { console.log('GEMINI_API_KEY not set; skipping poster audit.'); return; }
  const status = spawnSync('git', ['status', '--porcelain', '--', 'public/images/shows/'], { encoding: 'utf8' });
  const all = changedThumbnailShowIds(status.stdout);
  const ids = all.slice(0, limit);
  console.log(`Poster audit: ${all.length} show(s) with new or changed thumbnails, auditing ${ids.length}.`);
  if (all.length > ids.length) console.log(`::notice title=Poster audit::${all.length - ids.length} show(s) over --limit=${limit} not audited: ${all.slice(limit).join(', ')}`);
  const flagged = [];
  for (const id of ids) {
    const r = spawnSync('node', [AUDIT, `--show=${id}`, '--no-write', '--skip-validation'], { encoding: 'utf8', timeout: 120000 });
    const res = parseAuditResult(r.stdout);
    console.log(`${id}: ${res ? res.action : 'no result'}${res && res.reason ? ` (${res.reason})` : ''}`);
    if (isReportableVerdict(res)) {
      flagged.push({ id, reason: res.reason, description: res.description });
      console.log(`::warning title=Poster audit::${id} thumbnail flagged ${res.reason || 'delete'}: ${String(res.description || '').slice(0, 200)}`);
    }
  }
  if (process.env.GITHUB_STEP_SUMMARY && flagged.length) {
    const lines = ['### Poster audit (advisory)', ...flagged.map((f) => `- \`${f.id}\`: ${f.reason || 'delete'}. ${String(f.description || '').slice(0, 200)}`)];
    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, lines.join('\n') + '\n');
  }
}

try { main(); } catch (e) { console.log(`poster audit skipped: ${e.message}`); }
process.exit(0);
