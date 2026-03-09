#!/usr/bin/env node
/**
 * collection-coverage-dashboard.js — Generates a collection coverage report
 * tracking fullText vs excerpt vs stub vs uncollected across outlets, tiers, and shows.
 *
 * Outputs:
 *   - data/audit/collection-coverage.json (machine-readable)
 *   - Markdown summary (stdout or GitHub issue)
 *
 * Usage:
 *   node scripts/collection-coverage-dashboard.js              # Print markdown summary
 *   node scripts/collection-coverage-dashboard.js --json       # Print JSON only
 *   node scripts/collection-coverage-dashboard.js --issue      # Create GitHub issue
 */

const fs = require('fs');
const path = require('path');

const REVIEW_TEXTS_DIR = path.join(__dirname, '..', 'data', 'review-texts');
const OUTLET_REGISTRY_PATH = path.join(__dirname, '..', 'data', 'outlet-registry.json');
const REVIEWS_PATH = path.join(__dirname, '..', 'data', 'reviews.json');
const SHOWS_PATH = path.join(__dirname, '..', 'data', 'shows.json');
const OUTPUT_PATH = path.join(__dirname, '..', 'data', 'audit', 'collection-coverage.json');
const HISTORY_PATH = path.join(__dirname, '..', 'data', 'audit', 'collection-coverage-history.json');

function loadJSON(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}

function scanReviewTexts() {
  const stats = {
    total: 0,
    byContentTier: {},
    byOutlet: {},
    byOutletTier: { 1: { total: 0 }, 2: { total: 0 }, 3: { total: 0 } },
    byAccessModel: {},
    byMarket: {},
    byShow: {},
    uncollected: 0,      // no fullText AND no excerpts
    hasFullText: 0,
    hasExcerpts: 0,       // has bwwExcerpt/dtliExcerpt/showScoreExcerpt but no fullText
    flagged: 0,           // wrongShow, wrongProduction, etc.
  };

  if (!fs.existsSync(REVIEW_TEXTS_DIR)) {
    console.error('review-texts directory not found. Run: bash scripts/setup-local-data.sh');
    process.exit(1);
  }

  const outletRegistryRaw = loadJSON(OUTLET_REGISTRY_PATH) || {};
  const outletRegistry = outletRegistryRaw.outlets || outletRegistryRaw;
  const shows = loadJSON(SHOWS_PATH);
  const showMap = {};
  if (shows) {
    // shows.json has numeric keys with id field
    for (const key of Object.keys(shows)) {
      const show = shows[key];
      if (show && show.id) showMap[show.id] = show;
    }
  }

  const showDirs = fs.readdirSync(REVIEW_TEXTS_DIR).filter(d =>
    fs.statSync(path.join(REVIEW_TEXTS_DIR, d)).isDirectory()
  );

  for (const showDir of showDirs) {
    const showPath = path.join(REVIEW_TEXTS_DIR, showDir);
    const files = fs.readdirSync(showPath).filter(f => f.endsWith('.json'));

    const showInfo = showMap[showDir] || {};
    const market = showDir.includes('-west-end-') ? 'west-end'
      : showDir.includes('-off-broadway-') ? 'off-broadway'
      : 'broadway';

    if (!stats.byShow[showDir]) {
      stats.byShow[showDir] = { total: 0, complete: 0, truncated: 0, excerpt: 0, stub: 0, invalid: 0, uncollected: 0, flagged: 0 };
    }

    for (const file of files) {
      stats.total++;
      let review;
      try {
        review = JSON.parse(fs.readFileSync(path.join(showPath, file), 'utf8'));
      } catch { continue; }

      // Check flags
      const isFlagged = review.wrongShow || review.wrongProduction || review.wrongAttribution ||
        review.isRoundupArticle || review.duplicateOf || review.rejectionReason;
      if (isFlagged) {
        stats.flagged++;
        stats.byShow[showDir].flagged++;
        continue; // Don't count flagged reviews in coverage
      }

      const tier = review.contentTier || 'unknown';
      const outletId = review.outletId || 'unknown';
      const hasFullText = !!(review.fullText && review.fullText.length > 100);
      const hasExcerpts = !!(review.bwwExcerpt || review.dtliExcerpt || review.showScoreExcerpt || review.nycTheatreExcerpt);

      // Content tier
      stats.byContentTier[tier] = (stats.byContentTier[tier] || 0) + 1;

      // Collection state
      if (hasFullText) stats.hasFullText++;
      else if (hasExcerpts) stats.hasExcerpts++;
      else stats.uncollected++;

      // Per-outlet stats
      if (!stats.byOutlet[outletId]) {
        const reg = outletRegistry[outletId] || {};
        stats.byOutlet[outletId] = {
          name: reg.displayName || review.outlet || outletId,
          tier: reg.tier || 3,
          accessModel: reg.accessModel || 'unknown',
          total: 0, complete: 0, truncated: 0, excerpt: 0, stub: 0, invalid: 0, unknown: 0,
          hasFullText: 0, uncollected: 0,
        };
      }
      const o = stats.byOutlet[outletId];
      o.total++;
      o[tier] = (o[tier] || 0) + 1;
      if (hasFullText) o.hasFullText++;
      else if (!hasExcerpts) o.uncollected++;

      // Per outlet-tier (1/2/3)
      const outletTier = o.tier || 3;
      if (!stats.byOutletTier[outletTier]) stats.byOutletTier[outletTier] = { total: 0 };
      const ot = stats.byOutletTier[outletTier];
      ot.total++;
      ot[tier] = (ot[tier] || 0) + 1;

      // Per access model
      const am = o.accessModel || 'unknown';
      if (!stats.byAccessModel[am]) stats.byAccessModel[am] = { total: 0 };
      const amStats = stats.byAccessModel[am];
      amStats.total++;
      amStats[tier] = (amStats[tier] || 0) + 1;

      // Per market
      if (!stats.byMarket[market]) stats.byMarket[market] = { total: 0 };
      const mk = stats.byMarket[market];
      mk.total++;
      mk[tier] = (mk[tier] || 0) + 1;

      // Per show
      const s = stats.byShow[showDir];
      s.total++;
      s[tier] = (s[tier] || 0) + 1;
      if (!hasFullText && !hasExcerpts) s.uncollected++;
    }
  }

  return stats;
}

function pct(n, d) {
  if (!d) return '0%';
  return (n / d * 100).toFixed(1) + '%';
}

function generateMarkdown(stats) {
  const lines = [];
  const active = stats.total - stats.flagged;

  lines.push('## Collection Coverage Dashboard');
  lines.push(`**Generated:** ${new Date().toISOString().slice(0, 10)}`);
  lines.push(`**Total review files:** ${stats.total.toLocaleString()} (${stats.flagged.toLocaleString()} flagged/excluded)\n`);

  // Overall content tier breakdown
  lines.push('### Content Tier Breakdown');
  lines.push('| Tier | Count | % of Active |');
  lines.push('| --- | --- | --- |');
  const tierOrder = ['complete', 'truncated', 'excerpt', 'stub', 'invalid', 'unknown'];
  for (const tier of tierOrder) {
    const count = stats.byContentTier[tier] || 0;
    if (count > 0) {
      lines.push(`| ${tier} | ${count.toLocaleString()} | ${pct(count, active)} |`);
    }
  }
  lines.push('');

  // Collection state
  lines.push('### Collection State');
  lines.push(`| State | Count | % |`);
  lines.push(`| --- | --- | --- |`);
  lines.push(`| Has full text | ${stats.hasFullText.toLocaleString()} | ${pct(stats.hasFullText, active)} |`);
  lines.push(`| Excerpts only | ${stats.hasExcerpts.toLocaleString()} | ${pct(stats.hasExcerpts, active)} |`);
  lines.push(`| Uncollected | ${stats.uncollected.toLocaleString()} | ${pct(stats.uncollected, active)} |`);
  lines.push('');

  // By outlet tier
  lines.push('### By Outlet Tier');
  lines.push('| Outlet Tier | Total | Complete | Truncated | Excerpt | Stub |');
  lines.push('| --- | --- | --- | --- | --- | --- |');
  for (const t of [1, 2, 3]) {
    const ot = stats.byOutletTier[t] || { total: 0 };
    lines.push(`| T${t} | ${ot.total.toLocaleString()} | ${pct(ot.complete || 0, ot.total)} | ${pct(ot.truncated || 0, ot.total)} | ${pct(ot.excerpt || 0, ot.total)} | ${pct(ot.stub || 0, ot.total)} |`);
  }
  lines.push('');

  // By access model
  lines.push('### By Access Model');
  lines.push('| Model | Total | Complete | Excerpt | Stub |');
  lines.push('| --- | --- | --- | --- | --- |');
  const amOrder = ['free', 'metered', 'paywalled', 'print-only', 'defunct', 'unknown'];
  for (const am of amOrder) {
    const a = stats.byAccessModel[am];
    if (!a) continue;
    lines.push(`| ${am} | ${a.total.toLocaleString()} | ${pct(a.complete || 0, a.total)} | ${pct(a.excerpt || 0, a.total)} | ${pct(a.stub || 0, a.total)} |`);
  }
  lines.push('');

  // By market
  lines.push('### By Market');
  lines.push('| Market | Total | Complete | Excerpt | Stub |');
  lines.push('| --- | --- | --- | --- | --- |');
  for (const [market, m] of Object.entries(stats.byMarket).sort((a, b) => b[1].total - a[1].total)) {
    lines.push(`| ${market} | ${m.total.toLocaleString()} | ${pct(m.complete || 0, m.total)} | ${pct(m.excerpt || 0, m.total)} | ${pct(m.stub || 0, m.total)} |`);
  }
  lines.push('');

  // Top outlets by opportunity (most uncollected)
  const outletsByOpportunity = Object.entries(stats.byOutlet)
    .map(([id, o]) => ({ id, ...o, opportunity: o.total - o.hasFullText }))
    .filter(o => o.opportunity > 5 && o.accessModel !== 'defunct' && o.accessModel !== 'print-only')
    .sort((a, b) => b.opportunity - a.opportunity)
    .slice(0, 20);

  lines.push('### Top Outlets by Collection Opportunity');
  lines.push('| Outlet | Tier | Access | Total | Full Text | Gap | % Collected |');
  lines.push('| --- | --- | --- | --- | --- | --- | --- |');
  for (const o of outletsByOpportunity) {
    lines.push(`| ${o.name} | T${o.tier} | ${o.accessModel} | ${o.total} | ${o.hasFullText} | ${o.opportunity} | ${pct(o.hasFullText, o.total)} |`);
  }
  lines.push('');

  // Top outlets by collection rate (best performers)
  const outletsByRate = Object.entries(stats.byOutlet)
    .map(([id, o]) => ({ id, ...o }))
    .filter(o => o.total >= 10)
    .sort((a, b) => (b.hasFullText / b.total) - (a.hasFullText / a.total))
    .slice(0, 15);

  lines.push('### Best-Collected Outlets (10+ reviews)');
  lines.push('| Outlet | Tier | Total | Full Text | % |');
  lines.push('| --- | --- | --- | --- | --- |');
  for (const o of outletsByRate) {
    lines.push(`| ${o.name} | T${o.tier} | ${o.total} | ${o.hasFullText} | ${pct(o.hasFullText, o.total)} |`);
  }
  lines.push('');

  // Shows with lowest collection rate (open shows)
  const showsByGap = Object.entries(stats.byShow)
    .map(([id, s]) => ({ id, ...s }))
    .filter(s => s.total >= 5 && s.uncollected > 2)
    .sort((a, b) => (a.complete || 0) / a.total - (b.complete || 0) / b.total)
    .slice(0, 15);

  if (showsByGap.length > 0) {
    lines.push('### Shows with Lowest Collection Rate (5+ reviews)');
    lines.push('| Show | Reviews | Complete | Gap |');
    lines.push('| --- | --- | --- | --- |');
    for (const s of showsByGap) {
      lines.push(`| ${s.id} | ${s.total} | ${s.complete || 0} | ${s.uncollected} uncollected |`);
    }
    lines.push('');
  }

  lines.push('---');
  lines.push('Generated by `scripts/collection-coverage-dashboard.js`');

  return lines.join('\n');
}

function updateHistory(stats) {
  const history = loadJSON(HISTORY_PATH) || { snapshots: [] };
  const today = new Date().toISOString().slice(0, 10);

  // Remove today's entry if re-running
  history.snapshots = history.snapshots.filter(s => s.date !== today);

  const active = stats.total - stats.flagged;
  history.snapshots.push({
    date: today,
    total: stats.total,
    active,
    hasFullText: stats.hasFullText,
    hasExcerpts: stats.hasExcerpts,
    uncollected: stats.uncollected,
    flagged: stats.flagged,
    byContentTier: stats.byContentTier,
    byOutletTier: Object.fromEntries(
      Object.entries(stats.byOutletTier).map(([k, v]) => [k, { total: v.total, complete: v.complete || 0 }])
    ),
  });

  // Keep last 52 weeks
  if (history.snapshots.length > 52) {
    history.snapshots = history.snapshots.slice(-52);
  }

  return history;
}

function computeTrends(history) {
  if (!history || history.snapshots.length < 2) return null;
  const latest = history.snapshots[history.snapshots.length - 1];
  const prev = history.snapshots[history.snapshots.length - 2];

  return {
    fullTextDelta: latest.hasFullText - prev.hasFullText,
    uncollectedDelta: latest.uncollected - prev.uncollected,
    totalDelta: latest.total - prev.total,
    period: `${prev.date} → ${latest.date}`,
  };
}

async function createGitHubIssue(markdown) {
  const token = process.env.GITHUB_TOKEN;
  if (!token) { console.log('No GITHUB_TOKEN — skipping issue creation'); return; }

  const today = new Date().toISOString().slice(0, 10);
  const res = await fetch('https://api.github.com/repos/thomaspryor/Broadwayscore/issues', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      title: `Collection Coverage Report — ${today}`,
      body: markdown,
      labels: ['analytics', 'automated'],
    }),
  });
  if (res.ok) {
    const issue = await res.json();
    console.log(`Created issue: ${issue.html_url}`);
  } else {
    console.error(`Issue creation failed: ${res.status}`);
  }
}

async function main() {
  const args = process.argv.slice(2);
  const jsonOnly = args.includes('--json');
  const createIssue = args.includes('--issue');

  console.error('Scanning review-texts...');
  const stats = scanReviewTexts();

  // Save machine-readable output
  const output = {
    generatedAt: new Date().toISOString(),
    summary: {
      total: stats.total,
      active: stats.total - stats.flagged,
      flagged: stats.flagged,
      hasFullText: stats.hasFullText,
      hasExcerpts: stats.hasExcerpts,
      uncollected: stats.uncollected,
      fullTextRate: ((stats.hasFullText / (stats.total - stats.flagged)) * 100).toFixed(1) + '%',
    },
    byContentTier: stats.byContentTier,
    byOutletTier: stats.byOutletTier,
    byAccessModel: stats.byAccessModel,
    byMarket: stats.byMarket,
    outlets: Object.fromEntries(
      Object.entries(stats.byOutlet)
        .sort((a, b) => b[1].total - a[1].total)
        .map(([id, o]) => [id, { ...o }])
    ),
  };

  fs.mkdirSync(path.dirname(OUTPUT_PATH), { recursive: true });
  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(output, null, 2));
  console.error(`Wrote ${OUTPUT_PATH}`);

  // Update history
  const history = updateHistory(stats);
  fs.writeFileSync(HISTORY_PATH, JSON.stringify(history, null, 2));
  console.error(`Updated ${HISTORY_PATH}`);

  if (jsonOnly) {
    console.log(JSON.stringify(output, null, 2));
    return;
  }

  // Generate markdown
  let markdown = generateMarkdown(stats);

  // Add trend line if history available
  const trends = computeTrends(history);
  if (trends) {
    markdown = markdown.replace('---\n', `### Trends (${trends.period})\n` +
      `- Full text: ${trends.fullTextDelta >= 0 ? '+' : ''}${trends.fullTextDelta}\n` +
      `- Uncollected: ${trends.uncollectedDelta >= 0 ? '+' : ''}${trends.uncollectedDelta}\n` +
      `- Total files: ${trends.totalDelta >= 0 ? '+' : ''}${trends.totalDelta}\n\n---\n`);
  }

  console.log(markdown);

  if (createIssue) {
    await createGitHubIssue(markdown);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
