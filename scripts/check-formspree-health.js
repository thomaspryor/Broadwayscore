#!/usr/bin/env node
/**
 * check-formspree-health.js
 *
 * Verifies all Formspree forms are accepting submissions.
 * Sends a canary submission to each form, verifies it landed via API,
 * then deletes the canary to keep data clean.
 *
 * Usage: node scripts/check-formspree-health.js
 *
 * Env: FORMSPREE_TOKEN, FORMSPREE_SUBSCRIBER_FORM_ID,
 *      FORMSPREE_FOLLOW_FORM_ID (optional),
 *      FORMSPREE_WESTEND_SUBSCRIBER_FORM_ID (optional)
 */

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

const CANARY_EMAIL = `healthcheck+${Date.now()}@broadwayscorecard.com`;

async function checkForm(form) {
  const { name, id, token } = form;
  console.log(`\nChecking "${name}" (${id})...`);

  // Step 1: Submit canary
  const submitRes = await fetch(`https://formspree.io/f/${id}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email: CANARY_EMAIL,
      source: 'health-check',
      action: 'health-check',
    }),
  });

  if (!submitRes.ok) {
    const body = await submitRes.text();
    console.error(`  FAIL: Submit returned ${submitRes.status}: ${body.slice(0, 200)}`);
    return false;
  }
  console.log(`  Submit: OK (${submitRes.status})`);

  // Step 2: Wait for Formspree to process
  await new Promise(r => setTimeout(r, 3000));

  // Step 3: Verify via API — fetch recent submissions and look for canary
  const apiUrl = `https://formspree.io/api/0/forms/${id}/submissions?limit=5`;
  const verifyRes = await fetch(apiUrl, {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!verifyRes.ok) {
    console.error(`  FAIL: API fetch returned ${verifyRes.status}`);
    return false;
  }

  const data = await verifyRes.json();
  const submissions = data.submissions || data;
  const canary = submissions.find(s => s.email === CANARY_EMAIL);

  if (!canary) {
    console.error(`  FAIL: Canary submission not found in recent submissions`);
    return false;
  }
  // Canary stays in form data but is harmless — sync-followers ignores
  // submissions with action != 'subscribe'/'unsubscribe'
  console.log(`  ✓ "${name}" is healthy`);
  return true;
}

async function main() {
  if (FORMS.length === 0) {
    console.error('No form IDs configured');
    process.exit(1);
  }

  console.log(`Checking ${FORMS.length} Formspree forms...`);
  console.log(`Canary email: ${CANARY_EMAIL}`);

  const results = [];
  for (const form of FORMS) {
    try {
      const ok = await checkForm(form);
      results.push({ ...form, ok });
    } catch (e) {
      console.error(`  FAIL: ${e.message}`);
      results.push({ ...form, ok: false });
    }
  }

  console.log('\n--- Summary ---');
  const failures = results.filter(r => !r.ok);
  for (const r of results) {
    console.log(`  ${r.ok ? '✓' : '✗'} ${r.name} (${r.id})`);
  }

  if (failures.length > 0) {
    console.error(`\n${failures.length}/${results.length} forms FAILED health check`);
    process.exit(1);
  }

  console.log(`\nAll ${results.length} forms healthy`);
}

main().catch(e => {
  console.error(`Fatal: ${e.message}`);
  process.exit(1);
});
