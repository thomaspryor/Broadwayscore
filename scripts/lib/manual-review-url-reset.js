const fs = require('fs');
const { urlCanonicallyChanged, updateFileUrlWithInvariant } = require('./url-change-invariant');

function resetManualReviewUrl(filepath, url) {
  const previous = JSON.parse(fs.readFileSync(filepath, 'utf8'));
  if (!urlCanonicallyChanged(previous.url, url)) return;
  // Keep manual URL locks and sibling/domain guards intact.
  if (previous._locked || previous.urlVerified || previous.urlManualOverride) {
    throw new Error(`Refusing to repoint locked review: ${filepath}`);
  }
  const resetFields = ['excludeFromScoring', 'rejectedAt', 'needsRefetch'];
  const metadata = Object.fromEntries(resetFields.map(key => [key, null]));
  // This writes only the reset. Incoming fields are merged by the caller afterward,
  // so even text identical to the old article cannot be mistaken for stale text.
  const reset = updateFileUrlWithInvariant(filepath, url, metadata);
  if (!reset) throw new Error(`Refusing manual review URL reset: ${filepath}`);
  for (const key of resetFields) reset[key] = null;
  reset._urlChangedClear = reset._urlChangedClear || {
    from: previous.url, to: url, at: new Date().toISOString(), cleared: [],
  };
  reset._urlChangedClear.cleared = [...new Set([...reset._urlChangedClear.cleared, ...resetFields])];
  const temporary = `${filepath}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(reset, null, 2) + '\n');
  fs.renameSync(temporary, filepath);
}

function writeManualReview({ preExisting, url, incomingBody, dryRun, write }) {
  const filepath = preExisting && preExisting.path;
  const snapshot = !dryRun && filepath ? fs.readFileSync(filepath, 'utf8') : null;
  try {
    if (!dryRun && filepath && url) resetManualReviewUrl(filepath, url);
    const result = write();
    if (!dryRun && result.action === 'skipped') throw new Error(`Manual ingest refused: ${result.reason}`);
    if (!dryRun && incomingBody) {
      if (!result.filepath) throw new Error('Incoming body supplied but no review file was written');
      assertIncomingBodyWritten(incomingBody, JSON.parse(fs.readFileSync(result.filepath, 'utf8')));
    }
    return result;
  } catch (error) {
    // A refused merge must not leave the old article reset and empty.
    if (snapshot !== null) {
      fs.writeFileSync(`${filepath}.tmp`, snapshot);
      fs.renameSync(`${filepath}.tmp`, filepath);
    }
    throw error;
  }
}

function assertIncomingBodyWritten(incomingBody, written) {
  if (incomingBody && !(typeof written.fullText === 'string' && written.fullText.length > 0)) {
    throw new Error('Ingest supplied an incoming body but the written review has empty fullText');
  }
}

module.exports = { resetManualReviewUrl, assertIncomingBodyWritten, writeManualReview };
