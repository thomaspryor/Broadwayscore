-- Broadway Scorecard SQLite Schema
-- This file is the source of truth for the database structure.
-- Used by: scripts/build-sqlite.js
-- The database is an ephemeral read-only query layer over JSON source files.

-- ============================================================
-- TABLES
-- ============================================================

CREATE TABLE IF NOT EXISTS shows (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  venue TEXT,
  opening_date TEXT,
  closing_date TEXT,
  previews_start_date TEXT,
  status TEXT NOT NULL CHECK(status IN ('open','closed','previews')),
  type TEXT,
  runtime TEXT,
  intermissions INTEGER,
  synopsis TEXT,
  age_recommendation TEXT,
  official_url TEXT,
  trailer_url TEXT,
  theater_address TEXT,
  tags TEXT,                     -- JSON array as TEXT
  images TEXT,                   -- JSON object as TEXT
  ticket_links TEXT,             -- JSON array as TEXT
  cast_data TEXT,                -- JSON array as TEXT
  creative_team TEXT             -- JSON array as TEXT
);

CREATE TABLE IF NOT EXISTS reviews (
  show_id TEXT NOT NULL REFERENCES shows(id),
  outlet_id TEXT NOT NULL,
  outlet TEXT NOT NULL,
  critic_name TEXT,
  url TEXT,
  publish_date TEXT,
  assigned_score INTEGER,
  score_source TEXT,
  bucket TEXT,
  thumb TEXT,
  original_rating TEXT,
  pull_quote TEXT,
  content_tier TEXT,
  dtli_thumb TEXT,
  bww_thumb TEXT,
  PRIMARY KEY (show_id, outlet_id, critic_name)
);

CREATE TABLE IF NOT EXISTS review_texts (
  show_id TEXT NOT NULL,
  outlet_id TEXT,
  outlet TEXT,
  critic_name TEXT,
  url TEXT,
  publish_date TEXT,
  full_text TEXT,
  is_full_review INTEGER,
  word_count INTEGER,
  content_tier TEXT,
  tier_reason TEXT,
  text_quality TEXT,
  source TEXT,
  sources TEXT,                  -- JSON array as TEXT
  assigned_score INTEGER,
  original_score TEXT,
  human_review_score INTEGER,
  human_review_note TEXT,
  designation TEXT,
  llm_confidence TEXT,
  dtli_thumb TEXT,
  bww_thumb TEXT,
  dtli_excerpt TEXT,
  bww_excerpt TEXT,
  show_score_excerpt TEXT,
  wrong_production INTEGER DEFAULT 0,
  wrong_production_note TEXT,
  wrong_show INTEGER DEFAULT 0,
  is_roundup_article INTEGER DEFAULT 0,
  garbage_reason TEXT,
  fetch_method TEXT,
  fetch_tier INTEGER,
  file_path TEXT NOT NULL,
  PRIMARY KEY (show_id, outlet_id, critic_name)
);

CREATE TABLE IF NOT EXISTS commercial (
  show_id TEXT PRIMARY KEY,
  designation TEXT,
  capitalization INTEGER,
  capitalization_source TEXT,
  weekly_running_cost INTEGER,
  cost_methodology TEXT,
  recouped INTEGER DEFAULT 0,
  recouped_date TEXT,
  recouped_weeks INTEGER,
  recouped_source TEXT,
  estimated_recoupment_pct REAL,
  notes TEXT,
  last_updated TEXT
);

CREATE TABLE IF NOT EXISTS grosses (
  slug TEXT PRIMARY KEY,
  week_ending TEXT,
  tw_gross INTEGER,
  tw_gross_prev INTEGER,
  tw_gross_yoy INTEGER,
  tw_capacity REAL,
  tw_capacity_prev REAL,
  tw_capacity_yoy REAL,
  tw_atp REAL,
  tw_atp_prev REAL,
  tw_atp_yoy REAL,
  tw_attendance INTEGER,
  tw_performances INTEGER,
  at_gross INTEGER,
  at_performances INTEGER,
  at_attendance INTEGER
);

CREATE TABLE IF NOT EXISTS audience_buzz (
  show_id TEXT PRIMARY KEY,
  title TEXT,
  designation TEXT,
  combined_score INTEGER,
  show_score INTEGER,
  show_score_count INTEGER,
  mezzanine_score INTEGER,
  mezzanine_count INTEGER,
  mezzanine_stars REAL,
  reddit_score INTEGER,
  reddit_count INTEGER,
  reddit_positive_rate REAL
);

CREATE TABLE IF NOT EXISTS critic_registry (
  critic_slug TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  primary_outlet TEXT,
  total_reviews INTEGER,
  is_freelancer INTEGER DEFAULT 0,
  known_outlets TEXT,            -- JSON array as TEXT
  outlet_counts TEXT             -- JSON object as TEXT
);

-- ============================================================
-- INDEXES
-- ============================================================

CREATE INDEX IF NOT EXISTS idx_reviews_show ON reviews(show_id);
CREATE INDEX IF NOT EXISTS idx_reviews_critic ON reviews(critic_name);
CREATE INDEX IF NOT EXISTS idx_reviews_outlet ON reviews(outlet_id);
CREATE INDEX IF NOT EXISTS idx_reviews_score ON reviews(assigned_score);

CREATE INDEX IF NOT EXISTS idx_rt_show ON review_texts(show_id);
CREATE INDEX IF NOT EXISTS idx_rt_outlet ON review_texts(outlet_id);
CREATE INDEX IF NOT EXISTS idx_rt_content_tier ON review_texts(content_tier);
CREATE INDEX IF NOT EXISTS idx_rt_url ON review_texts(url);
CREATE INDEX IF NOT EXISTS idx_rt_source ON review_texts(source);
CREATE INDEX IF NOT EXISTS idx_rt_wrong_prod ON review_texts(wrong_production);

CREATE INDEX IF NOT EXISTS idx_shows_status ON shows(status);
CREATE INDEX IF NOT EXISTS idx_shows_type ON shows(type);

CREATE INDEX IF NOT EXISTS idx_commercial_designation ON commercial(designation);
CREATE INDEX IF NOT EXISTS idx_cr_freelancer ON critic_registry(is_freelancer);

-- ============================================================
-- VIEWS
-- ============================================================

-- Cross-show duplicate URL detection
CREATE VIEW IF NOT EXISTS duplicate_urls AS
  SELECT url,
         COUNT(DISTINCT show_id) AS show_count,
         GROUP_CONCAT(DISTINCT show_id) AS shows,
         GROUP_CONCAT(DISTINCT file_path) AS files
  FROM review_texts
  WHERE url IS NOT NULL AND url != ''
  GROUP BY url
  HAVING show_count > 1;

-- Content quality summary per show
CREATE VIEW IF NOT EXISTS content_quality_summary AS
  SELECT
    show_id,
    COUNT(*) AS total,
    SUM(CASE WHEN content_tier = 'complete' THEN 1 ELSE 0 END) AS complete,
    SUM(CASE WHEN content_tier = 'truncated' THEN 1 ELSE 0 END) AS truncated,
    SUM(CASE WHEN content_tier = 'excerpt' THEN 1 ELSE 0 END) AS excerpt,
    SUM(CASE WHEN content_tier = 'stub' THEN 1 ELSE 0 END) AS stub,
    SUM(CASE WHEN content_tier = 'invalid' THEN 1 ELSE 0 END) AS invalid,
    SUM(CASE WHEN wrong_production = 1 THEN 1 ELSE 0 END) AS wrong_prod,
    SUM(CASE WHEN wrong_show = 1 THEN 1 ELSE 0 END) AS wrong_show_count,
    SUM(CASE WHEN full_text IS NOT NULL AND full_text != '' THEN 1 ELSE 0 END) AS has_full_text,
    ROUND(AVG(CASE WHEN assigned_score IS NOT NULL THEN assigned_score END), 1) AS avg_score
  FROM review_texts
  GROUP BY show_id;

-- Critic activity across outlets (for misattribution detection)
CREATE VIEW IF NOT EXISTS critic_outlet_activity AS
  SELECT
    critic_name,
    outlet_id,
    COUNT(*) AS review_count,
    GROUP_CONCAT(DISTINCT show_id) AS shows
  FROM review_texts
  WHERE wrong_production = 0 AND wrong_show = 0
  GROUP BY critic_name, outlet_id;

-- Scoring pipeline breakdown
CREATE VIEW IF NOT EXISTS scoring_stats AS
  SELECT
    score_source,
    COUNT(*) AS count,
    ROUND(AVG(assigned_score), 1) AS avg,
    MIN(assigned_score) AS min_score,
    MAX(assigned_score) AS max_score
  FROM reviews
  GROUP BY score_source
  ORDER BY count DESC;

-- Duplicate outlet+critic per show
CREATE VIEW IF NOT EXISTS duplicate_outlet_critic AS
  SELECT
    show_id,
    outlet_id,
    critic_name,
    COUNT(*) AS count
  FROM review_texts
  GROUP BY show_id, LOWER(outlet_id), LOWER(critic_name)
  HAVING count > 1;
