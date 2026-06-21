#!/usr/bin/env node
/**
 * Weekly Secret & Service Health Check
 *
 * Tests all critical API keys and tokens by making minimal free API calls.
 * Alerts via Discord + email if any service is unreachable or key is invalid.
 *
 * Checks:
 *   1. Anthropic API key (list models)
 *   2. OpenAI API key (list models)
 *   3. Gemini API key (list models)
 *   4. OpenRouter API key (check key info + remaining credits)
 *   5. ScrapingBee API key (usage endpoint)
 *   6. Bright Data zone status ($BRIGHTDATA_ZONE / web_unlocker2 active/disabled)
 *   7. Private repo PAT (API call to private repo)
 *   7. Vercel token (get user info)
 *   8. Sentry auth token (get project)
 *   9. Resend API key (list domains)
 *
 * Exit code: 0 = all pass, 1 = failures detected
 */

const https = require('https');

// --- HTTP helpers ---

function httpsGet(url, headers = {}) {
  return new Promise((resolve) => {
    const parsed = new URL(url);
    const options = {
      hostname: parsed.hostname,
      path: parsed.pathname + parsed.search,
      method: 'GET',
      headers: { ...headers },
      timeout: 15000,
    };

    const req = https.request(options, (res) => {
      let body = '';
      res.on('data', (chunk) => body += chunk);
      res.on('end', () => resolve({ status: res.statusCode, body, headers: res.headers }));
    });

    req.on('error', (err) => resolve({ status: 0, body: err.message, headers: {} }));
    req.on('timeout', () => { req.destroy(); resolve({ status: 0, body: 'timeout', headers: {} }); });
    req.end();
  });
}

function httpsPost(url, body, headers = {}) {
  return new Promise((resolve) => {
    const parsed = new URL(url);
    const options = {
      hostname: parsed.hostname,
      path: parsed.pathname + parsed.search,
      method: 'POST',
      headers: { ...headers, 'Content-Length': Buffer.byteLength(body) },
      timeout: 15000,
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => resolve({ status: res.statusCode, body: data, headers: res.headers }));
    });

    req.on('error', (err) => resolve({ status: 0, body: err.message, headers: {} }));
    req.on('timeout', () => { req.destroy(); resolve({ status: 0, body: 'timeout', headers: {} }); });
    req.write(body);
    req.end();
  });
}

// --- Checks ---

async function checkAnthropic() {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return { name: 'Anthropic', status: 'skip', message: 'Key not set' };

  const res = await httpsGet('https://api.anthropic.com/v1/models', {
    'x-api-key': key,
    'anthropic-version': '2023-06-01',
  });

  if (res.status === 200) return { name: 'Anthropic', status: 'pass', message: 'Key valid' };
  if (res.status === 401) return { name: 'Anthropic', status: 'fail', message: 'Key invalid or revoked' };
  return { name: 'Anthropic', status: 'warn', message: `Unexpected status ${res.status}` };
}

async function checkOpenAI() {
  const key = process.env.OPENAI_API_KEY;
  if (!key) return { name: 'OpenAI', status: 'skip', message: 'Key not set' };

  const res = await httpsGet('https://api.openai.com/v1/models', {
    'Authorization': `Bearer ${key}`,
  });

  if (res.status === 200) return { name: 'OpenAI', status: 'pass', message: 'Key valid' };
  if (res.status === 401) return { name: 'OpenAI', status: 'fail', message: 'Key invalid or revoked' };
  if (res.status === 429) return { name: 'OpenAI', status: 'warn', message: 'Rate limited or quota exceeded' };
  return { name: 'OpenAI', status: 'warn', message: `Unexpected status ${res.status}` };
}

async function checkGemini() {
  const key = process.env.GEMINI_API_KEY;
  if (!key) return { name: 'Gemini', status: 'skip', message: 'Key not set' };

  const res = await httpsGet(`https://generativelanguage.googleapis.com/v1beta/models?key=${key}`);

  if (res.status === 200) return { name: 'Gemini', status: 'pass', message: 'Key valid' };
  if (res.status === 400 || res.status === 403) return { name: 'Gemini', status: 'fail', message: 'Key invalid or restricted' };
  return { name: 'Gemini', status: 'warn', message: `Unexpected status ${res.status}` };
}

async function checkOpenRouter() {
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) return { name: 'OpenRouter', status: 'skip', message: 'Key not set' };

  const res = await httpsGet('https://openrouter.ai/api/v1/key', {
    'Authorization': `Bearer ${key}`,
  });

  if (res.status === 401) return { name: 'OpenRouter', status: 'fail', message: 'Key invalid or revoked' };
  if (res.status !== 200) return { name: 'OpenRouter', status: 'warn', message: `Unexpected status ${res.status}` };

  try {
    const data = JSON.parse(res.body);
    const remaining = data.data?.limit_remaining;
    const usage = data.data?.usage;
    const limit = data.data?.limit;

    if (remaining !== null && remaining !== undefined && remaining < 1.0) {
      return { name: 'OpenRouter', status: 'fail', message: `Credits critically low: $${remaining.toFixed(2)} remaining (used $${usage?.toFixed(2)} of $${limit?.toFixed(2)})` };
    }
    if (remaining !== null && remaining !== undefined && remaining < 5.0) {
      return { name: 'OpenRouter', status: 'warn', message: `Credits low: $${remaining.toFixed(2)} remaining` };
    }
    const msg = remaining !== null && remaining !== undefined
      ? `Key valid ($${remaining.toFixed(2)} remaining)`
      : `Key valid (no limit set, $${(usage || 0).toFixed(2)} used)`;
    return { name: 'OpenRouter', status: 'pass', message: msg };
  } catch {
    return { name: 'OpenRouter', status: 'pass', message: 'Key valid (could not parse balance)' };
  }
}

async function checkScrapingBee() {
  const key = process.env.SCRAPINGBEE_API_KEY;
  if (!key) return { name: 'ScrapingBee', status: 'skip', message: 'Key not set' };

  // ScrapingBee usage endpoint
  const res = await httpsGet(`https://app.scrapingbee.com/api/v1/usage?api_key=${key}`);

  if (res.status === 200) {
    try {
      const data = JSON.parse(res.body);
      const used = data.used_api_credit || 0;
      const max = data.max_api_credit || 0;
      const remaining = max - used;
      const pctUsed = max > 0 ? Math.round((used / max) * 100) : 0;

      if (remaining <= 0) return { name: 'ScrapingBee', status: 'fail', message: `Credits exhausted (${used}/${max} used)` };
      if (pctUsed >= 75) return { name: 'ScrapingBee', status: 'warn', message: `${pctUsed}% credits used (${remaining} remaining) — opening nights at risk` };
      if (pctUsed >= 50) return { name: 'ScrapingBee', status: 'warn', message: `${pctUsed}% credits used (${remaining} remaining) — monitor before opening nights` };
      return { name: 'ScrapingBee', status: 'pass', message: `${remaining} credits remaining (${pctUsed}% used)` };
    } catch {
      return { name: 'ScrapingBee', status: 'pass', message: 'Key valid (could not parse usage)' };
    }
  }
  if (res.status === 401 || res.status === 403) return { name: 'ScrapingBee', status: 'fail', message: 'Key invalid' };
  return { name: 'ScrapingBee', status: 'warn', message: `Unexpected status ${res.status}` };
}

async function createNewBrightDataZone(token, oldZoneName) {
  // Generate new zone name: web_unlocker_{n+1}
  const match = oldZoneName.match(/(\d+)$/);
  const nextNum = match ? parseInt(match[1]) + 1 : 2;
  const newZone = `web_unlocker${nextNum}`;

  const body = JSON.stringify({ zone: { name: newZone }, plan: { type: 'unblocker', product: 'unblocker' } });
  const res = await httpsPost('https://api.brightdata.com/zone', body, {
    'Authorization': `Bearer ${token}`,
    'Content-Type': 'application/json',
  });

  if (res.status >= 200 && res.status < 300) {
    return newZone;
  }
  // If duplicate name, try with timestamp suffix
  if (res.body && res.body.includes('Duplicate')) {
    const tsZone = `web_unlocker_${Date.now().toString(36)}`;
    const res2 = await httpsPost('https://api.brightdata.com/zone', JSON.stringify({
      zone: { name: tsZone }, plan: { type: 'unblocker', product: 'unblocker' }
    }), { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' });
    if (res2.status >= 200 && res2.status < 300) return tsZone;
  }
  return null;
}

async function updateGitHubSecret(secretName, value) {
  const { execSync } = require('child_process');
  try {
    execSync(`gh secret set ${secretName} --body "${value}"`, { stdio: 'pipe', timeout: 15000 });
    return true;
  } catch {
    return false;
  }
}

async function checkBrightData() {
  const token = process.env.BRIGHTDATA_TOKEN;
  if (!token) return { name: 'Bright Data', status: 'skip', message: 'Token not set' };

  const zoneName = process.env.BRIGHTDATA_ZONE || 'web_unlocker2';
  const res = await httpsGet(`https://api.brightdata.com/zone?zone=${zoneName}`, {
    'Authorization': `Bearer ${token}`,
  });

  if (res.status === 401 || res.status === 403) {
    return { name: 'Bright Data', status: 'fail', message: 'Token invalid or unauthorized' };
  }
  if (res.status !== 200) {
    return { name: 'Bright Data', status: 'warn', message: `Unexpected status ${res.status}` };
  }

  try {
    const data = JSON.parse(res.body);
    const disableReason = data.plan?.disable || data.disable;
    if (disableReason) {
      // Auto-recover: create a new zone and update GitHub secret
      console.log(`  ⚠ Zone ${zoneName} disabled: "${disableReason}" — attempting auto-recovery...`);
      const newZone = await createNewBrightDataZone(token, zoneName);
      if (newZone) {
        const secretUpdated = await updateGitHubSecret('BRIGHTDATA_ZONE', newZone);
        if (secretUpdated) {
          return { name: 'Bright Data', status: 'pass', message: `Zone ${zoneName} was disabled (${disableReason}). Auto-recovered: created ${newZone} and updated BRIGHTDATA_ZONE secret` };
        }
        return { name: 'Bright Data', status: 'warn', message: `Created new zone ${newZone} but failed to update GitHub secret — manually set BRIGHTDATA_ZONE=${newZone}` };
      }
      return { name: 'Bright Data', status: 'fail', message: `Zone ${zoneName} disabled: "${disableReason}" — auto-recovery failed, create new zone manually at brightdata.com` };
    }
    return { name: 'Bright Data', status: 'pass', message: `${zoneName} zone active` };
  } catch {
    return { name: 'Bright Data', status: 'warn', message: 'Zone response unparseable' };
  }
}

async function checkPrivateRepoPAT() {
  const token = process.env.REVIEW_TEXTS_TOKEN;
  if (!token) return { name: 'Private Repo PAT', status: 'skip', message: 'Token not set' };

  const headers = {
    'Authorization': `token ${token}`,
    'User-Agent': 'broadway-scorecard-health-check',
    'Accept': 'application/vnd.github+json',
  };

  // Check both private repos that use this token
  const [reviewTexts, coreData] = await Promise.all([
    httpsGet('https://api.github.com/repos/thomaspryor/broadway-review-texts', headers),
    httpsGet('https://api.github.com/repos/thomaspryor/broadway-scorecard-data', headers),
  ]);

  if (reviewTexts.status === 401 || coreData.status === 401) {
    return { name: 'Private Repo PAT', status: 'fail', message: 'Token invalid or revoked — ALL workflows will fail' };
  }

  const issues = [];
  if (reviewTexts.status !== 200) issues.push(`review-texts: ${reviewTexts.status}`);
  if (coreData.status !== 200) issues.push(`scorecard-data: ${coreData.status}`);

  if (issues.length > 0) {
    return { name: 'Private Repo PAT', status: 'fail', message: `Repo access failed — ${issues.join(', ')}` };
  }

  // Fine-grained PATs can return 200 on repo metadata but 403 on contents (expired or missing permission).
  // Test the exact contents endpoint the BTC submission route uses.
  const contentsCheck = await httpsGet(
    'https://api.github.com/repos/thomaspryor/broadway-scorecard-data/contents/data/beat-the-critics-submissions.jsonl',
    headers,
  );
  if (contentsCheck.status !== 200) {
    return { name: 'Private Repo PAT', status: 'fail', message: `Token cannot read BTC submissions file (${contentsCheck.status}) — submissions will fail` };
  }

  return { name: 'Private Repo PAT', status: 'pass', message: 'Token valid, both private repos accessible, contents readable' };
}

async function checkDispatchPAT() {
  const token = process.env.GH_DISPATCH_TOKEN;
  if (!token) return { name: 'Dispatch PAT (submit-review)', status: 'fail', message: 'GH_DISPATCH_TOKEN not set — /api/submit-review will return 503' };

  const headers = {
    'Authorization': `token ${token}`,
    'User-Agent': 'broadway-scorecard-health-check',
    'Accept': 'application/vnd.github+json',
  };

  // Test that the PAT can list issues on the public repo (issues:write required)
  const res = await httpsGet('https://api.github.com/repos/thomaspryor/Broadwayscore/issues?state=open&per_page=1', headers);
  if (res.status === 401) return { name: 'Dispatch PAT (submit-review)', status: 'fail', message: 'Token invalid or expired — /api/submit-review will silently 500' };
  if (res.status === 403) return { name: 'Dispatch PAT (submit-review)', status: 'fail', message: 'Token lacks issues:write permission — submissions will fail' };
  if (res.status !== 200) return { name: 'Dispatch PAT (submit-review)', status: 'fail', message: `Unexpected status ${res.status}` };

  return { name: 'Dispatch PAT (submit-review)', status: 'pass', message: 'Token valid, issues:read confirmed' };
}

async function checkVercel() {
  const token = process.env.VERCEL_TOKEN;
  if (!token) return { name: 'Vercel', status: 'skip', message: 'Token not set' };

  const res = await httpsGet('https://api.vercel.com/v2/user', {
    'Authorization': `Bearer ${token}`,
  });

  if (res.status === 200) return { name: 'Vercel', status: 'pass', message: 'Token valid' };
  if (res.status === 401 || res.status === 403) return { name: 'Vercel', status: 'fail', message: 'Token invalid or revoked — deploys will fail' };
  return { name: 'Vercel', status: 'warn', message: `Unexpected status ${res.status}` };
}

async function checkSentry() {
  const token = process.env.SENTRY_AUTH_TOKEN;
  if (!token) return { name: 'Sentry', status: 'skip', message: 'Token not set' };

  const res = await httpsGet('https://sentry.io/api/0/projects/broadway-scorecard/broadway-scorecard/', {
    'Authorization': `Bearer ${token}`,
  });

  if (res.status === 200) return { name: 'Sentry', status: 'pass', message: 'Token valid' };
  if (res.status === 401) return { name: 'Sentry', status: 'fail', message: 'Token invalid or expired' };
  return { name: 'Sentry', status: 'warn', message: `Unexpected status ${res.status}` };
}

async function checkResend() {
  const key = process.env.RESEND_API_KEY;
  if (!key) return { name: 'Resend', status: 'skip', message: 'Key not set' };

  const res = await httpsGet('https://api.resend.com/domains', {
    'Authorization': `Bearer ${key}`,
  });

  if (res.status === 200) return { name: 'Resend', status: 'pass', message: 'Key valid' };
  if (res.status === 401) return { name: 'Resend', status: 'fail', message: 'Key invalid — email sending will fail' };
  return { name: 'Resend', status: 'warn', message: `Unexpected status ${res.status}` };
}

async function checkFormspreeSubscribers() {
  const apiKey = process.env.FORMSPREE_SUBSCRIBER_API_KEY;
  const formId = process.env.FORMSPREE_SUBSCRIBER_FORM_ID;
  if (!apiKey || !formId) return { name: 'Formspree (Subscribers)', status: 'skip', message: 'API key or form ID not set' };

  const res = await httpsGet(`https://formspree.io/api/0/forms/${formId}/submissions?limit=10`, {
    'Authorization': `Bearer ${apiKey}`,
    'Accept': 'application/json',
  });

  if (res.status === 401 || res.status === 403) return { name: 'Formspree (Subscribers)', status: 'fail', message: 'API key invalid — cannot verify email capture' };
  if (res.status !== 200) return { name: 'Formspree (Subscribers)', status: 'warn', message: `Unexpected status ${res.status}` };

  try {
    const data = JSON.parse(res.body);
    const submissions = data.submissions || [];
    if (submissions.length === 0) {
      return { name: 'Formspree (Subscribers)', status: 'warn', message: 'Zero submissions found — email capture may be broken' };
    }
    // Check most recent submission age
    const newest = submissions[0];
    const newestDate = newest._date ? new Date(newest._date) : null;
    if (newestDate) {
      const daysAgo = Math.floor((Date.now() - newestDate.getTime()) / (1000 * 60 * 60 * 24));
      if (daysAgo > 14) {
        return { name: 'Formspree (Subscribers)', status: 'warn', message: `Last submission was ${daysAgo} days ago — email capture may be broken` };
      }
      return { name: 'Formspree (Subscribers)', status: 'pass', message: `Form active (last submission ${daysAgo}d ago, ${submissions.length} recent)` };
    }
    return { name: 'Formspree (Subscribers)', status: 'pass', message: `Form accessible (${submissions.length} submissions)` };
  } catch {
    return { name: 'Formspree (Subscribers)', status: 'pass', message: 'API key valid (could not parse submissions)' };
  }
}

async function checkTheatrToken() {
  // Theatr uses self-rotating refresh tokens — we cannot test the token without
  // burning it. Instead, watch the freshness of the most recent successful
  // `update-theatr.yml` run. If it's been failing for >10 days, the refresh
  // token has expired (Theatr 30-day window) and audience scores are going stale.
  const repo = process.env.GITHUB_REPOSITORY || 'thomaspryor/Broadwayscore';
  const ghToken = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
  if (!ghToken) return { name: 'Theatr Token', status: 'skip', message: 'GH_TOKEN not set — cannot check workflow history' };

  const res = await httpsGet(
    `https://api.github.com/repos/${repo}/actions/workflows/update-theatr.yml/runs?per_page=20`,
    {
      'Authorization': `Bearer ${ghToken}`,
      'Accept': 'application/vnd.github+json',
      'User-Agent': 'broadwayscorecard-health-check',
    }
  );

  if (res.status === 404) return { name: 'Theatr Token', status: 'skip', message: 'update-theatr.yml not found' };
  if (res.status !== 200) return { name: 'Theatr Token', status: 'warn', message: `GitHub API status ${res.status}` };

  let data;
  try { data = JSON.parse(res.body); } catch { return { name: 'Theatr Token', status: 'warn', message: 'Could not parse runs response' }; }

  const runs = data.workflow_runs || [];
  const lastSuccess = runs.find(r => r.conclusion === 'success');
  if (!lastSuccess) {
    return { name: 'Theatr Token', status: 'fail', message: 'No successful Theatr runs in last 20 attempts — token likely expired' };
  }

  const daysAgo = Math.floor((Date.now() - new Date(lastSuccess.created_at).getTime()) / (1000 * 60 * 60 * 24));
  if (daysAgo > 14) {
    return { name: 'Theatr Token', status: 'fail', message: `Last successful run ${daysAgo}d ago — refresh token expired (30-day window). Audience scores stale.` };
  }
  if (daysAgo > 9) {
    return { name: 'Theatr Token', status: 'warn', message: `Last successful run ${daysAgo}d ago — token nearing 30-day expiry. Refresh soon.` };
  }
  return { name: 'Theatr Token', status: 'pass', message: `Last successful run ${daysAgo}d ago` };
}

async function checkFormspreeFeedback() {
  const apiKey = process.env.FORMSPREE_TOKEN;
  if (!apiKey) return { name: 'Formspree (Feedback)', status: 'skip', message: 'Token not set' };

  // Feedback form ID from the hardcoded fallback
  const formId = 'mojdjwqo';
  const res = await httpsGet(`https://formspree.io/api/0/forms/${formId}/submissions?limit=1`, {
    'Authorization': `Bearer ${apiKey}`,
    'Accept': 'application/json',
  });

  if (res.status === 401 || res.status === 403) return { name: 'Formspree (Feedback)', status: 'fail', message: 'Token invalid' };
  if (res.status === 200) return { name: 'Formspree (Feedback)', status: 'pass', message: 'Token valid, form accessible' };
  return { name: 'Formspree (Feedback)', status: 'warn', message: `Unexpected status ${res.status}` };
}

// --- Main ---

async function main() {
  console.log('=== Weekly Secret & Service Health Check ===\n');

  const checks = [
    checkAnthropic,
    checkOpenAI,
    checkGemini,
    checkOpenRouter,
    checkScrapingBee,
    checkBrightData,
    checkPrivateRepoPAT,
    checkDispatchPAT,
    checkVercel,
    checkSentry,
    checkResend,
    checkTheatrToken,
    checkFormspreeSubscribers,
    checkFormspreeFeedback,
  ];

  // Run all checks in parallel
  const results = await Promise.all(checks.map(fn => fn().catch(err => ({
    name: fn.name.replace('check', ''),
    status: 'warn',
    message: `Check threw error: ${err.message}`,
  }))));

  // Print results
  const icons = { pass: '\u2705', fail: '\u274C', warn: '\u26A0\uFE0F', skip: '\u23ED\uFE0F' };
  for (const r of results) {
    console.log(`${icons[r.status] || '?'} ${r.name}: ${r.message}`);
  }

  const failures = results.filter(r => r.status === 'fail');
  const warnings = results.filter(r => r.status === 'warn');
  const passed = results.filter(r => r.status === 'pass');

  console.log(`\n--- Summary: ${passed.length} pass, ${warnings.length} warn, ${failures.length} fail ---\n`);

  // Send alert if any failures
  if (failures.length > 0) {
    const { sendAlert } = require('./lib/discord-notify');

    const fields = failures.map(f => ({
      name: f.name,
      value: f.message,
      inline: false,
    }));

    if (warnings.length > 0) {
      fields.push({
        name: `${warnings.length} Warning(s)`,
        value: warnings.map(w => `${w.name}: ${w.message}`).join('\n'),
        inline: false,
      });
    }

    await sendAlert({
      title: `Secret Health Check — ${failures.length} Failed`,
      description: `${failures.length} critical service${failures.length > 1 ? 's' : ''} ${failures.length > 1 ? 'are' : 'is'} down or has expired credentials. Immediate action required.`,
      severity: 'error',
      email: true,
      fields: fields.slice(0, 10),
    }).catch(e => console.error('[Alert] Failed to send:', e.message));

    process.exit(1);
  }

  // Send warning-only alert (Discord only, no email)
  if (warnings.length > 0) {
    const { sendAlert } = require('./lib/discord-notify');

    await sendAlert({
      title: `Secret Health Check — ${warnings.length} Warning(s)`,
      description: `All critical services are up, but ${warnings.length} warning${warnings.length > 1 ? 's' : ''} detected.`,
      severity: 'warning',
      fields: warnings.map(w => ({ name: w.name, value: w.message, inline: false })),
    }).catch(e => console.error('[Alert] Failed to send:', e.message));
  }

  console.log('All critical services healthy.');
}

main().catch(err => {
  console.error('Health check failed:', err);
  process.exit(1);
});
