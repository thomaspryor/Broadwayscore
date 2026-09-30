#!/usr/bin/env node

// hygiene-help-flag-ok: audit-help-flag-safety.js flags the execSync(cmd, ...) call inside
// executeRunScript()'s try block — a function DECLARATION, not a call. It's only invoked from
// main() → applyTransform-adjacent action dispatch, well after the --help guard at the top of
// main(). Verified: node execute-approved-fix.js --help exits 0 with no subprocess/fs side effects.

/**
 * Executes a human-approved remediation plan from data/pending-fixes/{issue}.json.
 *
 * Triggered by execute-approved-fix.yml after Tom clicks "Approve" in his email.
 *
 * Actions:
 *   data-edit      — Field changes in shows.json, commercial.json, audience-buzz.json
 *   add-show       — Append one new shows.json entry (scripts/lib/add-show-action.js)
 *   run-script     — Execute allowlisted pipeline scripts
 *   review-file-op — Move/delete/rename review files in data/review-texts/
 *   review-field-edit — Compare-and-set one allowlisted field on a review file
 *                       (scripts/lib/review-field-edit.js; BRO-4216)
 *
 * Env vars:
 *   ISSUE_NUMBER       - GitHub issue number
 *   ANTHROPIC_API_KEY  - For any scripts that need it
 *   RESEND_API_KEY     - For confirmation emails
 *   OWNER_EMAIL        - Tom's email
 */

import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import https from 'https';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { buildFeedbackThankYouEmail } = require('./lib/email-templates.js');
const showsWriteGuard = require('./lib/shows-write-guard.js');
const commercialWriteGuard = require('./lib/commercial-write-guard.js');
const audienceBuzzWriteGuard = require('./lib/audience-buzz-write-guard.js');
const { hasHelpFlag } = require('./lib/cli-help.js');
const { pickEditableFields } = require('./lib/feedback-pipeline-fields.js');
const { applyAddShow } = require('./lib/add-show-action.js');
const { applyReviewFieldEdit, resolveReviewPath, unexpectedChanges } = require('./lib/review-field-edit.js');
const { safeWriteReview } = require('./lib/review-write-guard.js');

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.join(__dirname, '..');

const USAGE = `execute-approved-fix.js — Executes a human-approved remediation plan from data/pending-fixes/{issue}.json.

Usage:
  node scripts/execute-approved-fix.js [options]
  node scripts/execute-approved-fix.js --help, -h    print this usage and exit
`;

// --- Safety rails ---

// awards.json excluded: executeDataEdit() below has no handler for it.
const EDITABLE_DATA_FIELDS = pickEditableFields([
  'shows.json', 'commercial.json', 'audience-buzz.json',
]);

const ALLOWED_SCRIPTS = [
  'rebuild-all-reviews.js',
  'gather-reviews.js',
  'collect-review-texts.js',
  'generate-critic-consensus.js',
  'validate-data.js',
  'fetch-show-images-auto.js',
];

// --- Helpers ---

function loadJsonFile(relPath) {
  // All three core-data files need the lock+merge layer (concurrent
  // writers) — see scripts/lib/{shows,commercial,audience-buzz}-write-guard.js.
  if (relPath === 'data/shows.json') return showsWriteGuard.loadShows();
  if (relPath === 'data/commercial.json') return commercialWriteGuard.loadCommercial();
  if (relPath === 'data/audience-buzz.json') return audienceBuzzWriteGuard.loadAudienceBuzz();
  return JSON.parse(fs.readFileSync(path.join(ROOT, relPath), 'utf8'));
}

function saveJsonFile(relPath, data) {
  if (relPath === 'data/shows.json') { showsWriteGuard.saveShows(data); return; }
  if (relPath === 'data/commercial.json') { commercialWriteGuard.saveCommercial(data); return; }
  if (relPath === 'data/audience-buzz.json') { audienceBuzzWriteGuard.saveAudienceBuzz(data); return; }
  fs.writeFileSync(path.join(ROOT, relPath), JSON.stringify(data, null, 2) + '\n');
}

function output(key, value) {
  if (process.env.GITHUB_OUTPUT) {
    fs.appendFileSync(process.env.GITHUB_OUTPUT, `${key}=${value}\n`);
  }
}

function runValidation(changedFiles) {
  // Targeted validation: check that each modified data file is valid JSON
  // with expected structure. Full validate-data.js catches pre-existing
  // review-text quality issues (garbage outlets, etc.) that are unrelated
  // to the fix and would block every approved fix from landing.
  const checks = {
    'data/shows.json': (data) => {
      const shows = data.shows || data;
      if (!Array.isArray(shows) || shows.length < 1000) throw new Error(`Expected 1000+ shows, got ${shows?.length}`);
      for (const s of shows.slice(0, 50)) {
        if (!s.id || !s.title || !s.status) throw new Error(`Show missing required fields: ${JSON.stringify(s).slice(0, 100)}`);
      }
    },
    'data/commercial.json': (data) => {
      if (!data?.shows || !data?._meta) throw new Error('Missing shows or _meta');
    },
    'data/audience-buzz.json': (data) => {
      if (!data?.shows) throw new Error('Missing shows key');
    },
  };

  for (const file of changedFiles) {
    const relPath = file.startsWith('data/') ? file : `data/${file}`;
    const check = checks[relPath];
    if (!check) continue;

    try {
      const raw = fs.readFileSync(path.join(ROOT, relPath), 'utf8');
      const parsed = JSON.parse(raw);
      check(parsed);
      console.log(`  ✓ ${relPath} is valid`);
    } catch (err) {
      console.error(`  ✗ ${relPath} validation failed: ${err.message}`);
      return false;
    }
  }
  console.log('Validation passed');
  return true;
}

function rollbackDataFiles() {
  try {
    execSync('git checkout -- data/', { cwd: ROOT, stdio: 'pipe' });
  } catch { /* best effort */ }
}

async function sendEmail(to, from, subject, html) {
  const resendKey = process.env.RESEND_API_KEY;
  if (!resendKey) { console.log('No RESEND_API_KEY'); return; }
  const data = JSON.stringify({ from, to: [to], subject, html });
  return new Promise((resolve, reject) => {
    const req = https.request('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${resendKey}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data),
      },
    }, (res) => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) resolve(body);
        else reject(new Error(`Email ${res.statusCode}: ${body.slice(0, 200)}`));
      });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

// --- Action executors ---

function executeDataEdit(action) {
  const { file, showId, field, oldValue, newValue } = action;

  // Validate allowed
  if (!EDITABLE_DATA_FIELDS[file]) {
    return { ok: false, reason: `File "${file}" not allowed for data-edit` };
  }
  if (!EDITABLE_DATA_FIELDS[file].includes(field)) {
    return { ok: false, reason: `Field "${field}" not allowed in ${file}` };
  }

  const relPath = `data/${file}`;
  const data = loadJsonFile(relPath);

  if (file === 'shows.json') {
    const shows = data.shows || data;
    const idx = shows.findIndex(s => s.id === showId);
    if (idx === -1) return { ok: false, reason: `Show "${showId}" not found in shows.json` };

    const currentVal = shows[idx][field];
    if (JSON.stringify(currentVal) !== JSON.stringify(oldValue)) {
      return { ok: false, reason: `${field}: current value doesn't match expected (data changed since plan was created)` };
    }
    if (field === 'images') {
      const { crossShowImageProblems } = require('./lib/cross-show-images.js');
      if (!newValue || typeof newValue !== 'object' || Array.isArray(newValue)) {
        return { ok: false, reason: 'images: newValue must be an object' };
      }
      for (const [k, v] of Object.entries(newValue)) {
        if (!['thumbnail', 'poster', 'hero'].includes(k)) return { ok: false, reason: `images: unexpected key "${k}"` };
        // Only values the plan changes are checked: a plan that fixes one key
        // must not be refused over an untouched (e.g. already missing) path.
        if (oldValue && typeof oldValue === 'object' && JSON.stringify(oldValue[k]) === JSON.stringify(v)) continue;
        if (v !== null && typeof v !== 'string') return { ok: false, reason: `images.${k}: must be a string or null` };
        if (typeof v === 'string' && !v.startsWith('/images/shows/')) return { ok: false, reason: `images.${k}: only local /images/shows/ paths or null` };
        if (typeof v === 'string' && !fs.existsSync(path.join(ROOT, 'public', v))) return { ok: false, reason: `images.${k}: ${v} does not exist` };
      }
      const cross = crossShowImageProblems({ id: showId, images: newValue }, shows);
      if (cross.length) {
        return { ok: false, reason: `images: ${cross.map(c => `${c.key} -> ${c.owner}`).join(', ')} is another show's art (BRO-4380)` };
      }
    }

    if (field === 'cast') {
      const { castValueProblem } = require('./lib/feedback-pipeline-fields.js');
      const castProblem = castValueProblem(newValue);
      if (castProblem) return { ok: false, reason: castProblem };
    }

    shows[idx][field] = newValue;
    // The site also reads tags:'revival', so the flag alone can't clear it (BRO-4436).
    if (field === 'isRevival') require('./lib/revival-tags.js').syncRevivalTags(shows[idx]);
    // `shows` was mutated in place and (for the object-root shape) IS
    // `data.shows` — pass `data` itself, not a rebuilt `{...data, shows}`
    // copy, so shows-write-guard's object-identity snapshot lookup still
    // matches and the concurrent-writer merge fires.
    saveJsonFile(relPath, Array.isArray(data) ? shows : data);
    return { ok: true, msg: `shows.json: ${field} updated for ${showId}` };

  } else if (file === 'commercial.json') {
    const slug = action.showSlug || showId;
    if (!data.shows?.[slug]) return { ok: false, reason: `No commercial entry for "${slug}"` };

    const currentVal = data.shows[slug][field];
    if (JSON.stringify(currentVal) !== JSON.stringify(oldValue)) {
      return { ok: false, reason: `commercial.json:${field}: value changed since plan` };
    }

    data.shows[slug][field] = newValue;
    saveJsonFile(relPath, data);
    return { ok: true, msg: `commercial.json: ${field} updated for ${slug}` };

  } else if (file === 'audience-buzz.json') {
    if (!data.shows?.[showId]) return { ok: false, reason: `No audience-buzz entry for "${showId}"` };

    const currentVal = data.shows[showId][field];
    if (JSON.stringify(currentVal) !== JSON.stringify(oldValue)) {
      return { ok: false, reason: `audience-buzz.json:${field}: value changed since plan` };
    }

    data.shows[showId][field] = newValue;
    saveJsonFile(relPath, data);
    return { ok: true, msg: `audience-buzz.json: ${field} updated for ${showId}` };
  }

  return { ok: false, reason: `Unhandled file: ${file}` };
}

function executeAddShow(action) {
  const data = loadJsonFile('data/shows.json');
  const shows = data.shows || data;
  const result = applyAddShow(shows, action);
  if (result.ok) saveJsonFile('data/shows.json', Array.isArray(data) ? shows : data);
  return result;
}

function executeRunScript(action) {
  const { script, args } = action;

  if (!ALLOWED_SCRIPTS.includes(script)) {
    return { ok: false, reason: `Script "${script}" not in allowlist` };
  }

  // Sanitize: no shell metacharacters in args
  const safeArgs = (args || '').replace(/[;&|`$(){}]/g, '');

  try {
    const cmd = `node scripts/${script} ${safeArgs}`.trim();
    console.log(`Running: ${cmd}`);
    execSync(cmd, { cwd: ROOT, stdio: 'inherit', timeout: 300000 }); // 5 min timeout
    return { ok: true, msg: `Ran ${script} successfully` };
  } catch (err) {
    return { ok: false, reason: `Script ${script} failed: ${err.message}` };
  }
}

function executeReviewFileOp(action) {
  const { operation, sourcePath, destPath } = action;
  const reviewTextsDir = path.join(ROOT, 'data/review-texts');

  // Ensure paths are within review-texts/
  const absSource = path.resolve(reviewTextsDir, sourcePath);
  if (!absSource.startsWith(reviewTextsDir)) {
    return { ok: false, reason: `Source path escapes review-texts/: ${sourcePath}` };
  }

  if (!fs.existsSync(absSource)) {
    return { ok: false, reason: `Source not found: ${sourcePath}` };
  }

  if (operation === 'delete') {
    fs.unlinkSync(absSource);
    return { ok: true, msg: `Deleted ${sourcePath}` };

  } else if (operation === 'move' || operation === 'rename') {
    if (!destPath) return { ok: false, reason: 'No destination path for move/rename' };

    const absDest = path.resolve(reviewTextsDir, destPath);
    if (!absDest.startsWith(reviewTextsDir)) {
      return { ok: false, reason: `Dest path escapes review-texts/: ${destPath}` };
    }

    // Ensure destination directory exists
    fs.mkdirSync(path.dirname(absDest), { recursive: true });
    fs.renameSync(absSource, absDest);
    return { ok: true, msg: `Moved ${sourcePath} → ${destPath}` };
  }

  return { ok: false, reason: `Unknown operation: ${operation}` };
}

function executeReviewFieldEdit(action, stamp) {
  const reviewTextsDir = path.join(ROOT, 'data/review-texts');
  const abs = resolveReviewPath(reviewTextsDir, action.file);
  if (!abs) return { ok: false, reason: `Bad review path: ${action.file}` };
  if (!fs.existsSync(abs)) return { ok: false, reason: `Review file not found: ${action.file}` };
  const record = JSON.parse(fs.readFileSync(abs, 'utf8'));
  const res = applyReviewFieldEdit(record, action, stamp);
  if (!res.ok) return res;
  safeWriteReview(abs, res.record);
  // The write guard can legitimately refuse a change (a protected field with
  // no clear breadcrumb). Report that instead of claiming success.
  const after = JSON.parse(fs.readFileSync(abs, 'utf8'));
  const got = after[action.field] === undefined ? null : after[action.field];
  if (JSON.stringify(got) !== JSON.stringify(action.newValue)) {
    return { ok: false, reason: `${action.file} ${action.field}: write guard kept ${JSON.stringify(got)}` };
  }
  const extra = unexpectedChanges(record, after, action.field, res.sideEffectKeys || []);
  if (extra.length) {
    return { ok: false, reason: `${action.file} ${action.field} applied, but the write guard also changed ${extra.join(', ')}; check the record before trusting it` };
  }
  return { ok: true, msg: `${action.file} ${res.msg}` };
}

function executeBatchTransform(action) {
  const { file, field, transform } = action;

  if (file !== 'shows.json') {
    return { ok: false, reason: `batch-transform only supports shows.json, got "${file}"` };
  }

  if (transform === 'split-comma-roles' && field === 'creativeTeam') {
    const relPath = 'data/shows.json';
    const data = loadJsonFile(relPath);
    const shows = data.shows || data;
    const showsList = Array.isArray(shows) ? shows : Object.values(shows);

    let splitCount = 0;
    let showsAffected = 0;

    for (const show of showsList) {
      if (!show.creativeTeam) continue;
      let hasCombined = false;
      for (const ct of show.creativeTeam) {
        if (ct.role && ct.role.includes(', ')) { hasCombined = true; break; }
      }
      if (!hasCombined) continue;

      showsAffected++;
      const newTeam = [];
      for (const ct of show.creativeTeam) {
        if (ct.role && ct.role.includes(', ')) {
          splitCount++;
          for (const role of ct.role.split(', ')) {
            newTeam.push({ name: ct.name, role: role.trim() });
          }
        } else {
          newTeam.push(ct);
        }
      }
      show.creativeTeam = newTeam;
    }

    if (splitCount === 0) {
      return { ok: true, msg: 'No combined roles found — already fixed' };
    }

    saveJsonFile(relPath, Array.isArray(data) ? shows : data);
    return { ok: true, msg: `Split ${splitCount} combined roles across ${showsAffected} shows` };
  }

  return { ok: false, reason: `Unknown transform: ${transform}` };
}

// --- Main ---

async function main() {
  // --help/-h checked before any real work (cousin of #260/#263/#264/#266 — see scripts/lib/cli-help.js).
  if (hasHelpFlag(process.argv.slice(2))) { console.log(USAGE); return; }
  const issueNumber = process.env.ISSUE_NUMBER;
  if (!issueNumber) {
    console.error('ISSUE_NUMBER not set');
    output('result', 'error');
    return;
  }

  // Plan ids name a file under data/pending-fixes/: GitHub issue numbers
  // ("925", "504-systematic") or Linear ids ("bro-4202", BRO-4216).
  if (!/^[a-z0-9][a-z0-9-]*$/i.test(String(issueNumber))) {
    console.error(`Invalid plan id: ${issueNumber}`);
    output('result', 'error');
    return;
  }

  // 1. Load plan
  const planFile = path.join(ROOT, 'data/pending-fixes', `${issueNumber}.json`);
  if (!fs.existsSync(planFile)) {
    console.error(`Plan file not found: ${planFile}`);
    output('result', 'error');
    return;
  }

  const planData = JSON.parse(fs.readFileSync(planFile, 'utf8'));

  // 1b. Stale-link guard: the approval URL is HMAC-bound to the planId that
  // existed when the email was sent. A regenerated plan for the same issue
  // overwrites {issue}.json; executing it under the OLD link would apply a
  // plan nobody reviewed. Refuse on any mismatch.
  const expectedPlanId = process.env.PLAN_ID || null;
  if ((planData.planId || null) !== expectedPlanId) {
    console.error(`Plan ID mismatch: link carries ${expectedPlanId || '(none)'}, ` +
      `current plan is ${planData.planId || '(unversioned)'} — the plan was ` +
      `regenerated after this link was issued. Refusing to execute.`);
    output('result', 'error');
    return;
  }

  // Session-authored plans (BRO-4216) may omit submitter; step 7 reads it.
  if (!planData.submitter || typeof planData.submitter !== 'object') planData.submitter = { name: null, email: null };

  // 2. Check status
  if (planData.status !== 'pending') {
    console.log(`Plan already ${planData.status} — skipping`);
    output('result', 'already-applied');
    return;
  }

  // 2b. Reject mode: the owner clicked Reject — persist the rejection so an
  // unexpired Approve link for the same plan can no longer execute it.
  if (process.env.EXEC_MODE === 'reject') {
    planData.status = 'rejected';
    planData.rejectedAt = new Date().toISOString();
    fs.writeFileSync(planFile, JSON.stringify(planData, null, 2) + '\n');
    console.log(`Plan for #${issueNumber} marked rejected — nothing executed`);
    output('result', 'rejected');
    return;
  }

  // BRO-4216: plans can now be written by sessions, not only by the feedback
  // pipeline. Cap the blast radius of any single plan.
  const MAX_ACTIONS = 25;
  if ((planData.plan.actions || []).length > MAX_ACTIONS) {
    console.error(`Plan has ${planData.plan.actions.length} actions (max ${MAX_ACTIONS}) — refusing`);
    output('result', 'error');
    return;
  }

  console.log(`Executing plan for issue #${issueNumber}`);
  console.log(`  Summary: ${planData.plan.summary}`);
  console.log(`  Actions: ${planData.plan.actions.length}`);

  // 3. Execute each action
  const results = [];
  const applied = [];
  const failed = [];

  for (const action of planData.plan.actions) {
    console.log(`\nExecuting: ${action.type} — ${action.description || action.field || action.script || action.operation}`);

    let result;
    switch (action.type) {
      case 'data-edit':
        result = executeDataEdit(action);
        break;
      case 'run-script':
        result = executeRunScript(action);
        break;
      case 'review-file-op':
        result = executeReviewFileOp(action);
        break;
      case 'add-show':
        result = executeAddShow(action);
        break;
      case 'review-field-edit':
        result = executeReviewFieldEdit(action, { fixId: planData.planId || String(issueNumber), at: new Date().toISOString() });
        break;
      case 'batch-transform':
        result = executeBatchTransform(action);
        break;
      default:
        result = { ok: false, reason: `Unknown action type: ${action.type}` };
    }

    results.push({ action: action.type, ...result });
    if (result.ok) {
      applied.push(result.msg);
      console.log(`  OK: ${result.msg}`);
    } else {
      failed.push(result.reason);
      console.log(`  FAILED: ${result.reason}`);
    }
  }

  // 4. Validate if we made data changes. batch-transform mutates data files
  // too — it must NOT bypass validation (it previously did, so a bad bulk
  // transform had no rollback path).
  const dataTouching = planData.plan.actions.filter(a => a.type === 'data-edit' || a.type === 'batch-transform' || a.type === 'add-show');
  const hasDataEdits = dataTouching.length > 0;
  if (hasDataEdits) {
    const changedFiles = [...new Set(dataTouching.map(a => a.file).filter(Boolean))];
    console.log('\nRunning validation...');
    if (!runValidation(changedFiles)) {
      console.error('Validation failed — rolling back');
      rollbackDataFiles();

      // Update plan status
      planData.status = 'validation-failed';
      planData.executedAt = new Date().toISOString();
      planData.results = results;
      fs.writeFileSync(planFile, JSON.stringify(planData, null, 2) + '\n');

      output('result', 'validation-failed');
      // No email — GitHub issue gets labeled 'needs-manual-review' by the workflow.
      // Sending failure emails on every attempt was spammy during debugging.
      return;
    }
    console.log('Validation passed');
  }

  // 5. Success — update plan. 'partial' (not 'applied') when any action
  // failed, so the record doesn't claim the whole plan landed.
  planData.status = failed.length > 0 ? 'partial' : 'applied';
  planData.executedAt = new Date().toISOString();
  planData.results = results;
  fs.writeFileSync(planFile, JSON.stringify(planData, null, 2) + '\n');

  console.log(`\nPlan executed: ${applied.length} applied, ${failed.length} failed`);
  output('result', applied.length > 0 ? 'fixed' : 'no-changes');
  output('failed', String(failed.length));

  // 6. Send confirmation to Tom
  const ownerEmail = process.env.OWNER_EMAIL;
  if (ownerEmail && applied.length > 0) {
    try {
      const showTitle = planData.submitter.show || '';
      await sendEmail(
        ownerEmail,
        'Tom at Broadway Scorecard <updates@broadwayscorecard.com>',
        showTitle ? `Fix Applied: ${showTitle} (#${issueNumber})` : `Fix Applied: Issue #${issueNumber}`,
        `<!DOCTYPE html><html><head><meta charset="utf-8"></head>
<body style="margin:0;padding:24px;font-family:-apple-system,sans-serif;font-size:15px;line-height:1.6;color:#333;">
<p style="margin:0;">The fix for issue #${issueNumber} has been applied and will be live shortly.</p>
<br>
<p style="margin:0;font-weight:600;">What was done:</p>
${applied.map(a => `<p style="margin:0;padding-left:20px;">&bull; ${a}</p>`).join('\n')}
${failed.length > 0 ? `<br><p style="margin:0;color:#c00;">Skipped: ${failed.join('; ')}</p>` : ''}
</body></html>`
      );
    } catch { /* best effort */ }
  }

  // 7. Send thank-you to submitter. Persisted plans are PII-redacted
  // (submitter.email is null by construction — see generate-remediation-plan.js),
  // so recover the submitter from the GitHub issue's DIAGNOSIS_JSON at
  // execute time. Recovery MUST stay below the plan-file write above so the
  // email never re-enters the committed JSON. Systematic plans skip the
  // thank-you — the parent spot fix already sent one for the same report.
  if (planData.isSystematic) {
    console.log('Systematic plan — skipping submitter thank-you (parent plan covers it)');
    return;
  }
  if (!planData.submitter.email && applied.length > 0) {
    const recovered = await fetchSubmitterFromIssue(issueNumber);
    if (recovered) {
      planData.submitter = { ...planData.submitter, ...recovered };
      console.log('Submitter recovered from issue DIAGNOSIS_JSON');
    }
  }
  if (planData.submitter.email && applied.length > 0) {
    try {
      const { subject, html } = buildFeedbackThankYouEmail(
        'fixed',
        planData.submitter.name,
        planData.submitter.show
      );
      await sendEmail(
        planData.submitter.email,
        'Tom at Broadway Scorecard <updates@broadwayscorecard.com>',
        subject,
        html
      );
      console.log(`Thank-you sent to ${planData.submitter.email}`);
    } catch { /* best effort */ }
  }
}

// Recover submitter contact info from the GitHub issue's embedded
// DIAGNOSIS_JSON. The persisted plan file is PII-redacted, so this is the
// only source of the submitter's email at execute time. "504-systematic"
// style ids resolve to their parent issue via parseInt.
async function fetchSubmitterFromIssue(issueNumber) {
  const ghIssue = parseInt(issueNumber);
  const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
  if (isNaN(ghIssue) || !token) return null;

  const repo = process.env.GITHUB_REPO || 'thomaspryor/Broadwayscore';
  const body = await new Promise((resolve) => {
    const req = https.request(`https://api.github.com/repos/${repo}/issues/${ghIssue}`, {
      method: 'GET',
      headers: {
        'Authorization': `token ${token}`,
        'User-Agent': 'BroadwayScorecard-Executor',
        'Accept': 'application/vnd.github.v3+json',
      },
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve(res.statusCode === 200 ? data : null));
    });
    req.on('error', () => resolve(null));
    req.end();
  });
  if (!body) return null;

  try {
    const issueBody = JSON.parse(body).body || '';
    const m = issueBody.match(/<!-- DIAGNOSIS_JSON\n([\s\S]*?)\nDIAGNOSIS_JSON -->/);
    if (!m) return null;
    const diagnosis = JSON.parse(m[1]);
    return {
      name: diagnosis.submitterName || 'Anonymous',
      email: diagnosis.submitterEmail || null,
      show: diagnosis.submitterShow || null,
    };
  } catch {
    return null;
  }
}

main().catch(err => {
  console.error('Fatal error:', err);
  output('result', 'error');
});
