#!/usr/bin/env node
/**
 * check-formspree-health.js
 *
 * Verifies all Formspree forms are reachable and healthy WITHOUT submitting
 * canary data. Formspree emails the form owner on every submission, so
 * POST-based health checks spam the inbox (incident 2026-04-22).
 *
 * What this checks:
 *   1. Token is valid: GET /api/0/forms/{id}/submissions?limit=5 returns 2xx
 *   2. Form is reachable: same call succeeds (not 404)
 *   3. Form is receiving real traffic: at least one submission in last
 *      FRESHNESS_DAYS days — warn (not fail) if empty, since form may be
 *      idle (e.g. a market with no recent subscribers) rather than broken
 *
 * Why no canary POST:
 *   - Real users submit daily, so the POST path is continuously proven.
 *     If POST breaks, submission count flatlines and this check catches it.
 *   - Each canary POST triggered a notification email to the owner.
 *
 * Usage: node scripts/check-formspree-health.js
 *
 * Env: FORMSPREE_TOKEN, FORMSPREE_SUBSCRIBER_FORM_ID,
 *      FORMSPREE_FOLLOW_FORM_ID (optional),
 *      FORMSPREE_WESTEND_SUBSCRIBER_FORM_ID (optional)
 */

const FRESHNESS_DAYS = 14;

const FORMS = [
  {
    name: 'Broadway Subscriber',
    id: process.env.FORMSPREE_SUBSCRIBER_FORM_ID,
    token: process.env.FORMSPREE_SUBSCRIBER_API_KEY || process.env.FORMSPREE_TOKEN,
  },
  {
    name: 'Show Follow',
    id: process.env.FORMSPREE_FOLLOW_FORM_ID,
    token: process.env.FORMSPREE_FOLLOW_API_KEY || process.env.FORMSPREE_TOKEN,
  },
  {
    name: 'West End Subscriber',
    id: process.env.FORMSPREE_WESTEND_SUBSCRIBER_FORM_ID,
    token: process.env.FORMSPREE_WESTEND_SUBSCRIBER_API_KEY || process.env.FORMSPREE_TOKEN,
  },
].filter(f => f.id && f.token);

function parseSubmissionDate(s) {
  const raw = s._date || s.date || s.submitted_at || s.created_at;
  if (!raw) return null;
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? null : d;
}

async function checkForm(form) {
  const { name, id, token } = form;
  console.log(`\nChecking "${name}" (${id})...`);

  const apiUrl = `https://formspree.io/api/0/forms/${id}/submissions?limit=5`;
  const res = await fetch(apiUrl, {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!res.ok) {
    console.error(`  FAIL: API returned ${res.status} ${res.statusText}`);
    if (res.status === 401 || res.status === 403) {
      console.error(`  Hint: token invalid or lacks access to this form`);
    } else if (res.status === 404) {
      console.error(`  Hint: form ID not found — was the form deleted?`);
    }
    return { ok: false, warn: false };
  }

  const data = await res.json();
  const submissions = Array.isArray(data) ? data : (data.submissions || []);
  console.log(`  API: OK (${res.status}, ${submissions.length} recent submissions returned)`);

  if (submissions.length === 0) {
    console.warn(`  WARN: no submissions returned — form may be new or unused`);
    return { ok: true, warn: true };
  }

  const latest = submissions
    .map(parseSubmissionDate)
    .filter(Boolean)
    .sort((a, b) => b - a)[0];

  if (!latest) {
    console.warn(`  WARN: could not parse submission dates`);
    return { ok: true, warn: true };
  }

  const ageDays = (Date.now() - latest.getTime()) / (1000 * 60 * 60 * 24);
  const ageStr = ageDays < 1 ? `${Math.round(ageDays * 24)}h` : `${ageDays.toFixed(1)}d`;

  if (ageDays > FRESHNESS_DAYS) {
    console.warn(`  WARN: latest submission is ${ageStr} old (>${FRESHNESS_DAYS}d freshness target) — low-traffic form or POST path may be broken`);
    return { ok: true, warn: true };
  }

  console.log(`  ✓ "${name}" is healthy (latest submission ${ageStr} ago)`);
  return { ok: true, warn: false };
}

async function main() {
  if (FORMS.length === 0) {
    console.error('No form IDs configured');
    process.exit(1);
  }

  console.log(`Checking ${FORMS.length} Formspree forms (API-only, no canary POST)...`);

  const results = [];
  for (const form of FORMS) {
    try {
      const { ok, warn } = await checkForm(form);
      results.push({ ...form, ok, warn });
    } catch (e) {
      console.error(`  FAIL: ${e.message}`);
      results.push({ ...form, ok: false, warn: false });
    }
  }

  console.log('\n--- Summary ---');
  const failures = results.filter(r => !r.ok);
  const warnings = results.filter(r => r.ok && r.warn);
  for (const r of results) {
    const icon = !r.ok ? '✗' : r.warn ? '⚠' : '✓';
    console.log(`  ${icon} ${r.name} (${r.id})`);
  }

  if (failures.length > 0) {
    console.error(`\n${failures.length}/${results.length} forms FAILED health check`);
    process.exit(1);
  }

  if (warnings.length > 0) {
    console.log(`\n${warnings.length}/${results.length} forms healthy with warnings (low traffic or new)`);
  } else {
    console.log(`\nAll ${results.length} forms healthy`);
  }
}

main().catch(e => {
  console.error(`Fatal: ${e.message}`);
  process.exit(1);
});
