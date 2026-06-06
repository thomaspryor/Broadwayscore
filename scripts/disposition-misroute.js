#!/usr/bin/env node
/**
 * Slug-misroute disposition list + weekly "new misroute" report/alert.
 *
 * Background: scripts/audit-slug-match-routing.js writes
 * data/audit/slug-misroute-audit.json every week. APPLIED/DELETED misroutes
 * self-drop from that audit (the file moved/was removed → no longer misrouted),
 * so they need no tracking. What persists are the "leave-as-is" findings —
 * reviews for productions NOT in shows.json, combined reviews, mislabeled
 * files — which re-appear in the audit forever. This tool records an explicit
 * disposition for those so the weekly report doesn't re-alert on them.
 *
 * Two modes:
 *   add    — record a leave-as-is disposition (the INTENTIONAL human writer;
 *            NOT wired into the apply/dedup tools, so there's no silent-forget
 *            coupling — you mark "leave it" deliberately).
 *   report — new = audit findings whose (from|file) is NOT dispositioned.
 *            With --email, sends ONE email (Resend) iff new.length > 0.
 *            Read-only; always exits 0 (informational, never fails CI).
 *
 * Key is `from|file` (the misrouted file's identity), NOT `from|to|file` — the
 * matcher's suggested `to` can shift between runs, but "leave this file where it
 * is" is about the file, not the guess. Caveat: if a missing production later
 * gets added to shows.json and the file becomes genuinely movable, remove its
 * disposition (the report won't auto-detect that transition).
 *
 * Usage:
 *   node scripts/disposition-misroute.js add --from=ID --to=ID --file=F.json --reason="..."
 *   node scripts/disposition-misroute.js report [--email]
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const AUDIT = path.join(ROOT, 'data/audit/slug-misroute-audit.json');
const DISP = path.join(ROOT, 'data/audit/slug-misroute-dispositioned.json');

const argv = process.argv.slice(2);
const mode = argv[0];
const flag = (n) => { const a = argv.find(x => x.startsWith(`--${n}=`)); return a ? a.slice(n.length + 3) : undefined; };
const has = (n) => argv.includes(`--${n}`);

const fileKey = (f) => `${f.from}|${f.file}`;

function loadDisp() {
  if (!fs.existsSync(DISP)) return { version: 1, updatedAt: null, dispositions: [] };
  try { return JSON.parse(fs.readFileSync(DISP, 'utf8')); } catch { return { version: 1, updatedAt: null, dispositions: [] }; }
}

function cmdAdd() {
  const from = flag('from'), to = flag('to'), file = flag('file'), reason = flag('reason');
  if (!from || !file || !reason) { console.error('add requires --from --file --reason (--to optional)'); process.exit(2); }
  const d = loadDisp();
  const key = `${from}|${file}`;
  const existing = d.dispositions.find(x => `${x.from}|${x.file}` === key);
  if (existing) { existing.to = to || existing.to; existing.reason = reason; existing.updatedAt = new Date().toISOString(); console.log('updated disposition for', key); }
  else { d.dispositions.push({ from, to: to || null, file, reason, addedAt: new Date().toISOString() }); console.log('added disposition for', key); }
  d.updatedAt = new Date().toISOString();
  d.dispositions.sort((a, b) => (`${a.from}|${a.file}`).localeCompare(`${b.from}|${b.file}`));
  fs.writeFileSync(DISP, JSON.stringify(d, null, 2) + '\n');
  console.log(`  ${d.dispositions.length} total dispositions in ${path.relative(ROOT, DISP)}`);
}

async function cmdReport() {
  if (!fs.existsSync(AUDIT)) { console.log('No audit file yet — nothing to report.'); return; }
  const audit = JSON.parse(fs.readFileSync(AUDIT, 'utf8'));
  const findings = audit.findings || [];
  const disp = new Set(loadDisp().dispositions.map(fileKey));
  const fresh = findings.filter(f => !disp.has(fileKey(f)));

  console.log(`slug-misroute report: ${findings.length} in audit, ${disp.size} dispositioned, ${fresh.length} NEW`);
  for (const f of fresh.slice(0, 50)) {
    console.log(`  NEW  ${f.from} -> ${f.to}  (${f.file})  [${(f.warnings || []).join(',') || 'class-' + (f.class || '?')}]`);
  }
  // CI annotation for the Actions log even without email.
  if (fresh.length > 0) console.log(`::warning::${fresh.length} new slug-misroute finding(s) not yet dispositioned`);

  if (has('email') && fresh.length > 0) {
    const { sendAlert } = require('./lib/discord-notify');
    const rows = fresh.slice(0, 30).map(f => ({ name: `${f.from} → ${f.to}`, value: `${f.file} (article ${f.articleYear || '?'}, ${(f.warnings || []).join(',') || 'class-' + (f.class || '?')})` }));
    await sendAlert({
      title: `${fresh.length} new slug-misroute finding(s)`,
      severity: 'warning',
      email: true,
      description:
        `${fresh.length} review file(s) appear misrouted and are not yet dispositioned. ` +
        `Nothing was changed automatically. To triage LOCALLY:\n` +
        `1) REVIEW_TEXTS_DIR=~/broadway-review-texts node scripts/audit-slug-match-routing.js\n` +
        `2) REVIEW_TEXTS_DIR=~/broadway-review-texts node scripts/verify-misroute-content.js --include-flagged --include-oos\n` +
        `3) gated apply per scripts/apply-slug-misroute-whitelist.js header (snapshot → ff-only → --apply → rebuild → spot-check)\n` +
        `To silence a finding you've decided to leave: node scripts/disposition-misroute.js add --from=ID --file=F --reason="..."`,
      fields: rows,
    });
  }
}

(async () => {
  if (mode === 'add') cmdAdd();
  else if (mode === 'report') await cmdReport();
  else { console.error('Usage: disposition-misroute.js add --from --to --file --reason | report [--email]'); process.exit(2); }
})();
