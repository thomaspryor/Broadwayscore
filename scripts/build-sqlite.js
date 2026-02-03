#!/usr/bin/env node
/**
 * build-sqlite.js — Build the SQLite query layer from JSON source files.
 *
 * Usage:
 *   node scripts/build-sqlite.js              # Build without fullText (fast, ~5MB)
 *   node scripts/build-sqlite.js --include-text  # Include fullText fields (~23MB)
 *   node scripts/build-sqlite.js --tables=shows,reviews  # Rebuild specific tables only
 *
 * The database is an ephemeral read-only query layer. JSON files remain the source of truth.
 */

const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const DATA = path.join(ROOT, 'data');
const DB_PATH = path.join(DATA, 'broadway.db');
const TMP_PATH = DB_PATH + '.tmp';
const SCHEMA_PATH = path.join(__dirname, 'schema.sql');

// Parse flags
const args = process.argv.slice(2);
const includeText = args.includes('--include-text');
const tablesArg = args.find(a => a.startsWith('--tables='));
const onlyTables = tablesArg ? tablesArg.split('=')[1].split(',') : null;

function shouldBuild(table) {
  return !onlyTables || onlyTables.includes(table);
}

function log(msg) {
  console.log(`[db:build] ${msg}`);
}

function checkIntegrity(db) {
  const result = db.pragma('integrity_check');
  if (result[0].integrity_check !== 'ok') {
    throw new Error(`Database integrity check failed: ${JSON.stringify(result)}`);
  }
}

// ============================================================
// Main
// ============================================================

function main() {
  const startTime = Date.now();

  // Remove stale tmp file if exists
  if (fs.existsSync(TMP_PATH)) {
    fs.unlinkSync(TMP_PATH);
  }

  // Read schema
  const schema = fs.readFileSync(SCHEMA_PATH, 'utf8');

  // Create DB at tmp path (atomic write)
  const db = new Database(TMP_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = OFF');  // Safe since we rebuild from scratch
  db.pragma('cache_size = -64000'); // 64MB

  // Create all tables, indexes, views
  db.exec(schema);

  const counts = {};

  // --- shows ---
  if (shouldBuild('shows')) {
    const showsData = JSON.parse(fs.readFileSync(path.join(DATA, 'shows.json'), 'utf8'));
    const shows = showsData.shows || showsData;
    const insert = db.prepare(`
      INSERT OR REPLACE INTO shows (id, title, slug, venue, opening_date, closing_date,
        previews_start_date, status, type, runtime, intermissions, synopsis,
        age_recommendation, official_url, trailer_url, theater_address,
        tags, images, ticket_links, creative_team)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const tx = db.transaction((rows) => {
      for (const s of rows) {
        insert.run(
          s.id, s.title, s.slug, s.venue || null,
          s.openingDate || null, s.closingDate || null,
          s.previewsStartDate || null, s.status, s.type || null,
          s.runtime || null, s.intermissions ?? null, s.synopsis || null,
          s.ageRecommendation || null, s.officialUrl || null,
          s.trailerUrl || null, s.theaterAddress || null,
          s.tags ? JSON.stringify(s.tags) : null,
          s.images ? JSON.stringify(s.images) : null,
          s.ticketLinks ? JSON.stringify(s.ticketLinks) : null,
          s.creativeTeam ? JSON.stringify(s.creativeTeam) : null
        );
      }
    });
    tx(shows);
    counts.shows = shows.length;
    log(`shows: ${shows.length} rows`);
  }

  // --- reviews ---
  if (shouldBuild('reviews')) {
    const reviewsData = JSON.parse(fs.readFileSync(path.join(DATA, 'reviews.json'), 'utf8'));
    const reviews = reviewsData.reviews || reviewsData;
    const insert = db.prepare(`
      INSERT OR REPLACE INTO reviews (show_id, outlet_id, outlet, critic_name, url,
        publish_date, assigned_score, score_source, bucket, thumb, original_rating,
        pull_quote, content_tier, dtli_thumb, bww_thumb)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const tx = db.transaction((rows) => {
      for (const r of rows) {
        insert.run(
          r.showId, r.outletId, r.outlet, r.criticName || null, r.url || null,
          r.publishDate || null, r.assignedScore ?? null, r.scoreSource || null,
          r.bucket || null, r.thumb || null, r.originalRating || null,
          r.pullQuote || null, r.contentTier || null,
          r.dtliThumb || null, r.bwwThumb || null
        );
      }
    });
    tx(reviews);
    counts.reviews = reviews.length;
    log(`reviews: ${reviews.length} rows`);
  }

  // --- review_texts (scan individual files) ---
  if (shouldBuild('review_texts')) {
    const insert = db.prepare(`
      INSERT OR REPLACE INTO review_texts (show_id, outlet_id, outlet, critic_name, url,
        publish_date, full_text, is_full_review, word_count, content_tier, tier_reason,
        text_quality, source, sources, assigned_score, original_score,
        human_review_score, human_review_note, designation, llm_confidence,
        dtli_thumb, bww_thumb, dtli_excerpt, bww_excerpt, show_score_excerpt,
        wrong_production, wrong_production_note, wrong_show, is_roundup_article,
        garbage_reason, fetch_method, fetch_tier, file_path)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const reviewTextsDir = path.join(DATA, 'review-texts');
    let totalFiles = 0;
    let skipped = 0;

    const showDirs = fs.readdirSync(reviewTextsDir, { withFileTypes: true })
      .filter(d => d.isDirectory() && !d.isSymbolicLink());

    const tx = db.transaction(() => {
      for (const dir of showDirs) {
        const showDir = path.join(reviewTextsDir, dir.name);
        const files = fs.readdirSync(showDir).filter(f => f.endsWith('.json'));

        for (const file of files) {
          const filePath = path.join(showDir, file);
          let r;
          try {
            r = JSON.parse(fs.readFileSync(filePath, 'utf8'));
          } catch (err) {
            console.warn(`[db:build] WARNING: Malformed JSON, skipping: ${filePath} (${err.message})`);
            skipped++;
            continue;
          }

          const relativePath = path.relative(DATA, filePath);

          // Handle contentTier being either a string or nested object
          const ct = r.contentTier;
          const contentTier = (ct && typeof ct === 'object') ? ct.contentTier : (ct || null);
          const tierReason = r.tierReason || (ct && typeof ct === 'object' ? ct.tierReason : null) || null;

          insert.run(
            r.showId || dir.name,
            r.outletId || null,
            r.outlet || null,
            r.criticName || null,
            r.url || null,
            r.publishDate || null,
            includeText ? (r.fullText || null) : null,
            r.isFullReview ? 1 : 0,
            r.wordCount ?? null,
            contentTier,
            tierReason,
            r.textQuality || null,
            r.source || null,
            r.sources ? JSON.stringify(r.sources) : null,
            r.assignedScore ?? null,
            r.originalScore || null,
            r.humanReviewScore ?? null,
            r.humanReviewNote || null,
            r.designation || null,
            r.llmScore?.confidence || r.llmMetadata?.confidence || null,
            r.dtliThumb || null,
            r.bwwThumb || null,
            includeText ? (r.dtliExcerpt || null) : null,
            includeText ? (r.bwwExcerpt || null) : null,
            includeText ? (r.showScoreExcerpt || null) : null,
            r.wrongProduction ? 1 : 0,
            r.wrongProductionNote || null,
            r.wrongShow ? 1 : 0,
            r.isRoundupArticle ? 1 : 0,
            r.garbageReason || null,
            r.fetchMethod || null,
            r.fetchTier ?? null,
            relativePath
          );
          totalFiles++;
        }
      }
    });
    tx();
    counts.review_texts = totalFiles;
    log(`review_texts: ${totalFiles} rows` + (skipped > 0 ? ` (${skipped} skipped)` : ''));
  }

  // --- commercial ---
  if (shouldBuild('commercial')) {
    const commercialPath = path.join(DATA, 'commercial.json');
    if (fs.existsSync(commercialPath)) {
      const data = JSON.parse(fs.readFileSync(commercialPath, 'utf8'));
      const shows = data.shows || {};
      const insert = db.prepare(`
        INSERT OR REPLACE INTO commercial (show_id, designation, capitalization,
          capitalization_source, weekly_running_cost, cost_methodology,
          recouped, recouped_date, recouped_weeks, recouped_source,
          estimated_recoupment_pct, notes, last_updated)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      const tx = db.transaction(() => {
        for (const [id, c] of Object.entries(shows)) {
          // estimatedRecoupmentPct can be an array [min, max] — store as avg or null
          let recoupPct = c.estimatedRecoupmentPct ?? null;
          if (Array.isArray(recoupPct)) {
            recoupPct = recoupPct.length === 2 ? (recoupPct[0] + recoupPct[1]) / 2 : recoupPct[0];
          }
          insert.run(
            id, c.designation || null, c.capitalization ?? null,
            c.capitalizationSource || null, c.weeklyRunningCost ?? null,
            c.costMethodology || null, c.recouped ? 1 : 0,
            c.recoupedDate || null, c.recoupedWeeks ?? null,
            c.recoupedSource || null, recoupPct,
            c.notes || null, c.lastUpdated || null
          );
        }
      });
      tx();
      const count = Object.keys(shows).length;
      counts.commercial = count;
      log(`commercial: ${count} rows`);
    }
  }

  // --- grosses ---
  if (shouldBuild('grosses')) {
    const grossesPath = path.join(DATA, 'grosses.json');
    if (fs.existsSync(grossesPath)) {
      const data = JSON.parse(fs.readFileSync(grossesPath, 'utf8'));
      const shows = data.shows || {};
      const weekEnding = data.weekEnding || null;
      const insert = db.prepare(`
        INSERT OR REPLACE INTO grosses (slug, week_ending,
          tw_gross, tw_gross_prev, tw_gross_yoy,
          tw_capacity, tw_capacity_prev, tw_capacity_yoy,
          tw_atp, tw_atp_prev, tw_atp_yoy,
          tw_attendance, tw_performances,
          at_gross, at_performances, at_attendance)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      const tx = db.transaction(() => {
        for (const [slug, g] of Object.entries(shows)) {
          const tw = g.thisWeek || {};
          const at = g.allTime || {};
          insert.run(
            slug, weekEnding,
            tw.gross ?? null, tw.grossPrevWeek ?? null, tw.grossYoY ?? null,
            tw.capacity ?? null, tw.capacityPrevWeek ?? null, tw.capacityYoY ?? null,
            tw.atp ?? null, tw.atpPrevWeek ?? null, tw.atpYoY ?? null,
            tw.attendance ?? null, tw.performances ?? null,
            at.gross ?? null, at.performances ?? null, at.attendance ?? null
          );
        }
      });
      tx();
      const count = Object.keys(shows).length;
      counts.grosses = count;
      log(`grosses: ${count} rows`);
    }
  }

  // --- audience_buzz ---
  if (shouldBuild('audience_buzz')) {
    const buzzPath = path.join(DATA, 'audience-buzz.json');
    if (fs.existsSync(buzzPath)) {
      const data = JSON.parse(fs.readFileSync(buzzPath, 'utf8'));
      const shows = data.shows || {};
      const insert = db.prepare(`
        INSERT OR REPLACE INTO audience_buzz (show_id, title, designation, combined_score,
          show_score, show_score_count, mezzanine_score, mezzanine_count, mezzanine_stars,
          reddit_score, reddit_count, reddit_positive_rate)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      const tx = db.transaction(() => {
        for (const [id, b] of Object.entries(shows)) {
          const ss = b.sources?.showScore || {};
          const mz = b.sources?.mezzanine || {};
          const rd = b.sources?.reddit || {};
          insert.run(
            id, b.title || null, b.designation || null, b.combinedScore ?? null,
            ss.score ?? null, ss.reviewCount ?? null,
            mz.score ?? null, mz.reviewCount ?? null, mz.starRating ?? null,
            rd.score ?? null, rd.reviewCount ?? null, rd.positiveRate ?? null
          );
        }
      });
      tx();
      const count = Object.keys(shows).length;
      counts.audience_buzz = count;
      log(`audience_buzz: ${count} rows`);
    }
  }

  // --- critic_registry ---
  if (shouldBuild('critic_registry')) {
    const registryPath = path.join(DATA, 'critic-registry.json');
    if (fs.existsSync(registryPath)) {
      const data = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
      const critics = data.critics || {};
      const insert = db.prepare(`
        INSERT OR REPLACE INTO critic_registry (critic_slug, display_name, primary_outlet,
          total_reviews, is_freelancer, known_outlets, outlet_counts)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `);
      const tx = db.transaction(() => {
        for (const [slug, c] of Object.entries(critics)) {
          insert.run(
            slug, c.displayName || slug, c.primaryOutlet || null,
            c.totalReviews ?? null, c.isFreelancer ? 1 : 0,
            c.knownOutlets ? JSON.stringify(c.knownOutlets) : null,
            c.outletCounts ? JSON.stringify(c.outletCounts) : null
          );
        }
      });
      tx();
      const count = Object.keys(critics).length;
      counts.critic_registry = count;
      log(`critic_registry: ${count} rows`);
    }
  }

  // Run ANALYZE for query planner optimization
  db.exec('ANALYZE');

  // Integrity check
  checkIntegrity(db);

  db.close();

  // Atomic rename: tmp → final
  if (fs.existsSync(DB_PATH)) {
    fs.unlinkSync(DB_PATH);
  }
  fs.renameSync(TMP_PATH, DB_PATH);

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  const size = (fs.statSync(DB_PATH).size / 1024 / 1024).toFixed(1);

  log(`Done in ${elapsed}s — ${size}MB`);
  log(`Row counts: ${JSON.stringify(counts)}`);
}

main();
