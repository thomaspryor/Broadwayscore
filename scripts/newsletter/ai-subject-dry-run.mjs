#!/usr/bin/env node
// Try the AI subject writer on a real week WITHOUT touching any Resend draft
// or the committed issue ledger (BRO-7168). Runs generate.mjs per edition into
// a temp dir with a temp copy of newsletter-state.json, then prints what the
// writer chose, the runners-up, the opening paragraph and the writer's log.
//
//   node scripts/cloud-run-script.js scripts/newsletter/ai-subject-dry-run.mjs 2026-11-02
//
// Needs ANTHROPIC_API_KEY and OPENAI_API_KEY (run-script.yml has both).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const week = process.argv[2];
if (!/^\d{4}-\d{2}-\d{2}$/.test(week || '')) { console.error('usage: ai-subject-dry-run.mjs <weekStart YYYY-MM-DD> [broadway|west-end]'); process.exit(2); }
const editions = process.argv[3] ? [process.argv[3]] : ['broadway', 'west-end'];
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-subject-'));
const state = path.join(tmp, 'state.json');
try { fs.copyFileSync(path.join(repo, 'data/newsletter-state.json'), state); } catch { fs.writeFileSync(state, '{"issues":[]}'); }

for (const edition of editions) {
  const out = path.join(tmp, edition);
  fs.mkdirSync(out);
  // No RESEND key: the writer can't see or touch drafts; recent subjects come from the ledger.
  const env = { ...process.env, NEWSLETTER_EDITION: edition, NEWSLETTER_OUT_DIR: out, NEWSLETTER_STATE_PATH: state, RESEND_API_KEY: '' };
  const r = spawnSync('node', [path.join(repo, 'scripts/newsletter/generate.mjs'), week], { cwd: repo, env, encoding: 'utf8', timeout: 10 * 60 * 1000 });
  console.log(`\n===== ${edition} · week of ${week} =====`);
  for (const l of (r.stderr || '').split('\n')) if (/subject|AI /.test(l)) console.log(l);
  try {
    const meta = JSON.parse(fs.readFileSync(path.join(out, `A-${week}.meta.json`), 'utf8'));
    console.log(`WRITER: ${JSON.stringify(meta.subjectWriter)}`);
    console.log(`SUBJECT: ${meta.subject}`);
    for (const a of meta.subjectAlternates || []) console.log(`  ALT (${a.angle}): ${a.subject} | ${a.preheader}`);
    console.log(`OPENING: ${String(meta.lede || '').replace(/<[^>]+>/g, '')}`);
  } catch (e) { console.log(`no meta: ${e.message}; exit ${r.status}`); }
}
fs.rmSync(tmp, { recursive: true, force: true });
