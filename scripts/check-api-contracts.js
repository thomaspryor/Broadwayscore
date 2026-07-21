#!/usr/bin/env node
/**
 * API Contract Monitor
 *
 * Validates that external APIs we depend on still return expected data shapes.
 * Catches format changes (like TodayTix removing subcategories) before they
 * cause silent failures in pipelines.
 *
 * Run weekly alongside check-secrets-health.js.
 */

const checks = [];
let failures = 0;

function check(name, passed, detail) {
  const status = passed ? 'PASS' : 'FAIL';
  if (!passed) failures++;
  checks.push({ name, status, detail });
  console.log(`  ${passed ? '✅' : '❌'} ${name}${detail ? ': ' + detail : ''}`);
}

async function checkTodayTix() {
  console.log('\n--- TodayTix API (location=2, London) ---');
  try {
    const res = await fetch('https://api.todaytix.com/api/v2/shows?location=2&limit=5');
    const data = await res.json();

    check('Returns data array', Array.isArray(data.data) && data.data.length > 0,
      `${data.data?.length || 0} shows`);

    if (data.data?.length > 0) {
      const show = data.data[0];
      check('Has displayName', typeof show.displayName === 'string');
      check('Has category.name', typeof show.category?.name === 'string', show.category?.name);
      check('Has startDate', show.startDate !== undefined || show.bookingStartDate !== undefined);
      check('Has id', typeof show.id === 'number');

      // This is the one that broke us — detect if subcategories disappear
      const hasSubcats = data.data.some(s => s.subcategories && s.subcategories.length > 0);
      check('Has subcategories (WE/OWE tags)', hasSubcats,
        hasSubcats ? 'present' : 'MISSING — discovery fallback to category filter active');
    }
  } catch (err) {
    check('TodayTix reachable', false, err.message);
  }
}

async function checkTodayTixNYC() {
  console.log('\n--- TodayTix API (location=1, NYC) ---');
  try {
    const res = await fetch('https://api.todaytix.com/api/v2/shows?location=1&limit=5');
    const data = await res.json();

    check('Returns data array', Array.isArray(data.data) && data.data.length > 0,
      `${data.data?.length || 0} shows`);

    if (data.data?.length > 0) {
      const show = data.data[0];
      check('Has displayName', typeof show.displayName === 'string');
      check('Has subcategories', Array.isArray(show.subcategories),
        show.subcategories ? `${show.subcategories.length} subcats` : 'MISSING');

      const hasBroadway = data.data.some(s =>
        s.subcategories?.some(sc => sc.name === 'Broadway'));
      check('Has Broadway subcategory tag', hasBroadway);
    }
  } catch (err) {
    check('TodayTix NYC reachable', false, err.message);
  }
}

async function checkTheatremonkey() {
  console.log('\n--- Theatremonkey (shows index) ---');
  try {
    const res = await fetch('https://www.theatremonkey.com/shows/', {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; BroadwayScorecard/1.0)' }
    });
    const html = await res.text();

    check('Page loads', res.ok && html.length > 1000, `${(html.length / 1024).toFixed(0)}KB`);

    const showLinks = (html.match(/\/show\/[^"]+/g) || []);
    check('Has show links (>20)', showLinks.length > 20, `${showLinks.length} links`);
  } catch (err) {
    check('Theatremonkey reachable', false, err.message);
  }
}

async function checkPlaybill() {
  console.log('\n--- Playbill London Schedule ---');
  try {
    const res = await fetch('https://playbill.com/article/schedule-of-upcoming-london-shows', {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; BroadwayScorecard/1.0)' }
    });
    const html = await res.text();

    check('Page loads', res.ok && html.length > 1000, `${(html.length / 1024).toFixed(0)}KB`);
    check('Has show titles (<strong> tags)', (html.match(/<strong>/g) || []).length > 5);
    check('Has "First Preview" text', html.includes('First Preview'));
    check('Has "Opening" text', html.includes('Opening'));
  } catch (err) {
    check('Playbill reachable', false, err.message);
  }
}

async function checkReddit() {
  console.log('\n--- Reddit JSON API ---');
  try {
    const res = await fetch('https://www.reddit.com/r/Broadway/hot.json?limit=3', {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; BroadwayScorecard/1.0)' }
    });
    const data = await res.json();

    check('Returns data', data.data?.children?.length > 0, `${data.data?.children?.length || 0} posts`);

    if (data.data?.children?.length > 0) {
      const post = data.data.children[0].data;
      check('Post has title', typeof post.title === 'string');
      check('Post has num_comments', typeof post.num_comments === 'number');
      check('Post has created_utc', typeof post.created_utc === 'number');
    }
  } catch (err) {
    check('Reddit reachable', false, err.message);
  }
}

async function main() {
  console.log('='.repeat(50));
  console.log('API CONTRACT MONITOR');
  console.log('='.repeat(50));

  await checkTodayTix();
  await checkTodayTixNYC();
  await checkTheatremonkey();
  await checkPlaybill();
  await checkReddit();

  console.log('\n' + '='.repeat(50));
  console.log(`RESULTS: ${checks.length} checks, ${failures} failures`);
  console.log('='.repeat(50));

  if (failures > 0) {
    console.log('\nFAILED CHECKS:');
    checks.filter(c => c.status === 'FAIL').forEach(c => {
      console.log(`  ❌ ${c.name}${c.detail ? ': ' + c.detail : ''}`);
    });
  }

  // Write GITHUB_OUTPUT
  if (process.env.GITHUB_OUTPUT) {
    const fs = require('fs');
    fs.appendFileSync(process.env.GITHUB_OUTPUT, `failures=${failures}\n`);
    fs.appendFileSync(process.env.GITHUB_OUTPUT, `total_checks=${checks.length}\n`);
  }

  if (failures > 0) {
    process.exit(1);
  }
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
