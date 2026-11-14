// BRO-5732: a Form D total offering amount is the MOST an LLC may raise. Real
// functions only (CLAUDE.md rule 15).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { formDXmlUrls, classifyFormDCapitalization } = require('../../scripts/lib/form-d-capitalization-audit.js');
const { applyFigureEvidence } = require('../../scripts/lib/commercial-apply-gate.js');

const filing = { totalOfferingAmount: 6500000, amountSold: 5976500, capitalizedAmount: 5976500 };

test('flags a capitalization that equals the Form D maximum when less was sold', () => {
  const v = classifyFormDCapitalization({ capitalization: 6500000, capitalizationSource: 'SEC Form D filing (Grover\'s Corners Broadway LLC)' }, [filing]);
  assert.equal(v.status, 'maximum-as-fact');
  assert.equal(v.raised, 5976500);
});

test('ok when the figure is the amount sold, tagged maximum, or sourced from the press', () => {
  assert.equal(classifyFormDCapitalization({ capitalization: 5976500 }, [filing]).status, 'ok');
  assert.equal(classifyFormDCapitalization({ capitalization: 6500000, capitalizationBasis: 'maximum' }, [filing]).status, 'ok');
  assert.equal(classifyFormDCapitalization({ capitalization: 6500000, capitalizationSource: 'Form D maximum $6.5M' }, [filing]).status, 'ok');
  assert.equal(classifyFormDCapitalization({ capitalization: 6500000, capitalizationSource: 'Broadway News: "$6.5 million capitalization" https://www.broadwaynews.com/x' }, [filing]).status, 'ok');
  // Nothing sold below the maximum: nothing to flag.
  assert.equal(classifyFormDCapitalization({ capitalization: 6500000 }, [{ totalOfferingAmount: 6500000, amountSold: 6500000, capitalizedAmount: null }]).status, 'ok');
});

test('formDXmlUrls maps the rendered xsl path to the raw XML and ignores other hosts', () => {
  const urls = formDXmlUrls({
    sources: [
      { url: 'https://www.sec.gov/Archives/edgar/data/1705879/000170587917000001/xslFormDX01/primary_doc.xml' },
      { url: 'https://www.broadwaynews.com/x' },
      { url: 'https://www.sec.gov/Archives/edgar/data/1734354/000173435418000001/0001734354-18-000001-index.htm' },
    ],
  });
  assert.deepEqual(urls, ['https://www.sec.gov/Archives/edgar/data/1705879/000170587917000001/primary_doc.xml']);
});

test('apply gate: a verified bare Form D figure defaults to the maximum basis, a sold quote keeps sold', () => {
  const src = { type: 'sec', url: 'https://www.sec.gov/Archives/edgar/data/1/2/primary_doc.xml' };
  const bare = applyFigureEvidence({}, { capitalization: 6500000 }, { capitalization: { found: true, quote: 'Form D: $6,500,000', source: src } });
  assert.equal(bare.capitalizationBasis, 'maximum');
  const sold = applyFigureEvidence({}, { capitalization: 5976500 }, { capitalization: { found: true, quote: 'Offering capitalized at $5,976,500', source: src } });
  assert.equal(sold.capitalizationBasis, 'sold');
  const press = applyFigureEvidence({}, { capitalization: 8750000 }, { capitalization: { found: true, quote: 'recouped its $8.75 million capitalization', source: { type: 'trade', url: 'https://www.broadwaynews.com/x' } } });
  assert.equal(press.capitalizationBasis, undefined);
});

test('audit: a press figure written as `host: "quote"` is attributed to the press, not the filing', () => {
  const v = classifyFormDCapitalization({ capitalization: 6500000, capitalizationSource: 'broadwaynews.com: "recouped its $6.5 million capitalization"' }, [filing]);
  assert.equal(v.status, 'ok');
  assert.equal(classifyFormDCapitalization({ capitalization: 6500000, capitalizationSource: 'sec.gov: "Form D $6,500,000"' }, [filing]).status, 'maximum-as-fact');
});

test('apply gate: only EDGAR archive documents default to the maximum basis', () => {
  const other = applyFigureEvidence({}, { capitalization: 6500000 }, { capitalization: { found: true, quote: 'raised $6,500,000', source: { type: 'sec', url: 'https://www.sec.gov/news/press-release/2026-1' } } });
  assert.equal(other.capitalizationBasis, undefined);
});
