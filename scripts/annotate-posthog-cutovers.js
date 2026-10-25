#!/usr/bin/env node
/**
 * Create a PostHog project annotation for each entry in
 * scripts/lib/analytics-cutovers.js that does not have one yet (BRO-5984).
 * Idempotent: matches existing annotations by content.
 *
 *   node scripts/annotate-posthog-cutovers.js [--dry-run]
 *
 * Needs POSTHOG_PERSONAL_API_KEY and POSTHOG_PROJECT_ID.
 */
const { CUTOVERS } = require('./lib/analytics-cutovers');
const { hasHelpFlag } = require('./lib/cli-help.js');

const HOST = 'https://us.posthog.com';

async function api(path, init = {}) {
  const res = await fetch(`${HOST}/api/projects/${process.env.POSTHOG_PROJECT_ID}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${process.env.POSTHOG_PERSONAL_API_KEY}`, 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(30000),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`PostHog API ${res.status}: ${text.slice(0, 200)}`);
  return JSON.parse(text);
}

async function main() {
  if (hasHelpFlag(process.argv.slice(2))) {
    console.log('Usage: node scripts/annotate-posthog-cutovers.js [--dry-run]\nCreates a PostHog annotation for each entry in scripts/lib/analytics-cutovers.js that has none.');
    return;
  }
  const dry = process.argv.includes('--dry-run');
  if (!process.env.POSTHOG_PERSONAL_API_KEY || !process.env.POSTHOG_PROJECT_ID) {
    console.error('POSTHOG_PERSONAL_API_KEY and POSTHOG_PROJECT_ID are required');
    process.exit(2);
  }
  const existing = (await api('/annotations/?limit=200')).results || [];
  for (const c of CUTOVERS) {
    const content = `Analytics cutover: ${c.label}`;
    if (existing.some((a) => a.content === content && !a.deleted)) { console.log(`exists: ${c.date} ${content}`); continue; }
    if (dry) { console.log(`would create: ${c.date} ${content}`); continue; }
    const created = await api('/annotations/', {
      method: 'POST',
      body: JSON.stringify({ content, date_marker: `${c.date}T12:00:00Z`, scope: 'project' }),
    });
    console.log(`created annotation ${created.id} for ${c.date}`);
  }
}

if (require.main === module) main().catch((e) => { console.error(e.message); process.exit(1); });
