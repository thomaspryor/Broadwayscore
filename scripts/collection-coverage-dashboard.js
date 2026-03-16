#!/usr/bin/env node
/**
 * collection-coverage-dashboard.js — Collection coverage report
 *
 * Breaks down scored reviews by HOW they were scored:
 *   - Explicit rating (P0: star ratings, letter grades, x/5, etc.)
 *   - Full text (LLM scored from complete review text)
 *   - Full text + thumb (LLM with aggregator thumb validation)
 *   - 2+ excerpts (LLM from multiple aggregator excerpts)
 *   - 1 excerpt + thumb (single excerpt with aggregator thumb)
 *   - 1 excerpt only (single excerpt, no corroboration)
 *   - Thumb only (aggregator thumb as last resort)
 *   - Unscored (has content but no score yet)
 *
 * Segmented by: BW/WE/OB × Open/Recent 3 seasons/Rest
 *
 * Usage:
 *   node scripts/collection-coverage-dashboard.js              # Print markdown
 *   node scripts/collection-coverage-dashboard.js --json       # Print JSON only
 *   node scripts/collection-coverage-dashboard.js --issue      # Create GitHub issue
 */

const fs = require('fs');
const path = require('path');
const { isLondonMarket } = require('./lib/venue-classification');

const REVIEW_TEXTS_DIR = path.join(__dirname, '..', 'data', 'review-texts');
const OUTLET_REGISTRY_PATH = path.join(__dirname, '..', 'data', 'outlet-registry.json');
const SHOWS_PATH = path.join(__dirname, '..', 'data', 'shows.json');
const OUTPUT_PATH = path.join(__dirname, '..', 'data', 'audit', 'collection-coverage.json');
const HISTORY_PATH = path.join(__dirname, '..', 'data', 'audit', 'collection-coverage-history.json');

// Season boundaries — Broadway season runs ~June to June
// "Last 3 seasons" = 2023-2024, 2024-2025, 2025-2026
const RECENT_CUTOFF = '2023-06-01';

function loadJSON(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}

function emptyBucket() {
  return {
    total: 0,
    explicitRating: 0,    // P0: originalScore extracted from HTML/text
    fullText: 0,           // LLM scored from complete text, no thumb
    fullTextThumb: 0,      // LLM scored from complete text + thumb corroboration
    excerpts2plus: 0,      // LLM scored from 2+ excerpts
    excerpt1Thumb: 0,      // LLM scored from 1 excerpt + thumb
    excerpt1Only: 0,       // LLM scored from 1 excerpt, no thumb
    thumbOnly: 0,          // Scored from aggregator thumb alone
    humanReview: 0,        // Manual human review score
    unscored: 0,           // Has content but no score
    flagged: 0,            // Excluded (wrongShow, etc.)
  };
}

function classifyReview(review) {
  const hasFullText = !!(review.fullText && review.fullText.length > 100);
  const hasOrigScore = !!(review.originalScore);
  const hasAssignedScore = !!(review.assignedScore || review.llmScore);
  const hasHumanReview = !!(review.humanReviewScore);

  // Count excerpts
  let excerptCount = 0;
  if (review.bwwExcerpt) excerptCount++;
  if (review.dtliExcerpt) excerptCount++;
  if (review.showScoreExcerpt) excerptCount++;
  if (review.nycTheatreExcerpt) excerptCount++;

  // Count thumbs
  let thumbCount = 0;
  if (review.dtliThumb) thumbCount++;
  if (review.bwwThumb) thumbCount++;

  // Determine scoring basis (priority order)
  if (hasHumanReview) return 'humanReview';
  if (hasOrigScore) return 'explicitRating';
  if (hasFullText && thumbCount > 0 && hasAssignedScore) return 'fullTextThumb';
  if (hasFullText && hasAssignedScore) return 'fullText';
  if (excerptCount >= 2 && hasAssignedScore) return 'excerpts2plus';
  if (excerptCount === 1 && thumbCount > 0 && hasAssignedScore) return 'excerpt1Thumb';
  if (excerptCount === 1 && hasAssignedScore) return 'excerpt1Only';
  if (thumbCount > 0 && hasAssignedScore) return 'thumbOnly';
  if (hasAssignedScore) return 'fullText'; // scored but unclear basis — likely fullText
  return 'unscored';
}

function getMarket(showId) {
  if (showId.includes('-off-west-end-')) return 'off-west-end';
  if (showId.includes('-west-end-')) return 'west-end';
  if (showId.includes('-off-broadway-')) return 'off-broadway';
  return 'broadway';
}

function getSegment(show) {
  if (!show) return 'rest';
  const status = show.status;
  if (status === 'open' || status === 'previews' || status === 'upcoming') return 'open';

  // Use closingDate or openingDate to determine recency
  const date = show.closingDate || show.openingDate;
  if (date && date >= RECENT_CUTOFF) return 'recent';
  return 'rest';
}

function scanReviewTexts() {
  if (!fs.existsSync(REVIEW_TEXTS_DIR)) {
    console.error('review-texts directory not found. Run: bash scripts/setup-local-data.sh');
    process.exit(1);
  }

  const outletRegistryRaw = loadJSON(OUTLET_REGISTRY_PATH) || {};
  const outletRegistry = outletRegistryRaw.outlets || outletRegistryRaw;

  const showsRaw = loadJSON(SHOWS_PATH);
  const showMap = {};
  if (showsRaw) {
    const showsData = showsRaw.shows || showsRaw;
    for (const key of Object.keys(showsData)) {
      const show = showsData[key];
      if (show && show.id) showMap[show.id] = show;
    }
  }

  // Structure: market → segment → bucket
  const data = {};
  const markets = ['broadway', 'west-end', 'off-west-end', 'off-broadway'];
  const segments = ['open', 'recent', 'rest'];
  for (const m of markets) {
    data[m] = {};
    for (const s of segments) {
      data[m][s] = emptyBucket();
    }
    data[m]._total = emptyBucket();
  }
  data._grand = emptyBucket();

  // Per-outlet stats (flat across all segments)
  const byOutlet = {};

  const showDirs = fs.readdirSync(REVIEW_TEXTS_DIR).filter(d =>
    fs.statSync(path.join(REVIEW_TEXTS_DIR, d)).isDirectory()
  );

  for (const showDir of showDirs) {
    const showPath = path.join(REVIEW_TEXTS_DIR, showDir);
    const files = fs.readdirSync(showPath).filter(f => f.endsWith('.json'));
    const market = getMarket(showDir);
    const show = showMap[showDir];
    const segment = getSegment(show);

    for (const file of files) {
      let review;
      try {
        review = JSON.parse(fs.readFileSync(path.join(showPath, file), 'utf8'));
      } catch { continue; }

      const buckets = [data[market][segment], data[market]._total, data._grand];

      // Check flags
      const isFlagged = review.wrongShow || review.wrongProduction || review.wrongAttribution ||
        review.isRoundupArticle || review.duplicateOf || review.rejectionReason;
      if (isFlagged) {
        for (const b of buckets) { b.flagged++; b.total++; }
        continue;
      }

      const category = classifyReview(review);
      for (const b of buckets) {
        b.total++;
        b[category]++;
      }

      // Per-outlet tracking
      const outletId = review.outletId || 'unknown';
      if (!byOutlet[outletId]) {
        const reg = outletRegistry[outletId] || {};
        byOutlet[outletId] = {
          name: reg.displayName || review.outlet || outletId,
          tier: reg.tier || 3,
          accessModel: reg.accessModel || 'unknown',
          ...emptyBucket(),
        };
      }
      byOutlet[outletId].total++;
      byOutlet[outletId][category]++;
    }
  }

  return { data, byOutlet };
}

function pct(n, d) {
  if (!d) return '-';
  return (n / d * 100).toFixed(1) + '%';
}

function renderBucket(label, b) {
  const active = b.total - b.flagged;
  if (active === 0) return null;
  const scored = active - b.unscored;
  return `| ${label} | ${active.toLocaleString()} | ${pct(b.explicitRating, scored)} | ${pct(b.fullText + b.fullTextThumb, scored)} | ${pct(b.fullTextThumb, scored)} | ${pct(b.excerpts2plus, scored)} | ${pct(b.excerpt1Thumb, scored)} | ${pct(b.excerpt1Only, scored)} | ${pct(b.thumbOnly, scored)} | ${pct(b.humanReview, scored)} | ${pct(b.unscored, active)} |`;
}

function renderBucketSimple(label, b) {
  const active = b.total - b.flagged;
  if (active === 0) return null;
  const scored = active - b.unscored;
  return `| ${label} | ${active.toLocaleString()} | ${scored.toLocaleString()} (${pct(scored, active)}) | ${pct(b.explicitRating, scored)} | ${pct(b.fullText + b.fullTextThumb, scored)} | ${pct(b.excerpts2plus + b.excerpt1Thumb, scored)} | ${pct(b.excerpt1Only, scored)} | ${pct(b.thumbOnly + b.humanReview, scored)} |`;
}

function generateMarkdown({ data, byOutlet }) {
  const lines = [];
  const g = data._grand;
  const active = g.total - g.flagged;
  const scored = active - g.unscored;

  lines.push('## Collection Coverage Dashboard');
  lines.push(`**Generated:** ${new Date().toISOString().slice(0, 10)}`);
  lines.push(`**Total files:** ${g.total.toLocaleString()} | **Active:** ${active.toLocaleString()} | **Scored:** ${scored.toLocaleString()} (${pct(scored, active)})\n`);

  // Grand summary
  lines.push('### Scoring Basis — All Markets');
  lines.push('| Category | Count | % of Scored |');
  lines.push('| --- | --- | --- |');
  const cats = [
    ['Explicit rating (P0)', g.explicitRating],
    ['Full text', g.fullText],
    ['Full text + thumb', g.fullTextThumb],
    ['2+ excerpts', g.excerpts2plus],
    ['1 excerpt + thumb', g.excerpt1Thumb],
    ['1 excerpt only', g.excerpt1Only],
    ['Thumb only', g.thumbOnly],
    ['Human review', g.humanReview],
    ['Unscored', g.unscored],
  ];
  for (const [name, count] of cats) {
    if (count > 0) {
      const base = name === 'Unscored' ? active : scored;
      lines.push(`| ${name} | ${count.toLocaleString()} | ${pct(count, base)} |`);
    }
  }
  lines.push('');

  // Per-market breakdown
  const marketNames = { broadway: 'Broadway', 'west-end': 'West End', 'off-west-end': 'Off-West End', 'off-broadway': 'Off-Broadway' };
  const segNames = { open: 'Open/Previews', recent: 'Closed (last 3 seasons)', rest: 'Older inventory' };

  for (const [market, mLabel] of Object.entries(marketNames)) {
    const md = data[market];
    const mTotal = md._total;
    const mActive = mTotal.total - mTotal.flagged;
    if (mActive === 0) continue;

    lines.push(`### ${mLabel}`);
    lines.push(`_${mActive.toLocaleString()} active reviews_\n`);

    lines.push('| Segment | Active | Scored | Explicit | Full Text | Excerpt (2+ or +thumb) | Excerpt (1 only) | Other |');
    lines.push('| --- | --- | --- | --- | --- | --- | --- | --- |');

    for (const [seg, sLabel] of Object.entries(segNames)) {
      const row = renderBucketSimple(sLabel, md[seg]);
      if (row) lines.push(row);
    }
    // Market total
    const totalRow = renderBucketSimple(`**${mLabel} Total**`, mTotal);
    if (totalRow) lines.push(totalRow);
    lines.push('');

    // Detailed breakdown for this market
    lines.push('<details>');
    lines.push(`<summary>Detailed scoring breakdown — ${mLabel}</summary>\n`);
    lines.push('| Segment | Active | Explicit | Full Text | FT+Thumb | 2+ Excerpts | 1 Exc+Thumb | 1 Exc Only | Thumb Only | Human | Unscored |');
    lines.push('| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |');
    for (const [seg, sLabel] of Object.entries(segNames)) {
      const row = renderBucket(sLabel, md[seg]);
      if (row) lines.push(row);
    }
    const detailTotal = renderBucket(`**Total**`, mTotal);
    if (detailTotal) lines.push(detailTotal);
    lines.push('\n</details>\n');
  }

  // Top outlets by collection opportunity
  const outletsByGap = Object.entries(byOutlet)
    .map(([id, o]) => {
      const oActive = o.total - o.flagged;
      return { id, ...o, active: oActive, noFullText: oActive - o.fullText - o.fullTextThumb - o.explicitRating - o.humanReview };
    })
    .filter(o => o.noFullText > 10 && o.accessModel !== 'defunct' && o.accessModel !== 'print-only')
    .sort((a, b) => b.noFullText - a.noFullText)
    .slice(0, 20);

  lines.push('### Top Outlets — Collection Opportunity');
  lines.push('_Reviews without full text or explicit rating (biggest gaps)_\n');
  lines.push('| Outlet | Tier | Access | Active | Has Full Text | Gap | Full Text % |');
  lines.push('| --- | --- | --- | --- | --- | --- | --- |');
  for (const o of outletsByGap) {
    const ft = o.fullText + o.fullTextThumb;
    lines.push(`| ${o.name} | T${o.tier} | ${o.accessModel} | ${o.active} | ${ft} | ${o.noFullText} | ${pct(ft, o.active)} |`);
  }
  lines.push('');

  lines.push('---');
  lines.push('Generated by `scripts/collection-coverage-dashboard.js`');

  return lines.join('\n');
}

function updateHistory(data) {
  const history = loadJSON(HISTORY_PATH) || { snapshots: [] };
  const today = new Date().toISOString().slice(0, 10);
  history.snapshots = history.snapshots.filter(s => s.date !== today);

  const g = data._grand;
  const active = g.total - g.flagged;
  const scored = active - g.unscored;
  history.snapshots.push({
    date: today,
    total: g.total, active, scored,
    explicitRating: g.explicitRating,
    fullText: g.fullText + g.fullTextThumb,
    excerpts: g.excerpts2plus + g.excerpt1Thumb + g.excerpt1Only,
    thumbOnly: g.thumbOnly,
    unscored: g.unscored,
    byMarket: Object.fromEntries(
      ['broadway', 'west-end', 'off-west-end', 'off-broadway'].map(m => {
        const mt = data[m]._total;
        const a = mt.total - mt.flagged;
        return [m, { active: a, scored: a - mt.unscored, fullText: mt.fullText + mt.fullTextThumb }];
      })
    ),
  });

  if (history.snapshots.length > 52) history.snapshots = history.snapshots.slice(-52);
  return history;
}

function computeTrends(history) {
  if (!history || history.snapshots.length < 2) return null;
  const latest = history.snapshots[history.snapshots.length - 1];
  const prev = history.snapshots[history.snapshots.length - 2];
  return {
    scoredDelta: latest.scored - prev.scored,
    fullTextDelta: latest.fullText - prev.fullText,
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
  const { data, byOutlet } = scanReviewTexts();

  // Save machine-readable output
  const output = {
    generatedAt: new Date().toISOString(),
    recentCutoff: RECENT_CUTOFF,
    grand: data._grand,
    markets: Object.fromEntries(
      ['broadway', 'west-end', 'off-west-end', 'off-broadway'].map(m => [m, {
        total: data[m]._total,
        open: data[m].open,
        recent: data[m].recent,
        rest: data[m].rest,
      }])
    ),
    outlets: Object.fromEntries(
      Object.entries(byOutlet)
        .sort((a, b) => b[1].total - a[1].total)
        .map(([id, o]) => [id, o])
    ),
  };

  fs.mkdirSync(path.dirname(OUTPUT_PATH), { recursive: true });
  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(output, null, 2));
  console.error(`Wrote ${OUTPUT_PATH}`);

  const history = updateHistory(data);
  fs.writeFileSync(HISTORY_PATH, JSON.stringify(history, null, 2));
  console.error(`Updated ${HISTORY_PATH}`);

  if (jsonOnly) {
    console.log(JSON.stringify(output, null, 2));
    return;
  }

  let markdown = generateMarkdown({ data, byOutlet });

  const trends = computeTrends(history);
  if (trends) {
    markdown = markdown.replace('---\nGenerated', `### Trends (${trends.period})\n` +
      `- Scored: ${trends.scoredDelta >= 0 ? '+' : ''}${trends.scoredDelta}\n` +
      `- Full text: ${trends.fullTextDelta >= 0 ? '+' : ''}${trends.fullTextDelta}\n` +
      `- Total files: ${trends.totalDelta >= 0 ? '+' : ''}${trends.totalDelta}\n\n---\nGenerated`);
  }

  console.log(markdown);

  if (createIssue) {
    await createGitHubIssue(markdown);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
