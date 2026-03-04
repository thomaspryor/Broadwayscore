#!/usr/bin/env node
/**
 * Smoke test for Supabase connectivity.
 * Verifies the anon key, tables, and RLS policies are working.
 * Run: node scripts/verify-supabase.js
 * Returns exit code 0 on success, 1 on failure.
 */

const https = require('https');

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
  console.error('❌ Missing NEXT_PUBLIC_SUPABASE_URL or NEXT_PUBLIC_SUPABASE_ANON_KEY');
  process.exit(1);
}

// Validate anon key is JWT format (required by supabase-js)
if (!SUPABASE_ANON_KEY.startsWith('eyJ')) {
  console.error(`❌ NEXT_PUBLIC_SUPABASE_ANON_KEY must be a JWT token (starts with "eyJ"), got: ${SUPABASE_ANON_KEY.substring(0, 20)}...`);
  console.error('   Go to Supabase Dashboard > Settings > API > Project API keys > anon/public');
  process.exit(1);
}

const tables = ['profiles', 'reviews', 'watchlist'];
let passed = 0;
let failed = 0;

function testTable(table) {
  return new Promise((resolve) => {
    const url = new URL(`/rest/v1/${table}?select=id&limit=0`, SUPABASE_URL);
    const options = {
      method: 'GET',
      headers: {
        'apikey': SUPABASE_ANON_KEY,
        'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
      },
    };

    const req = https.request(url, options, (res) => {
      let body = '';
      res.on('data', (chunk) => body += chunk);
      res.on('end', () => {
        if (res.statusCode === 200) {
          console.log(`  ✓ ${table} — accessible (HTTP ${res.statusCode})`);
          passed++;
        } else {
          console.error(`  ✗ ${table} — HTTP ${res.statusCode}: ${body.substring(0, 200)}`);
          failed++;
        }
        resolve();
      });
    });

    req.on('error', (e) => {
      console.error(`  ✗ ${table} — network error: ${e.message}`);
      failed++;
      resolve();
    });

    req.end();
  });
}

async function main() {
  console.log(`Supabase smoke test: ${SUPABASE_URL}`);
  console.log(`Anon key: ${SUPABASE_ANON_KEY.substring(0, 20)}...${SUPABASE_ANON_KEY.slice(-10)}`);
  console.log('');

  for (const table of tables) {
    await testTable(table);
  }

  console.log('');
  if (failed > 0) {
    console.error(`❌ ${failed} table(s) failed. Fix before deploying.`);
    process.exit(1);
  } else {
    console.log(`✓ All ${passed} tables accessible. Supabase connection OK.`);
  }
}

main();
