'use strict';

const { execFileSync } = require('child_process');
const { createHash } = require('crypto');
const fs = require('fs');
const quality = require('./content-quality');

// Deliberately closed registry. Title exclusions and other families stay manual.
// These are the actual runtime decisions, including pattern evaluation order.
const GUARDS = {
  NEWSLETTER_PATTERNS: text => quality.isGarbageContent(text).isGarbage === false,
  HORROR_FILM_PATTERNS: text => quality.detectHorrorFilmContent(text).detected === false,
};
const GUARD_NAMES = {
  NEWSLETTER_PATTERNS: 'isGarbageContent',
  HORROR_FILM_PATTERNS: 'detectHorrorFilmContent',
};

function recordGuardHit(entry, { family, text, review, show, file }) {
  if (!Object.hasOwn(GUARDS, family)) return;
  const proof = entry.guardProof ||= { checked: 0, absorbed: 0, outlets: [], failures: [] };
  proof.checked++;
  if (GUARDS[family](text)) proof.absorbed++;
  else if (proof.failures.length < 3) proof.failures.push({ show, file });
  // Only structured metadata, never a URL-derived outlet or review prose.
  const outlet = typeof review.outlet === 'string' ? review.outlet : review.outletId;
  if (typeof outlet === 'string' && !proof.outlets.includes(outlet) && proof.outlets.length < 5) {
    proof.outlets.push(outlet);
  }
}

function planRecalibration({ violations, counts, full, scanned, date = new Date().toISOString().slice(0, 10) }) {
  if (!full || scanned < 1) throw new Error('Recalibration requires a nonempty full corpus scan');
  const updates = [];
  const refused = [];
  for (const violation of violations) {
    const { family, index, hits } = violation;
    const proof = counts[family]?.[index]?.guardProof;
    if (!Object.hasOwn(GUARDS, family) || !proof || proof.checked !== hits || proof.absorbed !== hits) {
      refused.push({ ...violation, guardProof: proof, reason: Object.hasOwn(GUARDS, family)
        ? 'Runtime guard did not absorb every matched file' : 'No registered absorbing runtime guard' });
      continue;
    }
    const allow = Math.ceil(hits * 1.3);
    updates.push({
      key: `${family}::${index}`, allow,
      calibration: {
        commit: 'pending', date, rawHits: hits, headroom: allow / hits,
        guard: GUARD_NAMES[family], checked: proof.checked, absorbed: proof.absorbed,
        sampleOutlets: proof.outlets,
        note: `BRO-2509: full corpus scan (${scanned} eligible reviews); ${GUARD_NAMES[family]} directly absorbed ${hits}/${hits} matched files. Sample outlets: ${proof.outlets.join(', ') || 'metadata unavailable'}.`,
      },
    });
  }
  return { updates, refused };
}

// Edit only the two documented object literals, replacing existing keys rather
// than appending duplicate properties. Refuse unexpected source layouts.
function renderCalibration(source, updates) {
  let out = source;
  for (const name of ['PATTERN_ALLOWLIST', 'PATTERN_CALIBRATION']) {
    const block = new RegExp(`(const ${name} = \\{\\n)([\\s\\S]*?)(^\\};)`, 'm');
    if (!block.test(out)) throw new Error(`Cannot find ${name} object`);
    out = out.replace(block, (_, start, body, end) => {
      for (const update of updates) {
        if (!/^(NEWSLETTER_PATTERNS|HORROR_FILM_PATTERNS)::\d+$/.test(update.key)) {
          throw new Error(`Unregistered calibration key: ${update.key}`);
        }
        const value = name === 'PATTERN_ALLOWLIST' ? String(update.allow)
          : JSON.stringify(update.calibration, null, 2).replace(/\n/g, '\n  ');
        const entry = `  '${update.key}': ${value},\n`;
        const existing = name === 'PATTERN_ALLOWLIST'
          ? new RegExp(`^  '${update.key}':[^\\n]*\\n`, 'm')
          : new RegExp(`^  '${update.key}': \\{[\\s\\S]*?^  \\},?\\n`, 'm');
        body = existing.test(body) ? body.replace(existing, () => entry) : body + entry;
      }
      return start + body + end;
    });
  }
  return out;
}

function githubApi(method, endpoint, body) {
  const args = ['api', '--method', method, endpoint];
  if (body) args.push('--input', '-');
  try {
    return JSON.parse(execFileSync('gh', args, {
      input: body ? JSON.stringify(body) : undefined,
      encoding: 'utf8', timeout: 60000, stdio: ['pipe', 'pipe', 'pipe'],
    }));
  } catch {
    // CLI errors can include request bodies. Never echo those or credentials.
    throw new Error(`GitHub ${method} ${endpoint.split('?')[0]} failed; check gh authentication and repository contents/pull-request write permissions`);
  }
}

// GitHub Git API keeps the caller's checkout/branch/index untouched. Content is
// checked against main before any write, so unrelated local edits cannot leak.
function openCalibrationPR({ before, after, updates, api = githubApi, repo = 'thomaspryor/Broadwayscore' }) {
  if (!updates.length || before === after) throw new Error('No calibration changes to publish');
  const file = 'scripts/audit-regex-patterns.js';
  const branch = `codex/regex-recalibrate-${createHash('sha256').update(after).digest('hex').slice(0, 12)}`;
  const prefix = `repos/${repo}`;
  const existing = api('GET', `${prefix}/pulls?state=open&head=${repo.split('/')[0]}:${branch}`);
  if (existing.length) return existing[0].html_url;
  const refs = api('GET', `${prefix}/git/matching-refs/heads/${branch}`);
  const branchExists = refs.some(ref => ref.ref === `refs/heads/${branch}`);
  const base = api('GET', `${prefix}/branches/main`);
  const remote = api('GET', `${prefix}/contents/${file}?ref=${base.commit.sha}`);
  if (Buffer.from(remote.content, 'base64').toString('utf8') !== before) {
    throw new Error('Audit source differs from main; rerun on a clean current checkout');
  }
  if (branchExists) {
    const saved = api('GET', `${prefix}/contents/${file}?ref=${branch}`);
    if (Buffer.from(saved.content, 'base64').toString('utf8') !== after) {
      throw new Error('Existing recalibration branch has different content; refusing to overwrite');
    }
  } else {
    const tree = api('POST', `${prefix}/git/trees`, {
      base_tree: base.commit.commit.tree.sha,
      tree: [{ path: file, mode: '100755', type: 'blob', content: after }],
    });
    const commit = api('POST', `${prefix}/git/commits`, {
      message: 'fix: recalibrate guard-protected regex allowances (BRO-2509)',
      tree: tree.sha, parents: [base.commit.sha],
    });
    api('POST', `${prefix}/git/refs`, { ref: `refs/heads/${branch}`, sha: commit.sha });
  }
  const pr = api('POST', `${prefix}/pulls`, {
    title: 'fix: recalibrate guard-protected regex allowances (BRO-2509)', head: branch, base: 'main',
    body: 'Every matched eligible review passed its registered runtime guard in a full corpus scan. Thresholds include 30% headroom.\n\n'
      + updates.map(u => `- ${u.key}: ${u.calibration.rawHits} raw hits, allowance ${u.allow}; ${u.calibration.guard} absorbed ${u.calibration.absorbed}/${u.calibration.checked}.`).join('\n')
      + '\n\nValidation: node --test scripts/audit-regex-patterns.test.mjs',
  });
  return pr.html_url;
}

function applyRecalibration({ filename, updates, publish = openCalibrationPR }) {
  if (!updates.length) return null;
  const before = fs.readFileSync(filename, 'utf8');
  const after = renderCalibration(before, updates);
  const pr = publish({ before, after, updates });
  fs.writeFileSync(filename, after);
  return pr;
}

module.exports = { recordGuardHit, planRecalibration, renderCalibration, openCalibrationPR, applyRecalibration };
