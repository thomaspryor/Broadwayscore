#!/usr/bin/env node
// scripts/land-ready.mjs (BRO-7849, `npm run land:ready`): report-only checklist of EVERYTHING a land push still needs,
// in one run, never stopping at the first problem. Born from BRO-7809: the visual gate, the review-coverage gate and the
// land preflight each blocked one push at a time and the owner was asked "yes" six times.
// Order: doctor, tree, diff class, build, visual verdict, ship-check, land dry run, owner approval.
// Last line is always 'Ask the owner now: yes' / 'Ask the owner now: no' / 'No owner approval needed'.
// Flags: --no-doctor (skip cloud-doctor), --no-judge (skip the land dry run), --hook (short form for gate messages:
// implies --no-doctor, never fetches), --json. Exit is always 0 (report-only).
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { isMainModule } from './lib/is-main-module.mjs';

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
export const UI_RE = /^(src\/.*\.(tsx|jsx|css|scss|module\.css)$|tailwind\.config\.|postcss\.config\.)/;
const COMMIT_UI_RE = /^src\/(app|components)\/.*\.tsx$/; // what scripts/hooks/commit-msg demands a VISUAL-OK-1440: prefix for

/** Pure: facts -> ordered checklist + owner line. */
export function evaluate(f) {
  const items = [];
  const add = (id, label, ok, detail = '', fix = '') => items.push({ id, label, ok, detail, fix });

  if (f.doctor?.skipped) add('doctor', 'cloud-doctor', true, 'skipped');
  else add('doctor', 'cloud-doctor --fix --quick', !!f.doctor?.ok, f.doctor?.detail || '', 'node scripts/cloud-doctor.js --fix --quick');

  add('tree', 'working tree clean', !(f.dirty || []).length, (f.dirty || []).slice(0, 5).join(', '), 'commit or discard the listed files');
  const noPrefix = f.uiCommitsMissingPrefix || [];
  if ((f.uiFiles || []).length) add('prefix', 'UI commits carry VISUAL-OK-1440:', noPrefix.length === 0, noPrefix.slice(0, 5).join(', '), 'reword those commits to start with VISUAL-OK-1440: after checking 1440px');

  if (f.diffError) add('diff', 'diff against origin/main is readable', false, 'git diff failed, so no file list is known', 'git fetch origin main, then re-run');
  const gated = f.gatedFiles || [];
  const cls = !(f.uiFiles || []).length ? 'no UI files' : gated.length ? 'rendering UI change' : (f.renderImpactDropped || []).length ? 'non-rendering (render-impact detector)' : 'text-only copy';
  const needsVisual = gated.length > 0;
  add('class', `diff class: ${cls}`, true, gated.length ? `gated files: ${gated.slice(0, 5).join(', ')}` : '');

  if (f.touchesSrc) {
    const missingBuild = (f.coverage?.missing || []).find((m) => /build/.test(m));
    add('build', '`npm run build` answered in this session', f.transcript?.found ? !missingBuild : false, f.transcript?.found ? '' : 'session transcript not found (CLAUDE_CODE_SESSION_ID)', 'npm run build');
  }
  if (needsVisual) {
    const v = f.verdict || {};
    const ok = !!v.exists && v.schemaOk !== false && v.overallPass === true && !!v.uiPatchId && v.uiPatchId === v.currentPatchId;
    add('verdict', 'visual verdict exists and matches this diff', ok,
      !v.exists ? 'no verdict.json for this branch' : v.schemaOk === false ? 'verdict is an old schema' : v.overallPass !== true ? 'verdict says the visual check did not pass' : v.uiPatchId !== v.currentPatchId ? 'verdict is for an older version of the UI diff' : '',
      '/visual-qa (screenshots at 390 and 1440), then re-run this');
  }
  const cov = f.coverage;
  const shipMissing = (cov?.missing || []).filter((m) => !/build/.test(m));
  add('shipcheck', '/ship-check coverage complete', !!f.transcript?.found && shipMissing.length === 0,
    f.transcript?.found ? shipMissing.join('; ') : 'session transcript not found (CLAUDE_CODE_SESSION_ID)', '/ship-check');
  if (f.judge?.skipped) add('judge', 'land dry run (judgeLand): NOT CHECKED (--no-judge), run without it before relying on this', true, 'skipped');
  else add('judge', 'land dry run (judgeLand)', f.judge?.decision !== 'block', f.judge?.decision === 'block' ? String(f.judge.message || '').split('\n')[0] : '', 'fix what the line above says, then re-run');

  const missing = items.filter((i) => !i.ok);
  let owner;
  if (f.diffError) owner = { line: 'Ask the owner now: no', why: 'the diff could not be read, so nothing can be judged yet' };
  else if (!needsVisual) owner = { line: 'No owner approval needed', why: `diff class is ${cls}` };
  else if (f.approval?.approved) owner = { line: 'No owner approval needed', why: 'this UI diff is already approved' };
  else if (missing.length) owner = { line: 'Ask the owner now: no', why: `${missing.length} item(s) above are still open; finish them first so the owner is asked once` };
  else owner = { line: 'Ask the owner now: yes', why: 'everything else is done: send ONE message with the screenshots; any clear yes after it clears the gate' };
  return { items, missing, cls, owner };
}

export function render(r, { short = false } = {}) {
  const out = [];
  for (const i of r.items) {
    if (short && i.ok) continue;
    out.push(`${i.ok ? '[x]' : '[ ]'} ${i.label}${i.detail ? ` (${i.detail})` : ''}${!i.ok && i.fix ? `\n      do: ${i.fix}` : ''}`);
  }
  if (short && !out.length) out.push(`[x] nothing else missing (diff class: ${r.cls})`);
  out.push(`${r.owner.why}.`);
  out.push(r.owner.line);
  return out.join('\n');
}

const git = (cwd, args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', maxBuffer: 128 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
const tryGit = (cwd, args) => { try { return git(cwd, args); } catch { return ''; } };

/** Gather facts (IO). Every probe is isolated so one failure shows as one open item, not a crash. */
export async function gather({ cwd = process.cwd(), base = 'origin/main', doctor = true, judge = true, fetch = true, env = process.env } = {}) {
  const f = {};
  if (doctor) {
    const r = spawnSync('node', [path.join(HERE, 'cloud-doctor.js'), '--fix', '--quick'], { cwd, encoding: 'utf8', timeout: 300000 });
    f.doctor = { ok: r.status === 0, detail: r.status === 0 ? '' : (String(r.stdout || '').trim().split('\n').slice(-2).join(' | ') || `exit ${r.status}`) };
  } else f.doctor = { skipped: true };
  if (fetch) tryGit(cwd, ['fetch', '-q', 'origin', 'main']);
  f.dirty = (() => { try { return execFileSync('git', ['-C', cwd, 'status', '--porcelain'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).split('\n').filter(Boolean).map((l) => l.slice(3)); } catch { return []; } })();
  const range = `${base}...HEAD`;
  let diffOut = '';
  try { diffOut = git(cwd, ['diff', '--name-only', range]); f.diffError = false; } catch { f.diffError = true; }
  const changed = diffOut.split('\n').filter(Boolean);
  f.uiFiles = changed.filter((x) => UI_RE.test(x));
  f.touchesSrc = changed.some((x) => x.startsWith('src/'));
  const filter = (script, files) => {
    if (!files.length) return files;
    const p = path.join(HERE, 'lib', script);
    const r = spawnSync('node', [p, '--filter', range], { cwd, input: files.join('\n'), encoding: 'utf8' });
    return r.status === 0 ? r.stdout.split('\n').filter(Boolean) : files; // fail closed: keep everything gated
  };
  const afterText = filter('visual-text-only-diff.js', f.uiFiles);
  const noLog = { ...process.env, VISUAL_RENDER_IMPACT_LOG: '/dev/null' };
  const afterRender = (() => {
    if (!afterText.length) return afterText;
    const r = spawnSync('node', [path.join(HERE, 'lib', 'visual-render-impact.js'), '--filter', range], { cwd, input: afterText.join('\n'), encoding: 'utf8', env: noLog });
    return r.status === 0 ? r.stdout.split('\n').filter(Boolean) : afterText;
  })();
  f.gatedFiles = afterRender;
  f.renderImpactDropped = afterText.filter((x) => !afterRender.includes(x));
  // commit-msg demands VISUAL-OK-1440: on commits that stage src/(app|components)/*.tsx
  f.uiCommitsMissingPrefix = [];
  for (const sha of tryGit(cwd, ['rev-list', '--no-merges', `${base}..HEAD`]).split('\n').filter(Boolean)) {
    const files = tryGit(cwd, ['diff-tree', '--no-commit-id', '--name-only', '-r', sha]).split('\n');
    if (!files.some((x) => COMMIT_UI_RE.test(x))) continue;
    if (!/^(VISUAL-OK-1440:|SKIP-VISUAL-CHECK:)/.test(tryGit(cwd, ['log', '-1', '--format=%s', sha]))) f.uiCommitsMissingPrefix.push(sha.slice(0, 9));
  }
  // transcript coverage
  try {
    const rc = await import('./lib/review-coverage.mjs');
    const tp = rc.findSessionTranscript(env.CLAUDE_CODE_SESSION_ID);
    if (tp) {
      const { walkTranscript } = await import('./lib/transcript-scan.mjs');
      f.transcript = { found: true };
      f.coverage = rc.evaluateCoverage(walkTranscript(tp), { requireBuild: f.touchesSrc });
    } else f.transcript = { found: false };
  } catch (e) { f.transcript = { found: false }; }
  // visual verdict
  if (f.gatedFiles.length) {
    const branch = tryGit(cwd, ['branch', '--show-current']) || 'HEAD';
    // Same lookup order as the push hook: this checkout first, then the canonical root (worktrees keep verdicts there).
    let canon = null;
    try { canon = path.resolve(cwd, tryGit(cwd, ['rev-parse', '--git-common-dir'])); canon = path.basename(canon) === '.git' ? path.dirname(canon) : null; } catch { canon = null; }
    const vps = [path.join(cwd, '.claude', 'visual-qa', branch, 'verdict.json'), canon && path.join(canon, '.claude', 'visual-qa', branch, 'verdict.json')].filter(Boolean);
    const vp = vps.find((x) => existsSync(x)) || vps[0];
    let v = { exists: false };
    try {
      if (existsSync(vp)) { const j = JSON.parse(readFileSync(vp, 'utf8')); v = { exists: true, schemaOk: String(j.schemaVersion) === '2', overallPass: j.overallPass === true, uiPatchId: j.uiPatchId || null, hash: j.contentHash || j.verdictHash || null }; }
    } catch { v = { exists: true, schemaOk: false }; }
    try { v.currentPatchId = require('./lib/visual-approval-durable.js').uiPatchId(cwd, 'HEAD', base); } catch { v.currentPatchId = null; }
    f.verdict = v;
    let approved = false;
    try {
      if (v.currentPatchId && require('./lib/visual-approval-durable.js').hasDurableApproval(cwd, v.currentPatchId)) approved = true;
      if (!approved && v.hash) {
        const r = spawnSync('node', [path.join(HERE, 'lib', 'visual-qa-ledger.mjs'), '--query=push-allowed', `--repo=${cwd}`, `--current-content-hash=${v.hash}`], { encoding: 'utf8' });
        approved = JSON.parse(r.stdout || '{}').allowed === true;
      }
    } catch { /* not approved */ }
    f.approval = { approved };
  }
  if (judge) {
    try {
      const { judgeLand } = await import('./lib/land-preflight.mjs');
      const v = judgeLand({ cwd, src: 'HEAD', target: 'land/(HEAD)', base, fetch: false, checkTests: false });
      f.judge = { decision: v.decision, message: v.message };
    } catch (e) { f.judge = { decision: 'block', message: `land dry run crashed: ${e.message}` }; }
  } else f.judge = { skipped: true };
  return f;
}

async function main(argv) {
  const hook = argv.includes('--hook');
  const facts = await gather({ doctor: !hook && !argv.includes('--no-doctor'), judge: !argv.includes('--no-judge'), fetch: !hook, cwd: process.env.LAND_READY_CWD || process.cwd() });
  const r = evaluate(facts);
  if (argv.includes('--json')) console.log(JSON.stringify(r, null, 2));
  else console.log(render(r, { short: hook }));
  return 0;
}

if (isMainModule(import.meta.url)) {
  main(process.argv.slice(2)).then((c) => process.exit(c), (e) => { console.error(`land-ready: ${e.message}`); process.exit(0); });
}
