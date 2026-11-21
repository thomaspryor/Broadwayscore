'use strict';
// BRO-3491: check-cron-health.yml's "recent failure" warnings (a cron whose
// latest run failed but is not yet stale, and the UNKNOWN-health warning when
// the run-history query fails) used to go to a Discord step. Discord is
// retired, so they reached nobody. They now go to the daily digest through
// owner-alert-router, one condition per failing workflow.
//
// parseCronWarnings turns the step's WARNINGS text into router conditions.
// Line shapes come from check-cron-health.yml's check step:
//   "⚠️ <name>: Latest run failed (last success 5h ago)"
//   "⚠️ Run-history query FAILED for: a, b — health UNKNOWN ..."

const FAILED_PREFIX = 'cron-health-failed:';
const QUERY_FAILED_KEY = 'cron-health:query-failed';

// BRO-7541: a backup whose latest run failed is not "a cron warning". R2 Cold Backup failed
// for 7 days and only reached the digest (severity warning), and Replay Push Rescue sat as a
// P3 backlog card. A backup that quietly stops is how you discover it at restore time, so a
// failed run of any of these files a tracked card (severity error, disposition auto).
// Names must match the `name` field of the CRITICAL_CRONS entries in check-cron-health.yml;
// tests/unit/cron-health-backup-escalation.test.mjs fails if a backup workflow is missing here.
const BACKUP_CRON_NAMES = ['R2 Cold Backup', 'Supabase Backup to R2', 'Backup Restore Drill'];
const BACKUP_FAILED_PREFIX = 'cron-health-backup-failed:';

function parseCronWarnings(text) {
  const out = [];
  const seen = new Set();
  for (const raw of String(text || '').split('\n')) {
    const line = raw.replace(/^\s*⚠️\s*/u, '').trim();
    if (!line) continue;
    let conditionKey;
    let title;
    if (/^Run-history query FAILED/i.test(line)) {
      conditionKey = QUERY_FAILED_KEY;
      title = 'Cron health unknown: run-history query failed';
    } else {
      const m = line.match(/^(.+?): Latest run failed/);
      if (!m) continue;
      conditionKey = `${FAILED_PREFIX}${m[1].trim()}`;
      title = `Cron's latest run failed (not yet stale): ${m[1].trim()}`;
    }
    if (seen.has(conditionKey)) continue;
    seen.add(conditionKey);
    out.push({ conditionKey, title, description: line });
  }
  return out;
}

function backupFailureEscalations(warningsText, names = BACKUP_CRON_NAMES) {
  const wanted = new Set(names);
  const out = [];
  const seen = new Set();
  const push = (name, description) => {
    if (!wanted.has(name) || seen.has(name)) return;
    seen.add(name);
    out.push({ conditionKey: `${BACKUP_FAILED_PREFIX}${name}`, name, title: `Backup failed: ${name}`, description });
  };
  for (const c of parseCronWarnings(warningsText)) {
    if (c.conditionKey.startsWith(FAILED_PREFIX)) push(c.conditionKey.slice(FAILED_PREFIX.length), c.description);
  }
  // Stale backups use a distinct line so the digest does not call them "not yet stale".
  for (const raw of String(warningsText || '').split('\n')) {
    const line = raw.replace(/^\s*⚠️\s*/u, '').trim();
    const m = line.match(/^(.+?): Stale backup, latest run /);
    if (m) push(m[1].trim(), line);
  }
  return out;
}

// Open cron-health-failed:* (and query-failed) conditions this run no longer
// warns about. The caller passes them to resolveQuietConditions, which only
// resolves keys quiet for the router's incident gap, so a flapping workflow is
// not reset daily.
function recoveredFailureKeys(ledgerConditions, currentKeys) {
  const current = new Set(currentKeys || []);
  return Object.entries(ledgerConditions || {})
    .filter(([key, c]) => (key.startsWith(FAILED_PREFIX) || key.startsWith(BACKUP_FAILED_PREFIX) || key === QUERY_FAILED_KEY) && c && c.status === 'open' && !current.has(key))
    .map(([key]) => key);
}

module.exports = { parseCronWarnings, recoveredFailureKeys, backupFailureEscalations, BACKUP_CRON_NAMES, FAILED_PREFIX, BACKUP_FAILED_PREFIX, QUERY_FAILED_KEY };
