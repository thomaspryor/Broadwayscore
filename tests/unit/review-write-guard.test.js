const fs = require('fs');
const path = require('path');
const os = require('os');
const { safeWriteReview, checkForDataLoss } = require('../../scripts/lib/review-write-guard');

describe('review-write-guard', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'review-guard-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('safeWriteReview', () => {
    test('writes new file without issues', () => {
      const filePath = path.join(tmpDir, 'test-review.json');
      const data = { showId: 'test-show', outlet: 'NYT', criticName: 'Critic' };
      const result = safeWriteReview(filePath, data);
      expect(result.wrote).toBe(true);
      expect(result.preserved).toEqual([]);
      expect(JSON.parse(fs.readFileSync(filePath, 'utf8'))).toEqual(data);
    });

    test('preserves assignedScore when new data lacks it', () => {
      const filePath = path.join(tmpDir, 'scored-review.json');
      // Write existing scored file
      fs.writeFileSync(filePath, JSON.stringify({
        showId: 'test-show',
        outlet: 'NYT',
        assignedScore: 85,
        llmScore: { score: 85, confidence: 'high' },
        fullText: 'This is a great show...',
      }, null, 2));

      // Try to overwrite with stub data
      const stub = { showId: 'test-show', outlet: 'NYT', url: 'https://example.com' };
      const result = safeWriteReview(filePath, stub);

      expect(result.preserved).toContain('assignedScore');
      expect(result.preserved).toContain('llmScore');
      expect(result.preserved).toContain('fullText');

      const written = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      expect(written.assignedScore).toBe(85);
      expect(written.llmScore.score).toBe(85);
      expect(written.fullText).toBe('This is a great show...');
      expect(written.url).toBe('https://example.com'); // new field added
    });

    test('preserves wrongProduction flag', () => {
      const filePath = path.join(tmpDir, 'wrong-prod.json');
      fs.writeFileSync(filePath, JSON.stringify({
        showId: 'test-show',
        wrongProduction: true,
        wrongProductionNote: 'Same URL in other show',
        incompleteReason: 'wrong_content',
      }, null, 2));

      const newData = { showId: 'test-show', outlet: 'NYT' };
      safeWriteReview(filePath, newData);

      const written = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      expect(written.wrongProduction).toBe(true);
      expect(written.wrongProductionNote).toBe('Same URL in other show');
      expect(written.incompleteReason).toBe('wrong_content');
    });

    test('allows overwrite with force=true', () => {
      const filePath = path.join(tmpDir, 'force-overwrite.json');
      fs.writeFileSync(filePath, JSON.stringify({
        showId: 'test-show',
        assignedScore: 85,
        fullText: 'Old text',
      }, null, 2));

      const newData = { showId: 'test-show', assignedScore: 72 };
      const result = safeWriteReview(filePath, newData, { force: true });

      expect(result.preserved).toEqual([]);
      const written = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      expect(written.assignedScore).toBe(72);
      expect(written.fullText).toBeUndefined();
    });

    test('merge mode preserves all existing fields', () => {
      const filePath = path.join(tmpDir, 'merge.json');
      fs.writeFileSync(filePath, JSON.stringify({
        showId: 'test-show',
        outlet: 'NYT',
        customField: 'preserved',
        publishDate: '2026-03-01',
      }, null, 2));

      const newData = { showId: 'test-show', url: 'https://new-url.com' };
      safeWriteReview(filePath, newData);

      const written = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      expect(written.customField).toBe('preserved');
      expect(written.publishDate).toBe('2026-03-01');
      expect(written.url).toBe('https://new-url.com');
    });
  });

  describe('checkForDataLoss', () => {
    test('returns empty for new file', () => {
      const losses = checkForDataLoss('/nonexistent/file.json', { showId: 'test' });
      expect(losses).toEqual([]);
    });

    test('detects score loss', () => {
      const filePath = path.join(tmpDir, 'check.json');
      fs.writeFileSync(filePath, JSON.stringify({
        assignedScore: 85,
        llmScore: { score: 85 },
        ensembleData: { votes: [85, 82, 88] },
      }, null, 2));

      const losses = checkForDataLoss(filePath, { showId: 'test' });
      expect(losses).toContain('assignedScore');
      expect(losses).toContain('llmScore');
      expect(losses).toContain('ensembleData');
    });

    test('no loss when new data has same fields', () => {
      const filePath = path.join(tmpDir, 'no-loss.json');
      fs.writeFileSync(filePath, JSON.stringify({
        assignedScore: 85,
        fullText: 'text',
      }, null, 2));

      const losses = checkForDataLoss(filePath, { assignedScore: 72, fullText: 'new text' });
      expect(losses).toEqual([]);
    });
  });
});
